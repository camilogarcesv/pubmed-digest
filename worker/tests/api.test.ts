import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import backend from '../multiuser/worker.js';
import { alice, bob, article, ledger, seedUsers } from './fixtures.js';

function request(path: string, body?: unknown, secret = env.DIGEST_SERVICE_SECRET): Request {
  return new Request(`https://local.test/internal/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
it('fails closed without configuration or with invalid auth and never reveals a secret', async () => {
  const response = await backend.fetch(request('contexts', undefined, 'incorrect'), env);
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain(env.DIGEST_SERVICE_SECRET);
  expect((await backend.fetch(request('contexts'), { DB: env.DB })).status).toBe(401);
});
it('reads local contexts/mode/seen with private cache policy and zero ledger changes', async () => {
  const repository = await seedUsers();
  await repository.importLedger(alice, [{ article: article(), entry: ledger(alice) }]);
  const contextResponse = await backend.fetch(request('contexts'), env);
  expect(contextResponse.headers.get('cache-control')).toBe('no-store');
  expect(contextResponse.headers.has('access-control-allow-origin')).toBe(false);
  const contexts = await contextResponse.text();
  expect(contexts).not.toContain('email');
  expect(contexts).not.toContain('externalId');
  expect(await (await backend.fetch(request('mode'), env)).json()).toEqual({ mode: 'legacy' });
  expect(await (await backend.fetch(request('seen/check', { pairs: [{ userId: alice, pmid: '123' }, { userId: bob, pmid: '123' }] }), env)).json()).toEqual({ seen: [true, false] });
  expect(await (await backend.fetch(request(`users/${bob}/eval-context`), env)).json()).toEqual({ votes: [] });
  expect((await env.DB.prepare('SELECT * FROM digest_runs').all()).results).toEqual([]);
  expect((await env.DB.prepare('SELECT * FROM user_articles').all()).results).toHaveLength(1);
});
it('rejects malformed JSON, extra fields, oversized bodies and unsupported routes', async () => {
  expect((await backend.fetch(request('seen/check', { pairs: [], unexpected: true }), env)).status).toBe(400);
  const bad = request('seen/check', {});
  const malformed = new Request(bad.url, { method: 'POST', headers: bad.headers, body: '{' });
  expect((await backend.fetch(malformed, env)).status).toBe(400);
  expect((await backend.fetch(request('seen/check', 'a'.repeat(256 * 1024)), env)).status).toBe(413);
  expect((await backend.fetch(request('digest-runs', {}), env)).status).toBe(404);
  expect((await backend.fetch(request('users/not-a-uuid/eval-context'), env)).status).toBe(400);
});
