import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createApi } from '../src/http.mjs';
import { clientAddressReader, fixedWindowLimiter, requestUrl } from '../src/adapters/http/policy.mjs';
import { createBrowserClient } from '../src/browser-client.mjs';

async function fixture(options, run) {
  const server = createApi({ bindings: { endpoint: 'https://galaxy.example' }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const send = (path, { headers = {}, method = 'GET', payload } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.address().port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  try { await run(send); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('public account post paging accepts its bounded cursor without broadening other routes or methods', () => {
  const endpoint='https://galaxy.example',path='/v1/account/public/11111111-2222-4333-8444-555555555555/posts';
  const read=(suffix,method='GET')=>requestUrl({url:path+suffix,method,headers:{}},endpoint);
  assert.equal(read('?limit=50&after=fp1.abc_-123').pathname,path);
  for(const query of ['?limit=0','?limit=51','?limit=01','?after=','?after=11111111-2222-4333-8444-555555555555',
    '?limit=2&limit=3','?other=1','?after=fp1.'+'a'.repeat(509)])assert.throws(()=>read(query));
  assert.throws(()=>read('?limit=2','POST'));
  assert.throws(()=>requestUrl({url:path.replace('/posts','/ids')+'?after=fp1.'+'a'.repeat(180),method:'GET',headers:{}},endpoint));
});

test('known forum objects carry one exact quota locator through browser and real HTTP without opening other queries', async () => {
  const id = '11111111-2222-4333-8444-555555555555', calls = [];
  await fixture({ access: { authenticate: async () => ({ subjectId: 'fixture' }) },
    forum: { budget: { status: async (_actor, input) => { calls.push(input); return input; } } } }, async send => {
    for (const key of ['postId', 'replyId', 'sectionId']) {
      const response = await send(`/v2/community/quotas?${key}=${id}`, { headers: { authorization: 'Bearer synthetic' } });
      assert.equal(response.status, 200); assert.deepEqual(response.body, { [key]: id });
    }
    for (const query of [`postId=${id}&replyId=${id}`, `postId=${id}&postId=${id}`, 'postId=invalid', `other=${id}`])
      assert.equal((await send('/v2/community/quotas?' + query)).status, 400);
    assert.equal((await send('/v2/community/posts?postId=' + id)).status, 400);
    assert.equal(calls.length, 3);
  });
  const sent = [], client = createBrowserClient({ endpoint: 'https://galaxy.example', trustedKeys: new Map([['fixture', {}]]), sign: async () => '',
    fetch: async url => { sent.push(url); return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }); } });
  try {
    for (const key of ['postId', 'replyId', 'sectionId'])
      await client.call(`/v2/community/quotas?${key}=${id}`, null, { method: 'GET', authenticated: false });
    for (const path of [`/v2/community/quotas?postId=${id}&replyId=${id}`, '/v2/community/quotas?postId=invalid', `/v2/community/posts?postId=${id}`]) {
      await assert.rejects(client.call(path, null, { method: 'GET', authenticated: false }), /Invalid API path/);
      await assert.rejects(client.send('https://galaxy.example' + path, { method: 'GET' }), /Invalid browser API target/);
    }
    assert.equal(sent.length, 3);
  } finally { client.close(); }
});

test('HTTP forwarded addresses require a trusted socket and stop at the first untrusted hop', async () => {
  const read = clientAddressReader(['127.0.0.1', '::1']);
  assert.equal(read({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {
    'x-forwarded-for': '198.51.100.99, 192.0.2.8, ::1' } }), '192.0.2.8');
  assert.equal(clientAddressReader()({ socket: { remoteAddress: '127.0.0.1' }, headers: {
    'x-forwarded-for': '198.51.100.99' } }), '127.0.0.1');
  assert.throws(() => clientAddressReader(['*']));
  for (const raw of [undefined, 'invalid', '', '192.0.2.8:443', '192.0.2.8,,::1'])
    assert.throws(() => read({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': raw } }), /invalid_forwarded_address/);
  await fixture({ rateLimit: 1, keyring: {} }, async send => {
    assert.equal((await send('/.well-known/galaxy-signing-keys.json', { headers: { 'x-forwarded-for': '192.0.2.1' } })).status, 200);
    assert.equal((await send('/.well-known/galaxy-signing-keys.json', { headers: { 'x-forwarded-for': '192.0.2.2' } })).status, 429);
  });
  await fixture({ rateLimit: 1, keyring: {} }, async send => {
    assert.equal((await send('/healthz?invalid=1')).status, 400);
    assert.equal((await send('/.well-known/galaxy-signing-keys.json')).status, 429);
    assert.equal((await send('/healthz')).status, 200);
  });
});

test('HTTP trusted proxy separates client quotas; probes have bounded independent capacity', async () => {
  await fixture({ rateLimit: 1, healthRateLimit: 2, trustedProxyAddresses: ['127.0.0.1'], keyring: {}, readiness: async () => false }, async send => {
    const path = '/.well-known/galaxy-signing-keys.json';
    const a = { headers: { 'x-forwarded-for': '192.0.2.1' } };
    const b = { headers: { 'x-forwarded-for': '192.0.2.2' } };
    assert.equal((await send(path, a)).status, 200);
    const limited = await send(path, a);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers['retry-after'], '60');
    assert.equal((await send(path, b)).status, 200);
    assert.equal((await send('/healthz', a)).status, 200);
    const readiness = await send('/readyz', a);
    assert.equal(readiness.status, 503);
    assert.deepEqual(readiness.body, { status: 'unavailable' });
    assert.equal((await send('/healthz', a)).status, 429);
    assert.equal((await send(path)).status, 400);
  });
});

test('HTTP parsing, authentication scope and sanitized errors survive route extraction', async () => {
  const calls = [];
  const logs = [];
  await fixture({ access: { authenticate: async (token, scope) => { calls.push({ token, scope }); return { subjectId: 'fixture' }; } },
    cases: { submit: async (_actor, input) => input }, logger: event => logs.push(event) }, async send => {
    const post = (payload, headers = {}) => send('/v1/cases', { method: 'POST',
      headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json', ...headers }, payload });
    const value = { consentId: 'fixture', payloadJson: JSON.stringify({ kind: 'case' }) };
    assert.deepEqual((await post(JSON.stringify(value))).body, value);
    assert.deepEqual(calls[0], { token: 'synthetic', scope: 'case-teaser' });
    assert.equal((await post('{}', { authorization: 'Basic synthetic' })).status, 401);
    assert.equal((await post('{')).body.error, 'invalid_json');
    assert.equal((await post('[]')).body.error, 'invalid_request');
    assert.equal((await post(JSON.stringify({ ...value, extra: true }))).status, 400);
    assert.equal((await post('{}', { 'content-encoding': 'gzip' })).status, 415);
    assert.equal((await post('x'.repeat(32769))).status, 413);
    assert.equal((await send('/healthz', { headers: { origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await send('https://other.example/healthz')).status, 400);
    assert.equal((await send('/healthz?anything=1')).status, 400);
    assert.equal((await send('/v1/consents?after=a&after=b')).status, 400);
    const missing = await send('/unknown');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers['x-content-type-options'], 'nosniff');
    assert.equal(missing.headers['x-request-id'], missing.body.requestId);
    assert.ok(logs.every(event => Object.keys(event).sort().join(',') === 'code,requestId,status'));
    assert.ok(!JSON.stringify(logs).includes('synthetic'));
  });
});

test('quota expiry releases capacity and a throwing logger does not break HTTP handling', async () => {
  let now = 0;
  const limit = fixedWindowLimiter({ limit: 1, capacity: 1, now: () => now });
  const response = { setHeader() {} };
  limit('one', response);
  assert.throws(() => limit('two', response), /capacity_limited/);
  now = 60000;
  limit('two', response);
  await fixture({ logger: () => { throw new Error('sink unavailable'); } }, async send => {
    assert.equal((await send('/unknown')).status, 404);
    assert.equal((await send('/healthz')).status, 200);
  });
});


test('HTTP rejects malformed UTF-8 before business dispatch and counts multibyte bodies in bytes', async () => {
  const received = [];
  await fixture({ access: { authenticate: async () => ({ subjectId: 'fixture' }) },
    cases: { submit: async (_actor, input) => { received.push(input); return input; } } }, async send => {
    const post = payload => send('/v1/cases', { method: 'POST',
      headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' }, payload });
    // Build malformed bytes inside an otherwise valid JSON string.
    const valid = Buffer.from(JSON.stringify({ consentId: 'X', payloadJson: '{"kind":"case"}' }));
    const at = valid.indexOf('X');
    const malformed = Buffer.concat([valid.subarray(0, at), Buffer.from([0xc3, 0x28]), valid.subarray(at + 1)]);
    const result = await post(malformed);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid_json');
    assert.equal(received.length, 0);
    const good = { consentId: '中文', payloadJson: '{"kind":"case"}' };
    assert.deepEqual((await post(Buffer.from(JSON.stringify(good)))).body, good);
    const oversized = Buffer.from(JSON.stringify({ ...good, consentId: '中'.repeat(12000) }));
    assert.equal((await post(oversized)).status, 413);
    assert.equal(received.length, 1);
  });
});


test('readiness deadline returns unavailable without multiplying a stuck backend probe', async () => {
  let calls = 0, complete;
  await fixture({ readinessTimeoutMs: 25, readiness: () => { calls++; return new Promise(resolve => { complete = resolve; }); } }, async send => {
    const replies = await Promise.all(Array.from({ length: 8 }, () => send('/readyz')));
    assert.ok(replies.every(reply => reply.status === 503 && reply.body.status === 'unavailable'));
    assert.equal(calls, 1);
    assert.equal((await send('/readyz')).status, 503);
    assert.equal(calls, 1);
    assert.equal((await send('/healthz')).status, 200);
    complete(true);
    await new Promise(resolve => setImmediate(resolve));
    const next = send('/readyz');
    for (let attempt = 0; calls < 2 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(calls, 2);
    complete(true);
    assert.equal((await next).status, 200);
  });
  await fixture({ readiness: () => { throw new Error('synthetic backend detail'); } }, async send => {
    const response = await send('/readyz');
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { status: 'unavailable' });
  });
});
