import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { fetchPublicJson, fetchBindingJson, postPublicJson, postConnectionJson } from "../src/infrastructure/public-fetch.mjs";

const options = { bodyJson: '{"signedIntent":"synthetic"}', credential: Buffer.alloc(32, 1).toString('base64url') };

// Replace only platform I/O. Exercise the real gate, DNS pinning, parsing and
// cancellation state machine without any network or TLS trust bypass.
async function transport(t, lookup, respond, operation) {
  const calls = [];
  t.mock.method(dns, 'lookup', lookup);
  t.mock.method(https, 'request', (url, config, callback) => {
    const request = new EventEmitter();
    request.destroyed = false;
    request.destroy = () => { request.destroyed = true; };
    request.end = body => {
      calls.push({ url, config, body, request });
      queueMicrotask(() => respond(callback, request));
    };
    return request;
  });
  syncBuiltinESMExports();
  try { await operation(calls); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}
function response(callback, { status = 200, headers = { 'content-type': 'application/json' }, body = '{}' } = {}) {
  const stream = new EventEmitter(); stream.statusCode = status; stream.headers = headers;
  stream.destroy = () => {};
  callback(stream);
  stream.emit('data', Buffer.from(body)); stream.emit('end');
}

test('public read/write gate pins validated DNS and sends only explicit POST credentials', async t => {
  let resolutions = 0;
  await transport(t, async () => { resolutions++; return [{ address: '8.8.8.8', family: 4 }]; },
    callback => response(callback), async calls => {
      assert.deepEqual(await postPublicJson('https://example.org/v1/consents', options), {});
      const sent = calls[0];
      assert.equal(sent.url.hostname, 'example.org');
      assert.equal(sent.config.agent, false);
      assert.equal(sent.config.method, 'POST');
      assert.equal(sent.body, options.bodyJson);
      assert.equal(sent.config.headers.Authorization, `Bearer ${options.credential}`);
      await new Promise((resolve, reject) => sent.config.lookup('example.org', {}, (error, address) => {
        if (error) return reject(error);
        assert.equal(address, '8.8.8.8'); resolve();
      }));
      assert.equal(resolutions, 1);
      await fetchPublicJson('https://example.org/public', options);
      assert.equal(calls[1].config.method, 'GET');
      assert.equal(calls[1].config.headers.Authorization, undefined);
      assert.equal(calls[1].body, undefined);
    });
});

test('mixed public/private DNS prevents all requests; cancellation while resolving prevents dispatch', async t => {
  await transport(t, async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
    callback => response(callback), async calls => {
      await assert.rejects(postPublicJson('https://example.org/v1/consents', options));
      assert.equal(calls.length, 0);
    });
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  await transport(t, () => { started(); return new Promise(resolve => { release = resolve; }); },
    callback => response(callback), async calls => {
      const controller = new AbortController();
      const running = postPublicJson('https://example.org/v1/consents', { ...options, signal: controller.signal });
      const rejected = assert.rejects(running);
      await ready; controller.abort(); await rejected;
      release([{ address: '8.8.8.8', family: 4 }]);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.length, 0);
    });
});

test('redirects, compressed or oversized responses fail with one dispatch and no replay', async t => {
  for (const reply of [{ status: 302, headers: { location: 'https://other.example.org' } },
    { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } },
    { body: 'x'.repeat(20) }, { body: 'invalid JSON' }]) {
    await transport(t, async () => [{ address: '8.8.8.8', family: 4 }], callback => response(callback, reply),
      async calls => {
        await assert.rejects(postPublicJson('https://example.org/v1/consents', { ...options, maxBytes: 16 }));
        assert.equal(calls.length, 1);
      });
  }
});

test('timeout and cancellation after dispatch destroy the request without automatic retry', async t => {
  for (const mode of ['timeout', 'cancel']) {
    const controller = new AbortController();
    await transport(t, async () => [{ address: '8.8.8.8', family: 4 }],
      () => { if (mode === 'cancel') controller.abort(); }, async calls => {
        await assert.rejects(postPublicJson('https://example.org/v1/consents',
          { ...options, signal: controller.signal, timeoutMs: 20 }));
        assert.equal(calls.length, 1);
        assert.equal(calls[0].request.destroyed, true);
      });
  }
});

test('unauthenticated connection POST is limited to handshake paths and exact response statuses', async t => {
  await transport(t, async () => [{ address: '8.8.8.8', family: 4 }],
    callback => response(callback, { status: 201 }), async calls => {
      await assert.rejects(postConnectionJson('https://example.org/v1/consents', options));
      assert.equal(calls.length, 0);
      await postConnectionJson('https://example.org/v1/binding-challenges', options);
      assert.equal(calls[0].config.headers.Authorization, undefined);
      // Activation expects 200, not an arbitrary successful-looking 2xx status.
      await assert.rejects(postConnectionJson('https://example.org/v1/sessions', options));
      assert.equal(calls.length, 2);
    });
});


test('authenticated binding GET has a fixed path; public GET stays anonymous and rejection is sanitized', async t => {
  const url = 'https://example.org/v1/bindings/12345678-1234-4234-8234-123456789abc';
  await transport(t, async () => [{ address: '8.8.8.8', family: 4 }], callback => response(callback), async calls => {
    await fetchBindingJson(url, options);
    assert.equal(calls[0].config.method, 'GET');
    assert.equal(calls[0].config.headers.Authorization, `Bearer ${options.credential}`);
    assert.equal(calls[0].body, undefined);
    assert.equal(calls[0].config.headers['Content-Length'], undefined);
    await fetchPublicJson(url, options);
    assert.equal(calls[1].config.headers.Authorization, undefined);
    for (const bad of ['/v1/consents', '/v1/bindings/anything', '/v1/bindings/12345678-1234-4234-8234-123456789abc/revoke'])
      await assert.rejects(async () => fetchBindingJson('https://example.org' + bad, options));
    assert.equal(calls.length, 2);
  });
  for (const status of [401, 403]) {
    await transport(t, async () => [{ address: '8.8.8.8', family: 4 }],
      callback => response(callback, { status, body: options.credential }), async calls => {
        await assert.rejects(fetchBindingJson(url, options), error => {
          assert.equal(error.code, 'GALAXY_REMOTE_REJECTED');
          assert.equal(error.message.includes(options.credential), false); return true;
        });
        assert.equal(calls.length, 1);
      });
  }
});
