import test from 'node:test';
import assert from 'node:assert/strict';
import { officialProxyCandidate } from '../caddy-candidate.mjs';

const options = { serverName: 'website', endpoint: 'https://official.example.org', apiPort: 3201 };
const base = () => ({ admin: { disabled: true }, apps: { tls: { automation: { policies: [{ issuers: [{ module: 'acme' }] }] } },
  http: { servers: { website: { listen: [':443'], routes: [
    { match: [{ host: ['example.org'] }], handle: [{ handler: 'file_server', root: '/srv/example/current' }] },
    { match: [{ host: ['www.example.org'] }], handle: [{ handler: 'static_response', status_code: 301, headers: { Location: ['https://example.org{http.request.uri}'] } }] },
  ], logs: { default_logger_name: 'website' } }, other: { listen: ['127.0.0.1:8081'], routes: [] } } } } });

test('Official candidate preserves the full existing website, TLS, logging and admin configuration', () => {
  const current = base(), before = structuredClone(current), candidate = officialProxyCandidate(current, options);
  assert.deepEqual(current, before);
  const added = candidate.apps.http.servers.website.routes.splice(0, 2);
  assert.deepEqual(candidate, before, 'only the two Official routes may be added');
  assert.equal(added[0].handle[0].upstreams[0].dial, '127.0.0.1:3201');
  assert.ok(added.every(route => route.match.every(match => match.host.length === 1 && match.host[0] === 'official.example.org')));
  assert.equal(added[1].handle[0].status_code, 404);
});

test('Existing exact/wildcard host ownership and disabled certificate automation need an explicit configuration decision', () => {
  for (const host of ['official.example.org', '*.example.org']) {
    const current = base();current.apps.http.servers.other.routes.push({ match: [{ host: [host] }] });
    assert.throws(() => officialProxyCandidate(current, options), /already owned/);
  }
  const current = base();current.apps.http.servers.website.automatic_https = { disable: true };
  assert.throws(() => officialProxyCandidate(current, options), /HTTPS server/);
});
