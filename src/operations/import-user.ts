import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, realpath, stat, chmod } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { canonical, checksum, type Block, type Manifest } from '../multiuser/import-contracts.js';
import { buildPackage, packageFiles, StrictVotes, verifyPackage, type Capture } from './import-package.js';

const exec = promisify(execFile);
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
export async function privatePath(path: string, exists = true) {
  const root = await realpath('.local');
  const target = exists ? await realpath(path) : resolve(await realpath(resolve(path, '..')), path.split('/').at(-1)!);
  const rel = relative(root, target);
  if (rel.startsWith('..') || rel === '' || resolve(root, rel) !== target) throw new Error('Package must remain under .local');
  return target;
}
async function gitFile(sha: string, path: string) {
  return (await exec('git', ['show', `${Sha.parse(sha)}:${path}`], { maxBuffer: 16 * 1024 * 1024 })).stdout;
}
export function origin(input: string) {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Invalid Worker origin');
  return url.origin;
}
export function importClient(base: string, secret: string, fetcher: typeof fetch = fetch) {
  const url = origin(base);
  if (secret.length < 32) throw new Error('Import credential required');
  return async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<unknown> => {
    const response = await fetcher(`${url}/internal/v1/imports${path}`, { method,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok || response.headers.get('cache-control') !== 'no-store') throw new Error(`Import request failed (${response.status})`);
    return response.json();
  };
}
/** Strict KV export: fails closed on any invalid or vanished record instead of dropping it. */
export async function fetchStrictVotes(base: string, secret: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`${origin(base)}/votes?strict=1`, { headers: { authorization: `Bearer ${secret}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || response.headers.get('cache-control') !== 'no-store') throw new Error('Strict vote capture failed');
  return StrictVotes.parse(await response.json());
}
const Status = z.object({ status: z.enum(['open', 'finalized']), manifest_hash: z.string(), blocks: z.array(z.object({ blockIndex: z.number(), checksum: z.string() })) });
export async function applyPackage(manifest: Manifest, blocks: Block[], request: ReturnType<typeof importClient>) {
  const owner = crypto.randomUUID();
  await request('/lease', { owner });
  try {
    const state = Status.parse(await request('', { owner, manifest }));
    if (state.manifest_hash !== await checksum(manifest)) throw new Error('Manifest conflict');
    if (state.status === 'finalized') return await request(`/${manifest.id}/verify`);
    for (const block of blocks) {
      const previous = state.blocks.find(b => b.blockIndex === block.index);
      if (previous) { if (previous.checksum !== block.checksum) throw new Error('Block conflict'); continue; }
      await request('/lease/renew', { owner });
      try { await request(`/${manifest.id}/blocks`, { owner, block }); }
      catch {
        // Unknown HTTP outcome: inspect the atomic checkpoint before a single retry.
        const current = Status.parse(await request(`/${manifest.id}`));
        const committed = current.blocks.find(b => b.blockIndex === block.index);
        if (committed) { if (committed.checksum !== block.checksum) throw new Error('Block conflict'); }
        else { await request('/lease/renew', { owner }); await request(`/${manifest.id}/blocks`, { owner, block }); }
      }
    }
    await request('/lease/renew', { owner });
    await request(`/${manifest.id}/verify`);
    return await request(`/${manifest.id}/finalize`, { owner });
  } finally { await request('/lease', { owner }, 'DELETE'); }
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    package: { type: 'string' }, identity: { type: 'string' }, 'state-sha': { type: 'string' }, 'code-sha': { type: 'string' },
    config: { type: 'string' }, origin: { type: 'string' },
  } });
  const command = z.enum(['prepare', 'apply', 'status', 'verify']).parse(positionals[0]);
  if (!values.package) throw new Error('Package path required');
  await mkdir('.local/imports', { recursive: true, mode: 0o700 });
  if (command === 'prepare') {
    if (!values.identity || !values.config || !values['state-sha'] || !values['code-sha'] || !values.origin) throw new Error('Capture arguments required');
    const dir = await privatePath(values.package, false);
    await mkdir(dir, { mode: 0o700 }); // no overwriting a reviewed capture
    const stateSha = Sha.parse(values['state-sha']), codeSha = Sha.parse(values['code-sha']);
    const identityPath = await privatePath(values.identity);
    const configPath = await privatePath(values.config);
    const capture = {} as Capture;
    capture.identity = await readFile(identityPath, 'utf8');
    capture.ledger = await gitFile(stateSha, 'state.json');
    capture.profile = await gitFile(codeSha, 'profile.yaml');
    capture.config = await gitFile(codeSha, 'src/config.ts');
    capture.votes = json(await fetchStrictVotes(values.origin, z.string().min(16).parse(process.env.VOTES_READ_SECRET)));
    // Read-only export. Provider output is captured, never printed; backup stays private.
    const backupPath = resolve(dir, packageFiles.backup);
    await exec('pnpm', ['exec', 'wrangler', 'd1', 'export', 'DB', '--remote', '--config', configPath, '--output', backupPath],
      { maxBuffer: 8 * 1024 * 1024, timeout: 180_000, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: resolve(dir, 'wrangler.log') } });
    await chmod(backupPath, 0o600);
    capture.backup = await readFile(backupPath, 'utf8');
    if (!capture.backup.trim() || (await stat(backupPath)).size === 0) throw new Error('Empty backup');
    const result = await buildPackage(capture, { id: crypto.randomUUID(), capturedAt: new Date().toISOString(), stateSha, codeSha });
    for (const [key, file] of Object.entries(packageFiles)) await writeFile(resolve(dir, file), capture[key as keyof Capture], { mode: 0o600 });
    await writeFile(resolve(dir, 'manifest.json'), json(result.manifest), { mode: 0o600 });
    await writeFile(resolve(dir, 'blocks.json'), json(result.blocks), { mode: 0o600 });
    console.log(json({ prepared: true, counts: result.manifest.counts, manifestHash: await checksum(result.manifest) }));
    return;
  }
  const dir = await privatePath(values.package);
  const capture = {} as Capture;
  for (const [key, file] of Object.entries(packageFiles)) capture[key as keyof Capture] = await readFile(await privatePath(resolve(dir, file)), 'utf8');
  const { manifest, blocks } = await verifyPackage(capture, JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8')), JSON.parse(await readFile(resolve(dir, 'blocks.json'), 'utf8')));
  if (!values.origin) throw new Error('Worker origin required');
  const request = importClient(values.origin, process.env.IMPORT_SERVICE_SECRET ?? '');
  const result = command === 'apply' ? await applyPackage(manifest, blocks, request)
    : await request(`/${manifest.id}${command === 'verify' ? '/verify' : ''}`);
  const evidence = { at: new Date().toISOString(), command, manifestHash: await checksum(manifest), result };
  await writeFile(resolve(dir, `${command}-${Date.now()}.json`), json(evidence), { mode: 0o600 });
  if (command === 'verify' && process.env.VOTES_READ_SECRET) {
    const later = await fetchStrictVotes(values.origin, process.env.VOTES_READ_SECRET);
    await writeFile(resolve(dir, `later-votes-${Date.now()}.json`), json({ captured: JSON.parse(capture.votes), later, changed: canonical(later) !== canonical(JSON.parse(capture.votes)), synchronized: false }), { mode: 0o600 });
  }
  console.log(json({ completed: command, manifestHash: await checksum(manifest) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error(JSON.stringify({ error: 'import_failed', recovery: 'retain_package_and_checkpoints' })); process.exitCode = 1; });
}
