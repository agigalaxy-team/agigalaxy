import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, isAbsolute, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchPublicJson, fetchBindingJson, postConnectionJson, postA2aJson } from '../../src/public-fetch.mjs';

// Real TLS sockets and HTTP streams. Only address routing and per-request CA
// are test-specific; production validation and default TLS verification stay on.
async function fixture(t, handler) {
  const binary = process.env.GALAXY_TEST_OPENSSL_BIN;
  assert.ok(binary && isAbsolute(binary), 'Set GALAXY_TEST_OPENSSL_BIN to an absolute OpenSSL executable.');
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-tls-'));
  const keyPath = join(directory, 'test-key.pem'), certPath = join(directory, 'test-cert.pem');
  let server = null;
  const sockets = new Set();
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    const child = relative(tmpdir(), directory);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(directory, { recursive: true, force: true });
  });
  try {
    execFileSync(binary, ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-sha256', '-days', '2',
      '-subj', '/CN=official.example.org', '-addext', 'subjectAltName=DNS:official.example.org',
      '-keyout', keyPath, '-out', certPath], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
  } catch { throw new Error('TLS fixture certificate generation failed.'); }
  const key = await readFile(keyPath), cert = await readFile(certPath);
  const requests = [], nativeErrors = [], dispatched = [];
  server = https.createServer({ key, cert }, (request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, a2aVersion: request.headers['a2a-version'] });
    handler(request, response);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = https.request;
  let trust = true, trustedCertificate = cert, dnsAnswers = [{ address: '8.8.8.8', family: 4 }];
  t.mock.method(dns, 'lookup', async () => dnsAnswers);
  t.mock.method(https, 'request', (url, options, callback) => {
    assert.notEqual(options.rejectUnauthorized, false);
    assert.equal(options.checkServerIdentity, undefined);
    options.lookup(url.hostname, {}, (error, address) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); });
    const local = new URL(url); local.port = String(server.address().port);
    const request = original(local, { ...options, agent: false, ...(trust ? { ca: trustedCertificate } : {}),
      lookup: (_host, flags, done) => flags.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4) }, response => {
      assert.equal(response.socket.authorized, true);
      callback(response);
    });
    request.on('error', error => nativeErrors.push(error.code)); dispatched.push(request); return request;
  });
  syncBuiltinESMExports();
  return { requests, dispatched, nativeErrors, setTrust(value) { trust = value; }, setDns(value) { dnsAnswers = value; },
    async rotateCertificate() {
      const nextKey = join(directory, 'next-key.pem'), nextCert = join(directory, 'next-cert.pem');
      execFileSync(binary, ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-sha256', '-days', '2',
        '-subj', '/CN=official.example.org', '-addext', 'subjectAltName=DNS:official.example.org',
        '-keyout', nextKey, '-out', nextCert], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
      const replacement = await readFile(nextCert);
      server.setSecureContext({ key: await readFile(nextKey), cert: replacement });
      return () => { trustedCertificate = replacement; };
    } };
}
const endpoint = 'https://official.example.org';
const binding = '/v1/bindings/12345678-1234-4234-8234-123456789abc';
const credential = Buffer.alloc(32, 7).toString('base64url');

test('real TLS carries anonymous discovery, explicit authenticated GET and handshake POST', async t => {
  const f = await fixture(t, (request, response) => {
    response.writeHead(request.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
    response.end('{"ok":true}');
  });
  assert.deepEqual(await fetchPublicJson(endpoint + '/public', { credential }), { ok: true });
  await fetchBindingJson(endpoint + binding, { credential });
  await postConnectionJson(endpoint + '/v1/binding-challenges', { bodyJson: '{}' });
  assert.deepEqual(f.requests.map(r => [r.method, r.authorization]),
    [['GET', undefined], ['GET', `Bearer ${credential}`], ['POST', undefined]]);
  f.setDns([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  await assert.rejects(fetchPublicJson(endpoint + '/public'));
  assert.equal(f.dispatched.length, 3);
});

test('untrusted certificate and wrong hostname fail before HTTP payload reaches the server', async t => {
  const f = await fixture(t, (_request, response) => response.end('{}'));
  f.setTrust(false);
  await assert.rejects(fetchBindingJson(endpoint + binding, { credential }));
  f.setTrust(true);
  await assert.rejects(fetchBindingJson('https://wrong.example.org' + binding, { credential }));
  assert.deepEqual(f.nativeErrors, ['DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID']);
  assert.equal(f.requests.length, 0); assert.equal(f.dispatched.length, 2);
});

test('new TLS handshakes verify the replacement certificate after explicit per-client trust update', async t => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });response.end('{"ok":true}');
  });
  assert.deepEqual(await fetchPublicJson(endpoint + '/public'), { ok: true });
  const adopt = await f.rotateCertificate();
  await assert.rejects(fetchPublicJson(endpoint + '/public'));
  assert.equal(f.requests.length, 1);
  adopt();assert.deepEqual(await fetchPublicJson(endpoint + '/public'), { ok: true });
  assert.equal(f.requests.length, 2);
});

test('A2A HTTPS uses fixed wire version and explicit external credential without redirect/replay', async t => {
  let redirect = false;
  const f = await fixture(t, (_request, response) => {
    response.writeHead(redirect ? 302 : 200, redirect ? { Location: 'https://other.example.org/a2a' } : { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  await postA2aJson(endpoint + '/a2a', { bodyJson: '{}', credential: 'external.fixture-token' });
  assert.equal(f.requests[0].a2aVersion, '1.0');
  assert.equal(f.requests[0].authorization, 'Bearer external.fixture-token');
  await postA2aJson(endpoint + '/a2a', { bodyJson: '{}' });
  assert.equal(f.requests[1].authorization, undefined);
  await assert.rejects(postA2aJson(endpoint + '/a2a', { bodyJson: '{}', credential: 'bad\r\nheader' }));
  redirect = true;
  await assert.rejects(postA2aJson(endpoint + '/a2a', { bodyJson: '{}', credential: 'external.fixture-token' }));
  assert.equal(f.requests.length, 3);
});

test('real HTTPS redirects, oversized streams, timeout and cancellation fail without replay', async t => {
  let mode = 'redirect', arrived;
  const f = await fixture(t, (_request, response) => {
    if (mode === 'redirect') { response.writeHead(302, { Location: endpoint + '/other' }); response.end(); }
    else if (mode === 'large') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('x'.repeat(100)); }
    else { arrived?.(); }
  });
  await assert.rejects(fetchPublicJson(endpoint + '/public'));
  mode = 'large'; await assert.rejects(fetchPublicJson(endpoint + '/public', { maxBytes: 16 }));
  mode = 'timeout'; await assert.rejects(fetchPublicJson(endpoint + '/public', { timeoutMs: 300 }));
  mode = 'cancel'; const controller = new AbortController();
  const ready = new Promise(resolve => { arrived = resolve; });
  const pending = assert.rejects(fetchPublicJson(endpoint + '/public', { signal: controller.signal }));
  await ready; controller.abort(); await pending;
  assert.equal(f.dispatched.length, 4);
  assert.ok(f.dispatched.every(request => request.destroyed));
});
