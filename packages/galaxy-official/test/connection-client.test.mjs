import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBindingStatusClient } from "../src/clients/binding-status.mjs";
import { createConnectionClient } from "../src/clients/connection.mjs";
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { serviceFixture } from './service-fixture.mjs';

test('confirmed connection runs four HTTP steps, verifies receipts and releases a credential only on complete success', async () => {
  const f = await serviceFixture(['binding', 'consent']);
  const api = createApi({ ...f, rateLimit: 1000 });
  try {
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const endpoint = f.bindings.endpoint;
    const origin = `http://127.0.0.1:${api.address().port}`;
    let calls = [], signs = 0, failAt = 0, current = true, time = f.now;
    const request = () => ({ subjectId: f.genesis.id, genesisProof: f.genesis.genesisProof,
      installationId: randomUUID(), scopes: ['binding', 'consent'] });
    const send = async (url, options) => {
      assert.equal(new URL(url).origin, endpoint);
      const path = new URL(url).pathname;
      calls.push(path);
      // Test-only transport maps the fixed logical origin to an isolated API.
      // Production public-network/TLS checks remain intact and are not bypassed.
      const response = await fetch(origin + path, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: options.bodyJson, signal: options.signal });
      if (calls.length === failAt) throw new Error('Unknown remote outcome');
      assert.equal(response.status, path.endsWith('-challenges') ? 201 : 200);
      return response.json();
    };
    const client = createConnectionClient({ endpoint, trustedKeys: f.bindings.trustedKeys,
      now: () => time, assertCurrent: async () => current,
      sign: async (payload, typ) => { signs++; return f.signForTest(payload, typ); }, send });
    const input = request(); const preview = client.prepare(input);
    input.scopes.push('proof');
    assert.deepEqual([calls.length, signs], [0, 0]);
    await assert.rejects(client.execute({ ...preview }, preview.confirmation));
    await assert.rejects(client.execute(preview, preview.confirmation + ' '));
    const result = await client.execute(preview, preview.confirmation);
    assert.deepEqual(calls, ['/v1/binding-challenges', '/v1/bindings', '/v1/session-challenges', '/v1/sessions']);
    assert.equal(signs, 2);
    assert.deepEqual(result.scopes, ['binding', 'consent']);
    const vault = createSessionMemory({ now: () => time, isCurrent: async () => current });
    vault.adopt(result);
    assert.equal((await vault.status(endpoint)).connected, false);
    const token = (await vault.readAuthorization(endpoint)).credential;
    assert.equal((await f.access.authenticate(token, 'consent')).bindingId, result.bindingId);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(result.takeCredential(), null);
    const statusClient = createBindingStatusClient({ endpoint, sessions: vault, now: () => time,
      send: async (url, options) => {
        const response = await fetch(origin + new URL(url).pathname,
          { headers: { Authorization: `Bearer ${options.credential}` }, signal: options.signal });
        if ([401, 403].includes(response.status))
          throw Object.assign(new Error('Remote denied'), { code: 'GALAXY_REMOTE_REJECTED' });
        assert.equal(response.status, 200); return response.json();
      } });
    assert.equal((await statusClient.check()).state, 'binding-verified');
    await f.bindings.revoke(result.bindingId, f.genesis.id, randomUUID(), null, await f.access.authenticate(token));
    assert.equal((await statusClient.check()).state, 'remote-rejected');
    assert.equal(await vault.readAuthorization(endpoint), null);
    vault.close();
    await assert.rejects(client.execute(preview, preview.confirmation));
    const discardPreview = client.prepare(request());
    const discardResult = await client.execute(discardPreview, discardPreview.confirmation);
    client.cancel(discardPreview);
    assert.equal(discardResult.takeCredential(), null);

    for (failAt = 1; failAt <= 4; failAt++) {
      calls = []; signs = 0;
      const pending = client.prepare(request());
      await assert.rejects(client.execute(pending, pending.confirmation), /Unknown remote outcome/);
      await assert.rejects(client.execute(pending, pending.confirmation));
      assert.equal(calls.length, failAt);
    }
    calls = []; failAt = 0;
    const canceled = client.prepare(request()); client.cancel(canceled);
    await assert.rejects(client.execute(canceled, canceled.confirmation));
    const stale = client.prepare(request()); current = false;
    await assert.rejects(client.execute(stale, stale.confirmation));
    assert.equal(calls.length, 0);
    current = true;
    const expired = client.prepare(request()); time += 301;
    await assert.rejects(client.execute(expired, expired.confirmation));
    assert.equal(calls.length, 0);
    time = f.now;
    const delayedApproval = createConnectionClient({ endpoint, trustedKeys: f.bindings.trustedKeys,
      now: () => time, sign: f.signForTest, send,
      assertCurrent: async () => { time += 301; return true; } });
    const delayed = delayedApproval.prepare(request());
    await assert.rejects(delayedApproval.execute(delayed, delayed.confirmation));
    assert.equal(calls.length, 0);
  } finally {
    api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await f.db.close();
  }
});

test('cancel, pin revocation and challenge expiry during signing prevent the next connection request', async () => {
  const f = await serviceFixture(['binding']);
  try {
    for (const mode of ['cancel', 'revoke-pin', 'expire']) {
      let time = f.now, sends = 0;
      f.bindings.trustedKeys.get('fixture').revoked = false;
      const client = createConnectionClient({ endpoint: f.bindings.endpoint, trustedKeys: f.bindings.trustedKeys,
        now: () => time, assertCurrent: async () => true,
        sign: async (payload, typ) => {
          if (mode === 'cancel') client.cancel(preview);
          if (mode === 'revoke-pin') f.bindings.trustedKeys.get('fixture').revoked = true;
          if (mode === 'expire') time += 181;
          return f.signForTest(payload, typ);
        }, send: async (_url, options) => { sends++; return f.bindings.challenge(JSON.parse(options.bodyJson)); } });
      const preview = client.prepare({ subjectId: f.genesis.id, genesisProof: f.genesis.genesisProof,
        installationId: randomUUID(), scopes: ['binding'] });
      await assert.rejects(client.execute(preview, preview.confirmation));
      assert.equal(sends, 1);
    }
  } finally { await f.db.close(); }
});
