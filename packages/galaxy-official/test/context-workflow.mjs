import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { createContextClient } from "../src/clients/context.mjs";
import { createDataExportClient } from "../src/clients/data-export.mjs";
import { createContextFlow } from "../src/clients/flows/context.mjs";
import { createHostConnectionController } from "../src/clients/flows/host-connection-controller.mjs";

export async function verifyContextWorkflow(db = null, options = {}) {
  const scopes = ['binding', 'consent', 'case-teaser', 'assistance', 'context', 'data-export'];
  const f = await serviceFixture(scopes, db, options), p = await serviceFixture(scopes, f.db, options), other = await serviceFixture(scopes, f.db, options);
  const api = createApi(f), sessions = [];
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`, endpoint = f.bindings.endpoint;
  const transport = async (url, input, method = 'POST') => {
    const response = await fetch(origin + new URL(url).pathname, { method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.credential}` },
      ...(method === 'POST' ? { body: input.bodyJson } : {}), signal: input.signal });
    const result = await response.json();
    if (response.status !== 200) throw new Error(JSON.stringify(result)); return result;
  };
  function host(who) {
    const memory = createSessionMemory({ now: () => f.now, isCurrent: async () => true }); sessions.push(memory);
    memory.adopt({ endpoint, subjectId: who.actor.subjectId, bindingId: who.actor.bindingId, scopes: who.actor.scopes,
      expiresAt: f.now + 500, bindingExpiresAt: f.now + 1000, takeCredential: () => who.credential });
    const contextClient = createContextClient({ endpoint, sessions: memory, send: transport, read: (url, input) => transport(url, input, 'GET') });
    const contextFlow = createContextFlow({ endpoint, sessions: memory, signIntent: who.signForTest, now: () => f.now,
      consentSend: transport, contextSend: transport, contextRead: (url, input) => transport(url, input, 'GET'),
      assistanceSend: transport, assistanceRead: (url, input) => transport(url, input, 'GET') });
    return createHostConnectionController({ endpoint, sessions: memory, contextClient, contextFlow });
  }
  const requester = host(f), provider = host(p);
  const exporter = createDataExportClient({ endpoint, sessions: sessions[1], send: transport, now: () => f.now });
  try {
    const root = { id: randomUUID(), kind: 'case', localRef: randomUUID(), title: 'Context workflow', summary: 'Private Case',
      source: { kind: 'local', reference: randomUUID() }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
    await f.cases.submit(f.actor, await f.authorize(root));
    const request = { id: randomUUID(), caseId: root.id, title: 'Help with compiler', problem: 'Public description', attemptedApproaches: [],
      scope: 'Inspect log excerpt', visibility: 'Public', collaboration: 'open-assistance', enrollmentExpiresAt: f.now + 1800 };
    await f.assistance.create(f.actor, await f.authorize(request, 'assistance.publish', { visibility: 'Public', purpose: 'public-profile' }));
    let version = 1;
    async function event(who, kind, fields = {}) {
      const event = { id: randomUUID(), expectedVersion: version, kind, ...fields };
      const grant = await who.authorize({ assistanceId: request.id, event }, 'assistance.publish', { objectId: event.id,
        viewers: [who === f ? p.actor.subjectId : f.actor.subjectId] });
      version = (await f.assistance.submit(who.actor, request.id, grant)).version; return event;
    }
    const input = { kind: 'grant', assistanceId: request.id, expiresAt: f.now + 500,
      materials: [{ label: 'Selected log lines', content: 'Diagnostic excerpt: compiler reports missing module.' }] };
    await assert.rejects(requester.prepareContext(input), /active collaboration/);
    const offer = await event(p, 'offer', { proposal: 'Read diagnostic', scope: request.scope });
    await event(f, 'select', { offerId: offer.id }); await event(p, 'confirm');
    const prepare = await requester.prepareContext(input);
    assert.ok(prepare.payloadJson.includes(input.materials[0].content));
    assert.equal((await f.db.query('SELECT * FROM context_grants WHERE assistance_id=$1', [request.id])).rows.length, 0);
    const receipt = await requester.executeContext(prepare, prepare.confirmation);
    const id = receipt.grantId;
    const pending = await provider.getContext(id);
    assert.equal(pending.state, 'pending'); assert.equal(pending.contextAccessGranted, false);
    assert.equal(pending.materials[0].content, undefined);
    const selections = [{ kind: 'context', id }, { kind: 'assistance', id: request.id }];
    const exportTicket = await exporter.create({ datasets: ['authorized-views'], views: selections });
    assert.deepEqual(await exporter.create({ id: exportTicket.id, datasets: ['authorized-views'], views: selections }), exportTicket);
    const exportPage = () => exporter.page({ id: exportTicket.id, dataset: 'authorized-views' });
    const pendingExport = await exportPage();
    assert.deepEqual(pendingExport.items[0].view, await f.context.get(p.actor, id));
    assert.equal(pendingExport.nextAfter, '00000001');
    const assistanceExport = await exporter.page({ id: exportTicket.id, dataset: 'authorized-views', after: pendingExport.nextAfter });
    assert.deepEqual(assistanceExport.items[0].view, await f.assistance.get(p.actor, request.id));
    assert.equal(assistanceExport.nextAfter, null);
    await assert.rejects(f.dataExport.create(other.actor, { id: randomUUID(), datasets: ['authorized-views'], views: [{ kind: 'context', id }] }), /export_view_unavailable/);
    const limited = await serviceFixture(['binding', 'data-export'], f.db, { ...options, migrateDatabase: false });
    await assert.rejects(f.dataExport.create(limited.actor, { id: randomUUID(), datasets: ['authorized-views'], views: [{ kind: 'context', id }] }), /export_view_scope_required/);
    const list = await provider.queryContext(request.id);
    assert.equal(list.items.length, 1); assert.equal(list.items[0].materials[0].content, undefined);
    await assert.rejects(f.context.get(other.actor, id), /not_found/);
    const accepted = await provider.prepareContext({ kind: 'accept', grantId: id });
    await provider.executeContext(accepted, accepted.confirmation);
    const countReads=async()=>Number((await f.db.query("SELECT count(*) FROM audit_events WHERE actor=$1 AND object_id=$2 AND action='context.read'",[p.actor.subjectId,id])).rows[0].count);
    const beforeReads=await countReads();
    assert.equal((await provider.getContext(id)).materials[0].content, input.materials[0].content);
    assert.equal((await provider.getContext(id)).materials[0].content, input.materials[0].content);
    assert.equal(await countReads(),beforeReads+2,'each successful content request has a distinct committed read record');
    assert.equal((await exportPage()).items[0].view.materials[0].content, input.materials[0].content);
    const pages = [];
    assert.equal((await exporter.download(exportTicket.id, { onPage: page => pages.push(page) })).totalRows, 2);
    assert.equal(pages.length, 2);
    await assert.rejects(provider.prepareContext({ kind: 'grant', assistanceId: request.id, materials: input.materials }), /active collaboration/);
    // A scope change blocks the grant, even after the same text is reconfirmed.
    await event(f, 'change-scope', { scope: request.scope, reason: 'Explicit reconfirmation' });
    await assert.rejects(provider.getContext(id), /collaboration_changed/);
    await assert.rejects(exportPage(), /export_view_unavailable/);
    await exporter.revoke({ id: exportTicket.id });
    await event(p, 'confirm-scope');
    await assert.rejects(provider.getContext(id), /collaboration_changed/);
    const renewed = await requester.prepareContext(input); await requester.executeContext(renewed, renewed.confirmation);
    const renewedAcceptance = await provider.prepareContext({ kind: 'accept', grantId: renewed.grantId });
    await provider.executeContext(renewedAcceptance, renewedAcceptance.confirmation);
    const renewedTicket = await exporter.create({ datasets: ['authorized-views'], views: [{ kind: 'context', id: renewed.grantId }] });
    await f.consents.revoke(f.actor, JSON.parse(renewed.intentJson).id);
    const revokedAt=performance.now();
    await assert.rejects(provider.getContext(renewed.grantId), /consent_required/);
    options.onRevocationCheck?.({surface:'context-client',afterCommitObservedMs:performance.now()-revokedAt,passed:true});
    await assert.rejects(exporter.page({ id: renewedTicket.id, dataset: 'authorized-views' }), /export_view_unavailable/);
    options.onRevocationCheck?.({surface:'context-authorized-export',afterCommitObservedMs:performance.now()-revokedAt,passed:true});
    await exporter.revoke({ id: renewedTicket.id });
    const expired = await requester.prepareContext({ ...input, expiresAt: f.now + 5 }); await requester.executeContext(expired, expired.confirmation);
    const expiringTicket = await exporter.create({ datasets: ['authorized-views'], views: [{ kind: 'context', id: expired.grantId }] });
    const previousNow = f.access.now; f.access.now = () => f.now + 10;
    try { await assert.rejects(provider.getContext(expired.grantId), /context_unavailable/);
      await assert.rejects(exporter.page({ id: expiringTicket.id, dataset: 'authorized-views' }), /export_view_unavailable/); }
    finally { f.access.now = previousNow; }
    const last = await requester.prepareContext(input); await requester.executeContext(last, last.confirmation);
    const finalAcceptance = await provider.prepareContext({ kind: 'accept', grantId: last.grantId });
    await provider.executeContext(finalAcceptance, finalAcceptance.confirmation);
    await event(f, 'cancel', { reason: 'End collaboration' });
    await assert.rejects(provider.getContext(last.grantId), /collaboration_changed/);
    const revoked = await requester.prepareContext({ kind: 'revoke', grantId: last.grantId });
    assert.equal((await requester.executeContext(revoked, revoked.confirmation)).state, 'revoked');
    assert.equal((await requester.queryContext(request.id)).items.length, 0);
    const audit = (await f.db.query("SELECT * FROM audit_events WHERE action LIKE 'context.%' AND actor IN ($1,$2)", [f.actor.subjectId, p.actor.subjectId])).rows;
    assert.equal(audit.filter(row=>['context.create','context.accept','context.revoke'].includes(row.action)).length,8);
    assert.ok(['context.metadata.read','context.read','context.query','context.export.read','context.export.inspect'].every(action=>audit.some(row=>row.action===action)));
    assert.ok(audit.every(row => row.scope === 'context' && row.context_version === 1));
    const reads=audit.filter(row=>['context.read','context.metadata.read'].includes(row.action));
    assert.equal(new Set(reads.map(row=>row.request_id)).size,reads.length);
    assert.ok(reads.every(row=>row.caller_binding_id&&row.credential_scopes.includes('context')&&row.consent_id));
    assert.ok(!JSON.stringify(audit).includes('Diagnostic excerpt'));
    const exportAudit = (await f.db.query('SELECT * FROM data_export_reads WHERE subject_id=$1', [p.actor.subjectId])).rows;
    assert.ok(exportAudit.length >= 5); assert.ok(!JSON.stringify(exportAudit).includes('Diagnostic excerpt'));
  } finally {
    requester.cancel(); provider.cancel(); sessions.forEach(memory => memory.close());
    api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); if (!db) await f.db.close();
  }
}
