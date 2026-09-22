import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ImportManifest, canonical, checksum, sha256 } from '../multiuser/import-contracts.js';
import { LedgerArticle, LedgerBlock, LedgerManifest, articleHash, buildLedgerExtension } from '../multiuser/ledger-extension.js';
import { Ledger } from './import-package.js';
import { importClient, privatePath } from './import-user.js';

const exec = promisify(execFile);
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const Snapshot = z.object({ userId: z.uuid(), records: z.array(LedgerArticle), checksum: z.string() });
const Status = z.object({ status: z.enum(['open', 'finalized']), manifestHash: z.string(), blocks: z.array(z.object({ blockIndex: z.number().int(), checksum: z.string() })) });
export function capturedArticles(raw: string) {
  const ledger = Ledger.parse(JSON.parse(raw));
  return Object.entries(ledger.papers).map(([pmid, p]) => LedgerArticle.parse({ kind: 'article', pmid, title: p.title ?? null, firstSeen: p.firstSeen, relevance: p.relevance ?? null, delivered: p.delivered }));
}
export async function verifyLedgerPackage(dir: string) {
  const manifest = LedgerManifest.parse(JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8')));
  const before = Snapshot.parse(JSON.parse(await readFile(resolve(dir, 'before.json'), 'utf8')));
  const ledger = await readFile(resolve(dir, 'ledger.json'), 'utf8'), backup = await readFile(resolve(dir, 'backup.sql'));
  if (before.userId !== manifest.userId || before.checksum !== await articleHash(before.records)) throw new Error('Invalid baseline');
  const rebuilt = await buildLedgerExtension(before.records, capturedArticles(ledger), { ...manifest,
    ledgerChecksum: await sha256(new TextEncoder().encode(ledger)), backupChecksum: await sha256(backup) });
  const blocks = z.array(LedgerBlock).parse(JSON.parse(await readFile(resolve(dir, 'blocks.json'), 'utf8')));
  if (canonical(manifest) !== canonical(rebuilt.manifest) || canonical(blocks) !== canonical(rebuilt.blocks)) throw new Error('Ledger package changed');
  return { manifest, blocks };
}
export async function verifyLedgerExtension(manifest: LedgerManifest, request: ReturnType<typeof importClient>) {
  const verified = z.object({ verified: z.literal(true), finalized: z.literal(true), extensionId: z.uuid(), manifestHash: z.string(), articles: z.number().int().nonnegative(), checksum: z.string() })
    .parse(await request(`/users/${manifest.userId}/ledger-extensions/${manifest.id}/verify`));
  if (verified.extensionId !== manifest.id || verified.manifestHash !== await checksum(manifest)) throw new Error('Verified extension identity mismatch');
  return verified;
}
export async function applyLedgerExtension(manifest: LedgerManifest, blocks: LedgerBlock[], request: ReturnType<typeof importClient>) {
  const base = `/users/${manifest.userId}/ledger-extensions`, path = `${base}/${manifest.id}`, hash = await checksum(manifest);
  const check = (input: unknown) => { const s = Status.parse(input); if (s.manifestHash !== hash) throw new Error('Extension identity changed'); return s; };
  const owner = crypto.randomUUID();
  await request('/lease', { owner });
  try {
    let status;
    try { status = check(await request(base, { owner, manifest })); }
    catch { status = check(await request(path)); } // Unknown create outcome: inspect before continuing.
    for (const block of blocks) {
      const prior = status.blocks.find(b => b.blockIndex === block.index);
      if (prior) { if (prior.checksum !== block.checksum) throw new Error('Block identity changed'); continue; }
      if (status.status === 'finalized') throw new Error('Incomplete sealed extension');
      await request('/lease/renew', { owner });
      try { await request(`${path}/blocks`, { owner, block }); }
      catch {
        status = check(await request(path));
        const saved = status.blocks.find(b => b.blockIndex === block.index);
        if (saved) { if (saved.checksum !== block.checksum) throw new Error('Block identity changed'); }
        else { await request('/lease/renew', { owner }); await request(`${path}/blocks`, { owner, block }); }
      }
    }
    await request('/lease/renew', { owner });
    try { await request(`${path}/finalize`, { owner }); }
    catch {
      status = check(await request(path));
      if (status.status !== 'finalized') throw new Error('Finalization incomplete; retain package and resume');
    }
    return await verifyLedgerExtension(manifest, request);
  } finally { await request('/lease', { owner }, 'DELETE'); }
}
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    package: { type: 'string' }, extension: { type: 'string' }, origin: { type: 'string' }, config: { type: 'string' },
    'state-sha': { type: 'string' }, 'code-sha': { type: 'string' },
  } });
  const command = z.enum(['prepare', 'apply', 'status', 'verify']).parse(positionals[0]);
  const request = importClient(z.string().parse(values.origin), process.env.IMPORT_SERVICE_SECRET ?? '');
  if (command === 'prepare') {
    const parent = await privatePath(z.string().parse(values.package));
    const identity = ImportManifest.parse(JSON.parse(await readFile(resolve(parent, 'manifest.json'), 'utf8'))).identity;
    const stateSha = z.string().regex(/^[a-f0-9]{40}$/).parse(values['state-sha']);
    const codeSha = z.string().regex(/^[a-f0-9]{40}$/).parse(values['code-sha']);
    await exec('git', ['cat-file', '-e', `${codeSha}^{commit}`]);
    const ledger = (await exec('git', ['show', `${stateSha}:state.json`], { maxBuffer: 16 * 1024 * 1024 })).stdout;
    const before = Snapshot.parse(await request(`/users/${identity.id}/ledger`));
    if (before.userId !== identity.id || before.checksum !== await articleHash(before.records)) throw new Error('Baseline mismatch');
    const capturedAt = new Date().toISOString(), dir = resolve(parent, 'ledger-extensions', capturedAt.replace(/[:.]/g, '-'));
    await mkdir(resolve(parent, 'ledger-extensions'), { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 });
    const config = await privatePath(z.string().parse(values.config));
    await exec('pnpm', ['exec', 'wrangler', 'd1', 'export', 'DB', '--remote', '--config', config, '--output', resolve(dir, 'backup.sql')], { maxBuffer: 8 * 1024 * 1024 });
    await chmod(resolve(dir, 'backup.sql'), 0o600);
    const backup = await readFile(resolve(dir, 'backup.sql'));
    const data = await buildLedgerExtension(before.records, capturedArticles(ledger), { id: crypto.randomUUID(), userId: identity.id, capturedAt, stateSha, codeSha,
      ledgerChecksum: await sha256(new TextEncoder().encode(ledger)), backupChecksum: await sha256(backup) });
    for (const [file, body] of Object.entries({ 'before.json': json(before), 'ledger.json': ledger, 'manifest.json': json(data.manifest), 'blocks.json': json(data.blocks) })) {
      await writeFile(resolve(dir, file), body, { mode: 0o600 });
    }
    await verifyLedgerPackage(dir);
    console.log(json({ prepared: dir, before: data.manifest.beforeCount, after: data.manifest.afterCount, added: data.manifest.afterCount - data.manifest.beforeCount }));
    return;
  }
  const dir = await privatePath(z.string().parse(values.extension));
  const { manifest, blocks } = await verifyLedgerPackage(dir);
  const result = command === 'apply' ? await applyLedgerExtension(manifest, blocks, request)
    : command === 'status' ? await request(`/users/${manifest.userId}/ledger-extensions/${manifest.id}`)
      : await verifyLedgerExtension(manifest, request);
  await writeFile(resolve(dir, `${command}-${Date.now()}.json`), json(result), { mode: 0o600 });
  console.log(json({ completed: command, ...(command === 'apply' ? result as object : {}) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error(JSON.stringify({ error: 'ledger_extension_failed', recovery: 'retain_package_and_check_status' })); process.exitCode = 1; });
}
