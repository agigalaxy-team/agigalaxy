import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createAuditClient } from '../src/audit-client.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createHostConnectionController } from '../src/host-connection-controller.mjs';

export async function verifyAuditWorkflow(database = null, options = {}) {
  const scopes = ['binding', 'audit', 'audit-review'];
  const f = await serviceFixture(scopes, database, options), a = await serviceFixture(scopes, f.db, { ...options, migrateDatabase: false });
  const outsider = await serviceFixture(scopes, f.db, { ...options, migrateDatabase: false });
  f.audit.readerIds = [a.actor.subjectId]; f.audit.reviewerIds = [f.actor.subjectId];
  const api = createApi({ ...f, rateLimit: 300 }); await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`, endpoint = f.bindings.endpoint, memories = [];
  let signatures = 0;
  const send = async (url, input) => {
    const response = await fetch(origin + new URL(url).pathname, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${input.credential}` }, body: input.bodyJson, signal: input.signal });
    const result = await response.json();
    if (response.status !== 200) throw new Error(result.error); return result;
  };
  function host(who) {
    const sessions = createSessionMemory({ now: () => f.now, isCurrent: async () => true }); memories.push(sessions);
    sessions.adopt({ endpoint, subjectId: who.actor.subjectId, bindingId: who.actor.bindingId, scopes,
      expiresAt: f.now + 500, bindingExpiresAt: f.now + 900, takeCredential: () => who.credential });
    const client = createAuditClient({ endpoint, sessions, send, now: () => f.now, signApproval: (payload, typ) => {
      assert.equal(client.isSigningApproval(payload), true); signatures++; return who.signForTest(payload, typ);
    } });
    return createHostConnectionController({ endpoint, sessions, auditClient: client });
  }
  const reviewer = host(f), reader = host(a);
  try {
    const own = await reviewer.readAudit('query', { limit: 1 });
    assert.equal(own.items.length, 1); assert.equal(own.view, 'owner'); assert.ok(own.nextAfter);
    const second = await reviewer.readAudit('query', { after: own.nextAfter, through: own.through, limit: 100 });
    assert.ok(second.items.every(row => row.actor === f.actor.subjectId));
    assert.ok(!second.items.some(row => row.action === 'audit.query'), 'query history does not expand its own fixed upper cursor');
    await assert.rejects(reader.readAudit('query', { subjectId: f.actor.subjectId }), /audit_approval_required/);
    const input = { readerId: a.actor.subjectId, subjectIds: [f.actor.subjectId], actions: ['query'], reasonCode: 'incident-001', lifetimeSeconds: 600 };
    const canceled = await reviewer.prepareAudit(input); assert.equal(signatures, 0);
    await assert.rejects(reviewer.readAudit('grants'), /unavailable/);
    reviewer.cancel(); await assert.rejects(reviewer.executeAudit(canceled, canceled.confirmation)); assert.equal(signatures, 0);
    const preview = await reviewer.prepareAudit(input);
    const receipt = await reviewer.executeAudit(preview, preview.confirmation); assert.equal(signatures, 1);
    const grant = JSON.parse(preview.payloadJson);
    assert.equal((await reader.readAudit('grants')).items[0].id, receipt.id);
    const approved = await reader.readAudit('query', { subjectId: f.actor.subjectId, grantId: receipt.id });
    assert.equal(approved.view, 'approved-reader'); assert.equal(approved.grantId, receipt.id);
    const readRecord = (await f.db.query('SELECT * FROM audit_reads WHERE id=$1', [approved.queryId])).rows[0];
    assert.equal(readRecord.actor_id, a.actor.subjectId); assert.equal(readRecord.result_hash, approved.sha256);
    const audit = (await f.db.query("SELECT * FROM audit_events WHERE object_id=$1 AND action='audit.query'", [approved.queryId])).rows[0];
    assert.equal(audit.caller_binding_id, a.actor.bindingId); assert.equal(audit.scope, 'audit'); assert.equal(audit.consent_id, null);
    await assert.rejects(reader.readAudit('export', { subjectId: f.actor.subjectId, grantId: receipt.id }), /audit_scope_denied/);
    await assert.rejects(reader.readAudit('query', { subjectId: outsider.actor.subjectId, grantId: receipt.id }), /audit_scope_denied/);
    await assert.rejects(f.audit.query(outsider.actor, { subjectId: f.actor.subjectId, grantId: receipt.id }), /audit_approval_required/);
    const signed = await f.signForTest(preview.payloadJson, 'galaxy-audit-approval+jws');
    await f.audit.approve(f.actor, signed);
    assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='audit.grant' AND object_id=$1", [receipt.id])).rows.length, 1);
    await assert.rejects(f.audit.approve(f.actor, await outsider.signForTest(preview.payloadJson, 'galaxy-audit-approval+jws')), /invalid_audit_approval/);
    await assert.rejects(f.audit.approve(f.actor, await f.signForTest(JSON.stringify({ ...grant, id: randomUUID(), readerId: f.actor.subjectId }), 'galaxy-audit-approval+jws')), /invalid_audit_request/);
    await reviewer.readAudit('revoke', { id: receipt.id });
    await assert.rejects(reader.readAudit('query', { subjectId: f.actor.subjectId, grantId: receipt.id }), /audit_approval_required/);
    const exportPreview = await reviewer.prepareAudit({ ...input, actions: ['query', 'export'] });
    const exportGrant = await reviewer.executeAudit(exportPreview, exportPreview.confirmation);
    const exported = await reader.readAudit('export', { subjectId: f.actor.subjectId, grantId: exportGrant.id, action: 'binding.create' });
    assert.equal(exported.items.length, 1); assert.match(exported.filename, /^galaxy-audit-/);
    assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='audit.export' AND object_id=$1", [exported.queryId])).rows.length, 1);
    for (const secret of [f.credential, a.credential, f.actor.credentialHash, a.actor.credentialHash]) assert.ok(!JSON.stringify(exported).includes(secret));
    f.audit.reviewerIds = [];
    await assert.rejects(reader.readAudit('query', { subjectId: f.actor.subjectId, grantId: exportGrant.id }), /audit_approval_required/);
    f.audit.reviewerIds = [f.actor.subjectId];
    await f.db.query('UPDATE bindings SET revoked_at=$2 WHERE id=$1', [f.actor.bindingId, new Date(f.now * 1000).toISOString()]);
    await assert.rejects(reader.readAudit('query', { subjectId: f.actor.subjectId, grantId: exportGrant.id }), /audit_approval_required/);
    await assert.rejects(reviewer.readAudit('query', {}), /access_denied/);
  } finally {
    reviewer.cancel(); reader.cancel(); memories.forEach(memory => memory.close());
    api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); if (!database) await f.db.close();
  }
}
