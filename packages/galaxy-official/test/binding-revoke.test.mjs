import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';

test('binding revocation rechecks its caller in the write transaction and snapshots live credential scopes', async () => {
  const f = await serviceFixture();
  let api;
  try {
    const id = f.actor.bindingId;
    const revoke = actor => f.bindings.revoke(id, actor.subjectId, randomUUID(), null, actor);
    const unchanged = async () => {
      assert.equal((await f.bindings.get(id, f.actor.subjectId)).state, 'active');
      assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='binding.revoke'")).rows.length, 0);
    };
    await assert.rejects(revoke({ ...f.actor, credentialHash: '0'.repeat(64) }), /access_denied/);
    await f.db.query("UPDATE access_credentials SET scopes='[]'");
    await assert.rejects(revoke({ ...f.actor, scopes: ['binding', 'admin'] }), /access_denied/);
    await unchanged();
    await f.db.query('UPDATE access_credentials SET scopes=$1, expires_at=$2', [JSON.stringify(['binding']), new Date(f.now * 1000).toISOString()]);
    await assert.rejects(revoke(f.actor), /access_denied/);
    await f.db.query('UPDATE access_credentials SET expires_at=$1,revoked_at=$2',
      [new Date((f.now + 600) * 1000).toISOString(), new Date(f.now * 1000).toISOString()]);
    await assert.rejects(revoke(f.actor), /access_denied/);
    await unchanged();
    await f.db.query('UPDATE access_credentials SET revoked_at=NULL');
    // Authentication succeeds, then a concurrent policy change removes its scope before dispatch.
    const access = { authenticate: async (...args) => {
      const actor = await f.access.authenticate(...args);
      await f.db.query("UPDATE access_credentials SET scopes='[]'");
      return actor;
    } };
    api = createApi({ ...f, access });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const post = () => fetch(`http://127.0.0.1:${api.address().port}/v1/bindings/${id}/revoke`, {
      method: 'POST', headers: { Authorization: `Bearer ${f.credential}`, 'Content-Type': 'application/json' }, body: '{}' });
    const denied = await post();
    assert.equal(denied.status, 401); await denied.arrayBuffer();
    await unchanged();
    access.authenticate = f.access.authenticate.bind(f.access);
    await f.db.query('UPDATE access_credentials SET scopes=$1', [JSON.stringify(['binding'])]);
    const result = await post();
    assert.equal(result.status, 200); await result.arrayBuffer();
    const audit = (await f.db.query("SELECT * FROM audit_events WHERE action='binding.revoke'")).rows;
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].credential_scopes, ['binding']);
    assert.deepEqual(audit[0].binding_scopes, ['binding', 'consent', 'case-teaser']);
    assert.equal(audit[0].http_request_id, result.headers.get('x-request-id'));
    assert.ok(!JSON.stringify(audit).includes(f.actor.credentialHash));
    assert.ok(!JSON.stringify(audit).includes(f.credential));
    await assert.rejects(revoke(f.actor), /access_denied/);
    assert.equal((await post()).status, 401);
  } finally {
    if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
    await f.db.close();
  }
});
