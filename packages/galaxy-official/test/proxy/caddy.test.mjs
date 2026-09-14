import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer as httpServer } from 'node:http';
import { officialRoutes } from '../../deploy/caddy-routes.mjs';
import { createApi } from '../../src/http.mjs';

test('real Caddy: client quota isolation, spoof rejection and independent probes', { timeout: 20000 }, async () => {
  assert.ok(process.env.GALAXY_TEST_CADDY_BIN, 'Set GALAXY_TEST_CADDY_BIN to a verified local Caddy executable');
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-caddy-test-'));
  assert.ok(resolve(directory).startsWith(join(resolve(tmpdir()), 'galaxy-caddy-test-')));
  const api = createApi({ bindings: { endpoint: 'https://galaxy.example' }, keyring: { fixture: true },
    rateLimit: 1, trustedProxyAddresses: ['127.0.0.1'] });
  let proxy;
  let closed;
  try {
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const config = join(directory, 'caddy.json');
    await writeFile(config, JSON.stringify({ admin: { disabled: true }, apps: { http: { servers: { fixture: {
      listen: [`127.0.0.1:${port}`], routes: [{ handle: [{ handler: 'reverse_proxy',
        upstreams: [{ dial: `127.0.0.1:${api.address().port}` }] }] }],
    } } } } }));
    proxy = spawn(process.env.GALAXY_TEST_CADDY_BIN, ['run', '--config', config], { cwd: directory,
      env: { ...process.env, XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory },
      windowsHide: true, stdio: 'ignore' });
    closed = new Promise((resolve, reject) => { proxy.once('close', resolve); proxy.once('error', reject); });
    // Observe early spawn errors while retaining the close handle for cleanup.
    closed.catch(() => {});
    const send = (localAddress, path, headers = {}) => new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, localAddress, path, headers, agent: false }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode));
      });
      req.setTimeout(1500, () => req.destroy(new Error('request timeout')));
      req.once('error', reject); req.end();
    });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (proxy.exitCode !== null) throw new Error('Caddy exited before readiness');
      try { ready = await send('127.0.0.1', '/healthz') === 200; } catch { /* startup only */ }
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, 'Caddy readiness deadline');
    const path = '/.well-known/galaxy-signing-keys.json';
    assert.equal(await send('127.0.0.1', path, { 'X-Forwarded-For': '192.0.2.1' }), 200);
    assert.equal(await send('127.0.0.1', path, { 'X-Forwarded-For': '192.0.2.2' }), 429);
    assert.equal(await send('127.0.0.2', path), 200, 'second real client address has its own quota');
    assert.equal(await send('127.0.0.2', path, { 'X-Forwarded-For': '192.0.2.3' }), 429);
    assert.equal(await send('127.0.0.1', '/healthz'), 200);
    assert.equal(await send('127.0.0.2', '/readyz'), 200);
  } finally {
    if (proxy) {
      if (proxy.exitCode === null && proxy.signalCode === null && proxy.pid) proxy.kill();
      try { await closed; } catch (error) { if (proxy.pid) assert.ifError(error); }
    }
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
    await rm(directory, { recursive: true, force: true });
    console.log('Caddy fixture stopped and temporary configuration removed.');
  }
});


test('real Caddy: exact Official host and route allowlist exclude internal and unknown endpoints', { timeout: 20000 }, async () => {
  assert.ok(process.env.GALAXY_TEST_CADDY_BIN);
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-caddy-routes-'));
  const seen = [];
  const backend = httpServer((req, res) => { seen.push(req.url); res.end('fixture'); });
  let proxy, closed;
  try {
    backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const routes = officialRoutes({ endpoint: 'https://official.example.org', apiPort: backend.address().port });
    const config = join(directory, 'caddy.json');
    await writeFile(config, JSON.stringify({ admin: { disabled: true }, apps: { http: { servers: { fixture: {
      automatic_https: { disable: true }, listen: [`127.0.0.1:${port}`], routes: [...routes, { handle: [{ handler: 'static_response', status_code: 418 }] }],
    } } } } }));
    proxy = spawn(process.env.GALAXY_TEST_CADDY_BIN, ['run', '--config', config], { cwd: directory,
      env: { ...process.env, XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory }, windowsHide: true, stdio: 'ignore' });
    closed = new Promise((resolve, reject) => { proxy.once('close', resolve); proxy.once('error', reject); }); closed.catch(() => {});
    const send = (path, method = 'GET', host = 'official.example.org') => new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host }, agent: false }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode));
      }); req.setTimeout(1000, () => req.destroy(new Error('fixture timeout'))); req.once('error', reject); req.end();
    });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (proxy.exitCode !== null) throw new Error('Caddy fixture exited');
      try { ready = await send('/healthz') === 404; } catch { /* startup */ }
      if (ready) break; await delay(50);
    }
    assert.ok(ready);
    const id = '11111111-1111-4111-8111-111111111111';
    for (const [method, path] of [['GET', '/v1/identity/callback/enterprise?code=synthetic&state=synthetic'],
      ...['providers','begin','status','cancel','confirm','query','revoke'].map(method=>['POST','/v1/identity/'+method]),
      ['GET', '/.well-known/galaxy-network.json'], ['GET', '/v1/service-status'], ['POST', '/mcp/docs'],
      ['GET','/.well-known/oauth-protected-resource/mcp/personal'],...['GET','POST','DELETE'].map(method=>[method,'/mcp/personal']),
      ['GET', '/v1/consents?after=' + id], ['POST', '/v1/case-events'], ['GET', '/v1/proofs/' + id + '/status'],
      ['POST', '/v1/bindings/' + id + '/revoke'], ['POST', '/v1/builders/reports/export'],
      ['POST', '/v1/builders/node-control/export'],
      ...['/v1/bindings/query','/v1/assistance/events/receipt','/v1/requester-history/facts','/v1/context-grants/receipt','/v1/notifications/archive'].map(path=>['POST',path]),
      ['POST', '/v1/builders/manage/read'], ['POST', '/v1/builders/owned/query'], ['POST', '/v1/builders/events/receipt'], ['POST', '/v1/builders/notices/query'], ['POST', '/v1/search/query'],
      ['POST', '/v1/audit/query'], ['POST', '/v1/audit/export'], ['POST', '/v1/audit/grants/approve'],
      ['POST', '/v1/data-exports/create'], ['POST', '/v1/data-exports/page'], ['POST', '/v1/data-exports/binary'], ['POST', '/v1/data-exports/revoke'],
      ['POST', '/v1/deletion-requests/status'], ['POST', '/v1/deletion-requests/config'], ['POST', '/v1/deletion-requests/submit'], ['POST', '/v1/deletion-requests/read'], ['POST', '/v1/deletion-requests/query']]) assert.equal(await send(path, method), 200);
    const forwarded = seen.length;
    for (const path of ['/healthz', '/readyz', '/admin', '/metrics', '/database', '/.env', '/v1/unknown',
      '/v1/proofs/not-an-id', '/v1/bindings/' + id + '/revoke/extra']) assert.equal(await send(path), 404);
    assert.equal(await send('/v1/cases', 'DELETE'), 404);
    for(const path of ['/v1/builders/manage/read','/v1/builders/owned/query','/v1/builders/events/receipt','/v1/builders/notices/query','/v1/search/query','/v1/bindings/query','/v1/assistance/events/receipt','/v1/requester-history/facts','/v1/context-grants/receipt','/v1/notifications/archive'])assert.equal(await send(path,'GET'),404);
    assert.equal(await send('/v1/cases', 'POST', 'unrelated.example.org'), 418);
    assert.equal(seen.length, forwarded, 'denied routes never reach backend');
  } finally {
    if (proxy) { if (proxy.exitCode === null && proxy.signalCode === null) proxy.kill(); await closed.catch(() => {}); }
    backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});


test('real Caddy: validated candidate cutover and rollback preserve the prior route on rejected reload', { timeout: 20000 }, async () => {
  const binary = process.env.GALAXY_TEST_CADDY_BIN; assert.ok(binary);
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-caddy-cutover-'));
  const backends = ['previous', 'candidate'].map(name => httpServer((_req, res) => res.end(name)));
  let proxy, closed;
  try {
    for (const backend of backends) { backend.listen(0, '127.0.0.1'); await once(backend, 'listening'); }
    const reserve = async () => {
      const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
    };
    const port = await reserve(), adminPort = await reserve();
    const configuration = backend => ({ admin: { listen: `127.0.0.1:${adminPort}` }, apps: { http: { servers: { fixture: {
      automatic_https: { disable: true }, listen: [`127.0.0.1:${port}`],
      routes: officialRoutes({ endpoint: 'https://official.example.org', apiPort: backend.address().port }),
    } } } } });
    const previous = join(directory, 'previous.json'), candidate = join(directory, 'candidate.json'), rejected = join(directory, 'rejected.json');
    await writeFile(previous, JSON.stringify(configuration(backends[0])));
    await writeFile(candidate, JSON.stringify(configuration(backends[1])));
    const invalid = configuration(backends[1]); invalid.apps.http.servers.fixture.routes[0].handle[0].handler = 'fixture_missing_handler';
    await writeFile(rejected, JSON.stringify(invalid));
    const env = { ...process.env, XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory };
    const command = args => spawnSync(binary, args, { cwd: directory, env, windowsHide: true, encoding: 'utf8', timeout: 3000 });
    assert.equal(command(['validate', '--config', previous]).status, 0);
    assert.equal(command(['validate', '--config', candidate]).status, 0);
    assert.notEqual(command(['validate', '--config', rejected]).status, 0);
    proxy = spawn(binary, ['run', '--config', previous], { cwd: directory, env, windowsHide: true, stdio: 'ignore' });
    closed = new Promise((resolve, reject) => { proxy.once('close', resolve); proxy.once('error', reject); }); closed.catch(() => {});
    const read = () => new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: '/v1/policy', headers: { host: 'official.example.org' }, agent: false }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('end', () => resolve(Buffer.concat(chunks).toString()));
      }); req.setTimeout(1000, () => req.destroy(new Error('fixture timeout'))); req.once('error', reject); req.end();
    });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (proxy.exitCode !== null) throw new Error('Caddy fixture exited');
      try { ready = await read() === 'previous'; } catch { /* startup */ }
      if (ready) break; await delay(50);
    }
    assert.ok(ready);
    const reload = path => command(['reload', '--address', `127.0.0.1:${adminPort}`, '--config', path]);
    assert.notEqual(reload(rejected).status, 0);
    assert.equal(await read(), 'previous', 'rejected candidate cannot replace active route');
    assert.equal(reload(candidate).status, 0);
    assert.equal(await read(), 'candidate');
    assert.equal(reload(previous).status, 0);
    assert.equal(await read(), 'previous', 'explicit rollback restores previous backend');
  } finally {
    if (proxy) { if (proxy.exitCode === null && proxy.signalCode === null) proxy.kill(); await closed.catch(() => {}); }
    for (const backend of backends) { backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
    await rm(directory, { recursive: true, force: true });
  }
});
