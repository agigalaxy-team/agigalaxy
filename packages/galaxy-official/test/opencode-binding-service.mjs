// Explicit loopback-only synthetic fixture, never included in service releases.
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';

const output = resolve(process.argv[2]);
const endpoint = process.argv[3] ?? 'https://binding.galaxy.invalid';
if (!/^https:\/\/[a-z-]+\.galaxy\.invalid$/.test(endpoint)) throw new Error('Synthetic logical endpoint required');
const scopes = process.argv[4] === 'binding,history' ? ['binding', 'history'] : ['binding'];
const fixture = await serviceFixture(scopes, null, { now: Math.floor(Date.now() / 1000), endpoint });
// This explicitly synthetic process owns the fixture-only administrative route.
fixture.bindings.authorizeAdministrativeRevoke = () => true;
const api = createApi({ ...fixture, rateLimit: 256 });
const requests = [];
let closed = false, manifestMode = 'valid';
async function state() {
  const bindings = (await fixture.db.query('SELECT id, subject_id, revoked_at FROM bindings WHERE subject_id <> $1', [fixture.actor.subjectId])).rows;
  const counts = {};
  for (const name of ['cases', 'case_events', 'consents', 'proofs', 'context_grants'])
    counts[name] = Number((await fixture.db.query(`SELECT count(*) AS count FROM ${name}`)).rows[0].count);
  return { bindings, counts, requests: [...requests], manifestMode };
}
function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
}
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  try {
    if (path === '/fixture/meta') return json(response, { endpoint: fixture.bindings.endpoint, now: fixture.now,
      trustedKeys: [...fixture.bindings.trustedKeys] });
    if (path === '/fixture/state') return json(response, await state());
    if (path === '/fixture/revoke') {
      const rows = (await state()).bindings; if (rows.length !== 1) throw new Error('Expected one synthetic binding');
      return json(response, await fixture.bindings.revoke(rows[0].id, rows[0].subject_id, randomUUID()));
    }
    if (path === '/fixture/bad-manifest') { manifestMode = 'bad'; return json(response, { mode: manifestMode }); }
    if (path === '/fixture/valid-manifest') { manifestMode = 'valid'; return json(response, { mode: manifestMode }); }
    if (path === '/fixture/stop') {
      if (closed) return json(response, { stopped: true });
      closed = true; await writeFile(join(output, 'service-result.json'), JSON.stringify(await state(), null, 2) + '\n');
      json(response, { stopped: true });
      setImmediate(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); await fixture.db.close(); });
      return;
    }
    const row = { path, method: request.method, authorizationPresent: Boolean(request.headers.authorization) };
    requests.push(row); response.once('finish', () => { row.status = response.statusCode; });
    if (path === '/.well-known/galaxy-network.json' && manifestMode === 'bad') {
      const document = structuredClone((await fixture.manifest.get()).document);
      const parts = document.signed.split('.'); parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
      document.signed = parts.join('.'); return json(response, document);
    }
    api.emit('request', request, response);
  } catch (error) { json(response, { error: error.name }, 500); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
await writeFile(join(output, 'service-ready.json'), JSON.stringify({ address: `http://127.0.0.1:${server.address().port}`, pid: process.pid }) + '\n');
console.log('Synthetic loopback binding service ready.');
