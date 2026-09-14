import { builderDeclaration } from './builders-workflow.mjs';
import { verifyNodeControlProof } from '../src/builder-client.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeGalaxyIntegration, resetGalaxyIntegration, createCaseDraft } from '../../galaxy-core/src/local-store.mjs';
import { createConnectionProfile, saveConnectionProfile, revokeConnectionScope } from '../../galaxy-core/src/connection-profile.mjs';
import { createLocalHostRuntime } from '../src/local-host-runtime.mjs';
import { serviceFixture } from './service-fixture.mjs';
import { BINDING_RECEIPTS_FILE } from '../src/local-binding-receipts.mjs';
import { IdentityLinkService } from '../src/identity-links.mjs';
import { syntheticIdentityProvider,syntheticIdentityCallback } from './identity-test-provider.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-local-host-'));
  const f = await serviceFixture(['binding', 'consent', 'history', 'case-teaser', 'assistance', 'context', 'notifications', 'moderation', 'capsules', 'builders', 'audit', 'audit-review', 'data-delete']);
  t.after(async () => { await f.db.close(); await rm(directory, { recursive: true, force: true }); });
  await initializeGalaxyIntegration(directory, { profile: 'coding-case', source: 'test' });
  const endpoint = f.bindings.endpoint;
  const profile = createConnectionProfile({ targets: [{ id: 'official', kind: 'official', endpoint }],
    scopes: [{ id: 'bind', targetId: 'official', action: 'binding', recipient: endpoint,
      purpose: 'Explicit connection', visibleFields: ['subjectId', 'genesisProof', 'installationId', 'scopes'],
      expiresAt: new Date((f.now + 90000) * 1000).toISOString() }] });
  await saveConnectionProfile(directory, profile);
  let calls = 0, time = f.now, afterSend = async () => {};
  const connectionSend = async (url, options) => {
    calls++;
    const path = new URL(url).pathname, body = JSON.parse(options.bodyJson);
    const handlers = { '/v1/binding-challenges': () => f.bindings.challenge(body), '/v1/bindings': () => f.bindings.bind(body),
      '/v1/session-challenges': () => f.access.challenge(body), '/v1/sessions': () => f.access.activate(body) };
    const result = await handlers[path](); await afterSend(); return result;
  };
  const config = { dataDirectory: directory, endpoint, installationId: randomUUID(), scopes: ['binding', 'consent', 'history', 'case-teaser', 'assistance', 'context', 'notifications', 'moderation', 'capsules', 'builders', 'audit', 'audit-review', 'data-delete'],
    bindingScopeId: 'bind', trustedKeys: f.bindings.trustedKeys, manifest: (await f.manifest.get()).document,
    now: () => time, connectionSend,
    deletionSend: async (url, options) => {
      const method = new URL(url).pathname.split('/').at(-1), input = JSON.parse(options.bodyJson);
      if(method==='status')return f.deletion.statusWithProof(input.signed);
      const actor = await f.access.authenticate(options.credential, 'data-delete');
      return f.deletion[method](actor, method === 'submit' ? input.signed : input);
    },
    auditSend: async (url, options) => {
      const path = new URL(url).pathname, input = JSON.parse(options.bodyJson);
      const actor = await f.access.authenticate(options.credential, /approve|revoke/.test(path) ? 'audit-review' : 'audit');
      if (path.endsWith('/approve')) return f.audit.approve(actor, input.signed);
      if (path.endsWith('/revoke')) return f.audit.revoke(actor, input);
      if (path.endsWith('/config')) return f.audit.config(actor);
      if (path.endsWith('/grants')) return f.audit.listGrants(actor);
      return f.audit.query(actor, input, path.endsWith('/export') ? 'export' : 'query');
    },
    consentSend: async (_url, options) => f.consents.create(await f.access.authenticate(options.credential), JSON.parse(options.bodyJson).signedIntent),
    caseSend: async (_url, options) => f.cases.submit(await f.access.authenticate(options.credential), JSON.parse(options.bodyJson)),
    caseRead:async(url,options)=>f.cases.get(await f.access.authenticate(options.credential,'case-teaser'),new URL(url).pathname.split('/').at(-1)),
    builderSend: async (url, options) => {
      const actor=await f.access.authenticate(options.credential,'builders'),input=JSON.parse(options.bodyJson),path=new URL(url).pathname;
      if(path.endsWith('/events'))return f.builders.publish(actor,input);
      if(path.endsWith('/node-control/export'))return f.builders.exportNodeControl(actor,input);
      if(path.endsWith('/manage/read'))return f.builders.manage(actor,input);
      if(path.endsWith('/owned/query'))return f.builders.owned(actor,input);
      if(path.endsWith('/events/receipt'))return f.builders.receipt(actor,input);
      if(path.endsWith('/notices/query'))return f.builders.notices(actor,input);
      if(path.endsWith('/read'))return f.builders.get(actor,input);
      return f.builders.query(actor,input);
    },
    capsuleSend: async (url, options) => {
      const actor=await f.access.authenticate(options.credential,'capsules'),input=JSON.parse(options.bodyJson),path=new URL(url).pathname;
      if(path.endsWith('/events'))return f.capsules.publish(actor,input);
      if(path.endsWith('/uses'))return f.capsules.recordUse(actor,input);
      if(path.endsWith('/uses/query'))return f.capsules.uses(actor,input);
      if(path.endsWith('/read'))return f.capsules.get(actor,input);
      return f.capsules.query(actor,input);
    },
    honorSend: async (url, options) => {
      const path = new URL(url).pathname, input = JSON.parse(options.bodyJson);
      if(path.endsWith('/rules'))return f.honor.list();
      if(path.endsWith('/ranking'))return f.honor.ranking(input);
      return f.honor.query(options.credential?await f.access.authenticate(options.credential,'history'):null,input);
    },
    moderationSend: async (url, options) => {
      const actor = await f.access.authenticate(options.credential, 'moderation'), input = JSON.parse(options.bodyJson), path = new URL(url).pathname;
      if (path.endsWith('/config')) return f.moderation.config(actor);
      if (path.endsWith('/query')) return f.moderation.query(actor, input);
      if (path.endsWith('/read')) return f.moderation.get(actor, path.split('/')[4]);
      return path.endsWith('/events') ? f.moderation.event(actor, path.split('/')[4], input) : f.moderation.report(actor, input);
    },
    notificationsSend: async (url, options) => {
      const actor = await f.access.authenticate(options.credential, 'notifications'), input = JSON.parse(options.bodyJson), path = new URL(url).pathname;
      if (path.endsWith('/preferences/read')) return f.notifications.preferences(actor);
      if (path.endsWith('/preferences/save')) return f.notifications.save(actor, input);
      if (path.endsWith('/read')) return f.notifications.markRead(actor, input);
      return f.notifications.query(actor, input);
    },
    contextSend: async (url, options) => {
      const actor = await f.access.authenticate(options.credential, 'context'), input = JSON.parse(options.bodyJson), path = new URL(url).pathname;
      if (path.endsWith('/receipt')) return f.context.receipt(actor, input);
      if (path.endsWith('/query')) return f.context.query(actor, input);
      if (path.endsWith('/accept')) return f.context.accept(actor, path.split('/')[3], input);
      if (path.endsWith('/revoke')) return f.context.revoke(actor, path.split('/')[3]);
      return f.context.create(actor, input);
    },
    contextRead: async (url, options) => f.context.get(await f.access.authenticate(options.credential, 'context'), new URL(url).pathname.split('/')[3]),
    assistanceSend: async (url, options) => {
      const actor = await f.access.authenticate(options.credential, 'assistance'), input = JSON.parse(options.bodyJson);
      const path = new URL(url).pathname;
      if (path === '/v1/qualification/policies') return f.qualification.list(actor);
      if (path === '/v1/qualification/evaluate') return f.qualification.evaluate(actor, input);
      if (path === '/v1/requester-history/query') return f.assistance.requesterHistory(actor, input);
      if (path === '/v1/assistance/events/receipt') return f.assistance.receipt(actor, input);
      if (path.endsWith('/query')) return f.assistance.query(actor, input);
      return path === '/v1/assistance' ? f.assistance.create(actor, input) : f.assistance.submit(actor, path.split('/')[3], input);
    },
    assistanceRead: async (url, options) => f.assistance.get(await f.access.authenticate(options.credential, 'assistance'), new URL(url).pathname.split('/')[3]),
    historySend: async (url, options) => {
      const actor = await f.access.authenticate(options.credential, 'history');
      if(new URL(url).pathname==='/v1/profiles/statements')return f.profiles.publish(actor,JSON.parse(options.bodyJson));
      return f.history.query(actor, JSON.parse(options.bodyJson));
    },
    statusSend: async (_url, options) => {
      const actor = await f.access.authenticate(options.credential, 'binding');
      return JSON.parse(JSON.stringify(await f.bindings.get(actor.bindingId, actor.subjectId)));
    } };
  return { f, directory, profile, config, calls: () => calls,
    setTime(value) { time = value; }, afterSend(callback) { afterSend = callback; } };
}

test('identity association uses the real local key, exact host confirmation and unchanged Galaxy identity',async t=>{
  const f=await fixture(t),before=await readFile(join(f.directory,'galaxy-id.json'),'utf8');
  const identity=new IdentityLinkService(f.f.access,[syntheticIdentityProvider(f.config.endpoint,f.f.now)]);
  let calls=0;
  const runtime=createLocalHostRuntime({...f.config,identitySend:async(url,options)=>{
    calls++;const actor=await f.f.access.authenticate(options.credential,'binding');
    return identity[new URL(url).pathname.split('/').at(-1)](actor,JSON.parse(options.bodyJson));
  }});
  try {
    assert.equal(calls,0);const connection=await runtime.controller.prepare();await runtime.controller.execute(connection,connection.confirmation);
    assert.equal(calls,0);
    assert.equal((await runtime.controller.readIdentity('providers')).providers.length,1);
    const login=await runtime.controller.readIdentity('begin',{providerId:'fixture'});
    await identity.callback('fixture',syntheticIdentityCallback(login));
    const preview=await runtime.controller.prepareIdentity('link',{id:login.loginId});
    await assert.rejects(runtime.controller.prepare(),/active/);
    await assert.rejects(runtime.controller.readIdentity('query'),/unavailable/);
    runtime.controller.cancel();await assert.rejects(runtime.controller.executeIdentity(preview,preview.confirmation),/Unknown/);
    assert.equal((await f.f.db.query('SELECT * FROM external_identity_links')).rows.length,0);
    const next=await runtime.controller.prepareIdentity('link',{id:login.loginId});
    assert.equal((await runtime.controller.executeIdentity(next,next.confirmation)).state,'linked');
    const page=await runtime.controller.readIdentity('query');assert.equal(page.items.length,1);
    assert.equal(page.items[0].subjectId,JSON.parse(before).id);
    const revoke=await runtime.controller.prepareIdentity('unlink',{id:login.loginId});
    assert.equal((await runtime.controller.executeIdentity(revoke,revoke.confirmation)).state,'revoked');
    assert.equal(await readFile(join(f.directory,'galaxy-id.json'),'utf8'),before);
    assert.equal((await runtime.controller.readIdentity('query')).items[0].state,'revoked');
  }finally{runtime.close();}
});

test('local binding management preserves identity and excludes other host operations until explicit revocation',async t=>{
  const f=await fixture(t),identityBefore=await readFile(join(f.directory,'galaxy-id.json'),'utf8');
  let dispatches=0;
  const runtime=createLocalHostRuntime({...f.config,bindingManagementSend:async(url,options)=>{
    dispatches++;const actor=await f.f.access.authenticate(options.credential,'binding'),path=new URL(url).pathname;
    return path.endsWith('/query')?f.f.bindings.query(actor,JSON.parse(options.bodyJson)):
      f.f.bindings.revoke(path.split('/')[3],actor.subjectId,randomUUID(),null,actor);
  }});
  try{
    assert.equal(dispatches,0);const connection=await runtime.controller.prepare();await runtime.controller.execute(connection,connection.confirmation);
    const page=await runtime.controller.queryBindings();assert.equal(page.items.length,1);assert.equal(page.items[0].installationId,f.config.installationId);
    const preview=await runtime.controller.prepareBindingRevoke(page.items[0].bindingId);
    await assert.rejects(runtime.controller.queryBindings(),/unavailable/);await assert.rejects(runtime.controller.prepare(),/active/);
    runtime.controller.cancel();await assert.rejects(runtime.controller.executeBindingRevoke(preview,preview.confirmation),/Unknown/);
    const next=await runtime.controller.prepareBindingRevoke(page.items[0].bindingId);
    assert.equal((await runtime.controller.executeBindingRevoke(next,next.confirmation)).currentSessionEnded,true);
    assert.equal((await runtime.controller.status()).state,'disconnected');
    assert.equal(await readFile(join(f.directory,'galaxy-id.json'),'utf8'),identityBefore);
    await assert.rejects(runtime.controller.queryBindings(),/authorization/);
  }finally{runtime.close();}
});

test('search feedback crosses real local runtime and remains editable after disconnect without remote reads', {timeout:15000},async t=>{
  const f=await fixture(t),local=await createCaseDraft(f.directory,{title:'Compiler feedback',failureSummary:'Example local failure'});
  let reads=0;
  const runtime=createLocalHostRuntime({...f.config,searchSend:async(_url,options)=>{
    reads++;return f.f.search.query(await f.f.access.authenticate(options.credential,'history'),JSON.parse(options.bodyJson));
  }});
  try{
    const connection=await runtime.controller.prepare();await runtime.controller.execute(connection,connection.confirmation);
    const publication=await runtime.controller.preparePublication(local.id,{visibility:'Public'});
    const published=await runtime.controller.executePublication(publication,publication.confirmation);
    const page=await runtime.controller.querySearch({type:'history',query:{query:'Compiler feedback'}});
    assert.ok(page.items.some(row=>row.id===published.caseId));assert.equal((await runtime.controller.querySearchFeedback()).summary.responses,0);
    await runtime.controller.recordSearchFeedback(published.caseId,{relevance:'relevant',helpedSelection:true});
    runtime.controller.disconnect();const feedback=await runtime.controller.querySearchFeedback();
    assert.equal(feedback.summary.responses,1);assert.equal(feedback.items[0].sourceVersion,1);assert.equal(reads,1);
    await runtime.controller.editSearchFeedback({id:feedback.items[0].id,revision:feedback.items[0].revision,verdict:null});
    assert.equal((await runtime.controller.querySearchFeedback()).summary.responses,0);assert.equal(reads,1);
  }finally{runtime.close();}
});

test('Case review host signs append-only disputes, state changes and corrections with the existing local identity',async t=>{
  const f=await fixture(t),local=await createCaseDraft(f.directory,{title:'Review from history',failureSummary:'Original local description'});
  const runtime=createLocalHostRuntime(f.config);
  try{
    const connection=await runtime.controller.prepare();await runtime.controller.execute(connection,connection.confirmation);
    const publication=await runtime.controller.preparePublication(local.id,{visibility:'Public'});
    const root=await runtime.controller.executePublication(publication,publication.confirmation);
    const before=await readFile(join(f.directory,'galaxy-local-state.json'),'utf8');
    const input={caseId:root.caseId,expectedVersion:1,targetEventId:root.eventId,reason:'Review the source',summary:'Owner reports a dispute',review:{type:'dispute',state:'opened'},visibility:'Public'};
    const canceled=await runtime.controller.prepareCaseReview(input);runtime.controller.cancel();
    await assert.rejects(runtime.controller.executeCaseReview(canceled,canceled.confirmation));
    assert.equal((await runtime.controller.getCase(root.caseId)).version,1);
    const preview=await runtime.controller.prepareCaseReview(input),receipt=await runtime.controller.executeCaseReview(preview,preview.confirmation);
    assert.equal(receipt.version,2);assert.equal((await runtime.controller.getCase(root.caseId)).reviews[0].independentDecision,false);
    await assert.rejects(runtime.controller.prepareCaseReview(input),/version changed/);
    const resolved=await runtime.controller.prepareCaseReview({...input,expectedVersion:2,review:{threadId:preview.eventId,type:'dispute',state:'resolved'}});
    await runtime.controller.executeCaseReview(resolved,resolved.confirmation);
    const corrected=await runtime.controller.prepareCaseReview({...input,expectedVersion:3,review:undefined,visibility:'Private',summary:'Clarified original description'});
    assert.equal(JSON.parse(corrected.payloadJson).review,undefined);
    await runtime.controller.executeCaseReview(corrected,corrected.confirmation);
    const current=await runtime.controller.getCase(root.caseId);assert.equal(current.events[0].summary,'Original local description');
    assert.deepEqual(current.reviews[0].changes.map(change=>change.state),['opened','resolved']);
    assert.equal((await f.f.history.query(null,{query:'Review from history'})).items.length,0);
    assert.equal(await readFile(join(f.directory,'galaxy-local-state.json'),'utf8'),before);
  }finally{runtime.close();}
});

test('Profile uses the existing local identity after confirmation and keeps self declarations separate from empty history',async t=>{
  const f=await fixture(t),before=await readFile(join(f.directory,'galaxy-local-state.json'),'utf8');
  const runtime=createLocalHostRuntime(f.config);
  try{
    const connection=await runtime.controller.prepare();await runtime.controller.execute(connection,connection.confirmation);
    const status=await runtime.controller.status(),input={expectedRevision:0,selfDeclared:{displayName:'Local author',claimedCapabilities:['Self-reported compiler work']}};
    const canceled=await runtime.controller.prepareProfile(input);
    assert.equal(JSON.parse(canceled.intentJson).visibility,'Private');
    assert.equal((await f.f.db.query('SELECT id FROM profile_statements')).rows.length,0);
    runtime.controller.cancel();await assert.rejects(runtime.controller.executeProfile(canceled,canceled.confirmation));
    const preview=await runtime.controller.prepareProfile({...input,visibility:'Public'});
    await assert.rejects(runtime.controller.queryHistory({}),/unavailable/);
    const receipt=await runtime.controller.executeProfile(preview,preview.confirmation);
    assert.equal(receipt.revision,1);
    const publicProfile=await f.f.history.query(null,{subjectId:status.subjectId});
    assert.deepEqual(publicProfile.selfDeclared,input.selfDeclared);assert.deepEqual(publicProfile.items,[]);assert.equal(publicProfile.capabilityVerified,false);
    await assert.rejects(runtime.controller.prepareProfile(input),/revision changed/);
    const pending=await runtime.controller.prepareProfile({expectedRevision:1,selfDeclared:{}});
    runtime.controller.disconnect();await assert.rejects(runtime.controller.executeProfile(pending,pending.confirmation));
    assert.equal(await readFile(join(f.directory,'galaxy-local-state.json'),'utf8'),before);
  }finally{runtime.close();}
});

test('trusted local host composes real local identity signing with verified manifest, connection and status', async t => {
  const f = await fixture(t);
  const before = await readFile(join(f.directory, 'galaxy-local-state.json'), 'utf8');
  const runtime = createLocalHostRuntime(f.config);
  assert.equal(f.calls(), 0); assert.equal((await runtime.controller.status()).state, 'no-session');
  assert.deepEqual((await runtime.controller.listBindingReceipts()).records, []);
  await assert.rejects(readFile(join(f.directory, BINDING_RECEIPTS_FILE)), { code: 'ENOENT' });
  const preview = await runtime.controller.prepare();
  assert.equal(f.calls(), 0);
  await assert.rejects(runtime.controller.execute(preview, 'wrong'));
  // A failed execute consumes the controller's active preview; explicitly prepare again.
  const confirmed = await runtime.controller.prepare();
  const status = await runtime.controller.execute(confirmed, confirmed.confirmation);
  assert.equal(status.state, 'session-local'); assert.equal(f.calls(), 4);
  assert.equal((await runtime.controller.status()).receiptSaveState, 'saved-locally');
  const checked = await runtime.controller.checkRemote(); assert.equal(checked.state, 'binding-verified');
  const history = await runtime.controller.queryHistory({ query: 'compiler', limit: 8 });
  assert.deepEqual(history.items, []); assert.equal(history.source, 'endpoint-reported');
  assert.equal(await readFile(join(f.directory, 'galaxy-local-state.json'), 'utf8'), before);
  assert.equal(JSON.stringify(runtime).includes('PRIVATE KEY'), false);
  await saveConnectionProfile(f.directory, revokeConnectionScope(f.profile, 'bind'));
  assert.equal((await runtime.controller.status()).state, 'local-check-failed');
  await assert.rejects(runtime.controller.queryHistory({}), /authorization required/);
  runtime.close(); await assert.rejects(runtime.controller.prepare());
});

test('binding receipts survive disconnect and restart without restoring authorization; tampering and save failure are separate', async t => {
  const f = await fixture(t), runtime = createLocalHostRuntime(f.config);
  t.after(() => runtime.close());
  const preview = await runtime.controller.prepare();
  await runtime.controller.execute(preview, preview.confirmation);
  const path = join(f.directory, BINDING_RECEIPTS_FILE), text = await readFile(path, 'utf8');
  const archive = JSON.parse(text), record = archive.records[0];
  assert.deepEqual(Object.keys(record).sort(), ['version', 'endpoint', 'subjectId', 'installationId', 'bindingId', 'scopes', 'bindingExpiresAt', 'receipt', 'receivedAt'].sort());
  assert.equal(/PRIVATE KEY|credential|clientSession/.test(text), false);
  runtime.controller.disconnect(); runtime.close();
  const restarted = createLocalHostRuntime(f.config); t.after(() => restarted.close());
  assert.equal((await restarted.controller.status()).state, 'no-session');
  const history = await restarted.controller.listBindingReceipts();
  assert.equal(history.records.length, 1); assert.equal(history.records[0].verification, 'signature-verified-at-recorded-time');
  assert.equal(history.records[0].configurationMatches, true); assert.equal(history.records[0].authorized, false);
  assert.equal(f.calls(), 4); // Reads and restart never contact the service.
  await saveConnectionProfile(f.directory, revokeConnectionScope(f.profile, 'bind'));
  assert.equal((await restarted.controller.listBindingReceipts()).records.length, 1);
  await saveConnectionProfile(f.directory, f.profile);
  f.setTime(f.f.now + 90001);
  assert.equal((await restarted.controller.listBindingReceipts()).records[0].lifetime, 'expired');
  f.setTime(f.f.now); f.config.trustedKeys.get('fixture').revoked = true;
  assert.equal((await restarted.controller.listBindingReceipts()).records[0].verification, 'unverified');
  f.config.trustedKeys.get('fixture').revoked = false;
  archive.records[0].scopes = ['binding']; await writeFile(path, JSON.stringify(archive));
  assert.equal((await restarted.controller.listBindingReceipts()).records[0].verification, 'unverified');
  await writeFile(path, '{invalid');
  const next = await restarted.controller.prepare();
  const state = await restarted.controller.execute(next, next.confirmation);
  assert.equal(state.state, 'session-local'); assert.equal(f.calls(), 8);
  assert.equal((await restarted.controller.status()).receiptSaveState, 'save-failed');
  await assert.rejects(restarted.controller.listBindingReceipts());
  assert.equal(await readFile(path, 'utf8'), '{invalid');
});

test('host publishes a real local draft using its local key and records acknowledgement', async t => {
  const f = await fixture(t);
  const local = await createCaseDraft(f.directory, { title: 'Host publication', failureSummary: 'Local build failed' });
  let runtime = createLocalHostRuntime(f.config);
  try {
    const connection = await runtime.controller.prepare();
    await runtime.controller.execute(connection, connection.confirmation);
    assert.equal((await runtime.controller.listPublicationDrafts())[0].localCaseId, local.id);
    const preview = await runtime.controller.preparePublication(local.id, { visibility: 'Public' });
    await assert.rejects(runtime.controller.queryHistory({}), /unavailable/);
    const receipt = await runtime.controller.executePublication(preview, preview.confirmation);
    assert.equal(receipt.eventId, preview.eventId);
    assert.equal((await runtime.controller.listPublicationDrafts())[0].status, 'acknowledged');
    const history = await f.f.history.query(null, { query: 'Host publication' });
    assert.equal(history.items.length, 1); assert.equal(history.items[0].summary, 'Local build failed');
    const assistance = await runtime.controller.prepareCollaboration({ request: { caseId: receipt.caseId, title: 'Real local signer',
      problem: 'Need help', attemptedApproaches: [], scope: 'Inspect', visibility: 'Public', collaboration: 'open-assistance',
      enrollmentExpiresAt: f.f.now + 1800 } });
    assert.equal((await f.f.db.query('SELECT * FROM assistance_requests')).rows.length, 0);
    const published = await runtime.controller.executeCollaboration(assistance, assistance.confirmation);
    assert.equal(published.assistanceId, assistance.assistanceId);
    const listed = await runtime.controller.queryAssistance({ view: 'requested' });
    assert.equal(listed.items[0].assistanceId, published.assistanceId);
    const localActor = (await runtime.controller.status()).subjectId;
    const offer = { id: randomUUID(), expectedVersion: 1, kind: 'offer', proposal: 'Assist fixture', scope: 'Inspect' };
    await f.f.assistance.submit(f.f.actor, published.assistanceId, await f.f.authorize({ assistanceId: published.assistanceId, event: offer },
      'assistance.publish', { objectId: offer.id, viewers: [localActor] }));
    const selected = await runtime.controller.prepareCollaboration({ assistanceId: published.assistanceId, event: { kind: 'select', offerId: offer.id } });
    await runtime.controller.executeCollaboration(selected, selected.confirmation);
    const confirmedEvent = { id: randomUUID(), expectedVersion: 3, kind: 'confirm' };
    await f.f.assistance.submit(f.f.actor, published.assistanceId, await f.f.authorize({ assistanceId: published.assistanceId, event: confirmedEvent },
      'assistance.publish', { objectId: confirmedEvent.id, viewers: [localActor] }));
    let materialDraft=await runtime.controller.createContextDraft(await runtime.controller.getAssistance(published.assistanceId));
    const contextPath=join(f.directory,'synthetic-context.log');
    await writeFile(contextPath,'Unselected runtime line.\nSynthetic compiler diagnostic.\nUnselected trailing line.');
    const contextSelection=await runtime.controller.previewContextFile({id:materialDraft.id,expectedRevision:materialDraft.revision,path:contextPath,startLine:2,endLine:2});
    assert.equal((await runtime.controller.getContextDraft(materialDraft.id)).content.materials[0].content,'');
    materialDraft=await runtime.controller.saveContextDraft({id:materialDraft.id,expectedRevision:materialDraft.revision,
      content:{...materialDraft.content,step:'overview',materials:materialDraft.content.materials.map(item=>({...item,label:contextSelection.label,content:contextSelection.content}))}});
    const material = await runtime.controller.prepareContext({ kind: 'grant', assistanceId: published.assistanceId,
      draftId:materialDraft.id,draftRevision:materialDraft.revision });
    assert.equal((await f.f.db.query('SELECT * FROM context_grants')).rows.length, 0);
    const materialReceipt = await runtime.controller.executeContext(material, material.confirmation);
    assert.equal((await runtime.controller.getContext(materialReceipt.grantId)).materials[0].content, 'Synthetic compiler diagnostic.');
    assert.ok(!material.payloadJson.includes(contextPath));
    assert.equal((await runtime.controller.getContextDraft(materialDraft.id)).status,'prepared');
    assert.equal((await runtime.controller.listContextOperations()).items[0].status,'acknowledged');
    assert.equal((await runtime.controller.reconcileContext(material.eventId)).state,'acknowledged');
    const canceled = await runtime.controller.prepareCollaboration({ assistanceId: published.assistanceId, event: { kind: 'cancel', reason: 'Fixture completed' } });
    await runtime.controller.executeCollaboration(canceled, canceled.confirmation);
    assert.equal((await runtime.controller.getAssistance(published.assistanceId)).state, 'canceled');
    const inbox = await runtime.controller.queryNotifications({}); assert.ok(inbox.items.some(item => item.eventKind === 'offer'));
    await runtime.controller.markNotificationRead(inbox.items[0].id);
    const preferences = await runtime.controller.notificationPreferences();
    await runtime.controller.saveNotificationPreferences({ expectedRevision: preferences.revision, settings: { ...preferences.settings, materials: false } });
    assert.equal((await runtime.controller.notificationPreferences()).settings.materials, false);
    const requesterHistory = await runtime.controller.queryRequesterHistory({});
    assert.equal(requesterHistory.items[0].requesterId, localActor); assert.equal(requesterHistory.counts.cancellations, 1);
    assert.equal((await runtime.controller.qualificationPolicies()).policies.length, 0);
    assert.equal((await runtime.controller.honorRules()).rules.length, 0);
    f.f.moderation.moderatorIds = [f.f.actor.subjectId];
    const report = await runtime.controller.prepareModeration({kind:'report',assistanceId:published.assistanceId,category:'other',summary:'Runtime signed report'});
    await runtime.controller.executeModeration(report,report.confirmation);
    assert.equal((await runtime.controller.getModeration(report.reportId)).report.summary,'Runtime signed report');
    for (const type of ['worker','bridge','hub']) {
      const declaration = builderDeclaration(type,localActor);
      const builder = await runtime.controller.prepareBuilder({kind:'declare',declaration,visibility:'Public'});
      assert.equal((await f.f.builders.query(null,{ownerId:localActor,type})).items.length,0);
      const registered = await runtime.controller.executeBuilder(builder,builder.confirmation);
      const current = await runtime.controller.getBuilder({builderId:registered.builderId});
      assert.equal(current.declaration.name,declaration.name);assert.equal(current.ownerId,localActor);
      if (type === 'worker') {
        const control=await runtime.controller.prepareBuilder({kind:'node-control',builderId:registered.builderId});
        await runtime.controller.executeBuilder(control,control.confirmation);
        assert.equal((await runtime.controller.getBuilder({builderId:registered.builderId})).nodeControl.state,'node-authorized-owner');
        const canceledProof=await runtime.controller.prepareNodeControlProof({builderId:registered.builderId,controlId:control.eventId});
        runtime.controller.cancel();await assert.rejects(runtime.controller.executeNodeControlProof(canceledProof,canceledProof.confirmation));
        assert.ok(!(await readdir(f.directory)).some(name=>name.startsWith('galaxy-node-control-proof-')));
        const proofPreview=await runtime.controller.prepareNodeControlProof({builderId:registered.builderId,controlId:control.eventId});
        const exported=await runtime.controller.executeNodeControlProof(proofPreview,proofPreview.confirmation);
        const portable=JSON.parse(await readFile(exported.path,'utf8'));
        assert.equal((await verifyNodeControlProof(portable,{endpoint:f.config.endpoint,trustedKeys:f.config.trustedKeys,now:f.f.now,builderId:registered.builderId,controlId:control.eventId})).nodeSignatureVerified,true);
        assert.equal(exported.currentRevocationChecked,false);assert.ok(exported.path.startsWith(f.directory));
        const revokedControl=await runtime.controller.prepareBuilder({kind:'node-control-revoke',builderId:registered.builderId,reason:'Fixture'});
        await runtime.controller.executeBuilder(revokedControl,revokedControl.confirmation);
        assert.equal((await runtime.controller.getBuilder({builderId:registered.builderId})).nodeControl.state,'revoked');
      }
      const heartbeat = await runtime.controller.prepareBuilder({kind:'heartbeat',builderId:registered.builderId,baseDeclarationId:current.declarationId});
      await runtime.controller.executeBuilder(heartbeat,heartbeat.confirmation);
      assert.equal((await runtime.controller.getBuilder({builderId:registered.builderId})).reachability.state,'recent-owner-heartbeat');
    }
    const source={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Capsule source',summary:'Synthetic',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.f.actor.subjectId,role:'requester'}]};
    await f.f.cases.submit(f.f.actor,await f.f.authorize(source));
    const sourceAttempt={id:randomUUID(),kind:'attempt',caseId:source.id,expectedVersion:1,sequence:1,approach:'Fixture',configuration:{environment:'test',version:'1',tools:[]}};
    await f.f.cases.submit(f.f.actor,await f.f.authorize(sourceAttempt));
    const sourceResult={id:randomUUID(),kind:'result',caseId:source.id,expectedVersion:2,attemptId:sourceAttempt.id,outcome:'succeeded',summary:'Fixture',failureReason:'',limitations:['Synthetic']};
    await f.f.cases.submit(f.f.actor,await f.f.authorize(sourceResult));
    const capsule={id:randomUUID(),capsuleId:randomUUID(),kind:'version',expectedRevision:0,version:1,title:'Runtime Capsule',problemPattern:'Fixture',environment:{name:'test',version:'1'},solutionStrategy:'Fixture strategy',tools:[],skills:[],mcpRefs:[],verificationMethod:'Author reported',limitations:['Synthetic'],capabilityId:'compiler',applicableScope:'Fixture',license:'MIT',contributors:[],sourceResolution:{caseId:source.id,resultId:sourceResult.id,proofIds:[]},redactionConfirmed:true};
    await f.f.capsules.publish(f.f.actor,await f.f.authorize(capsule,'capsule.publish',{visibility:'Public',purpose:'public-profile'}));
    const cited=await runtime.controller.prepareCapsule({kind:'reference',capsuleId:capsule.capsuleId,versionId:capsule.id,caseId:receipt.caseId,note:'Use as reference'});
    await runtime.controller.executeCapsule(cited,cited.confirmation);
    assert.equal((await runtime.controller.capsuleUses({caseId:receipt.caseId})).counts.references,1);
    runtime.close();runtime=createLocalHostRuntime(f.config);
    assert.equal((await runtime.controller.getContextDraft(materialDraft.id)).content.materials[0].content,'Synthetic compiler diagnostic.');
    assert.equal((await runtime.controller.status()).state,'no-session');
    const reconnect=await runtime.controller.prepare();await runtime.controller.execute(reconnect,reconnect.confirmation);
    assert.equal((await runtime.controller.reconcileContext(material.eventId)).state,'acknowledged');
    await assert.rejects(runtime.controller.getContext(material.grantId),/collaboration_changed/);
  } finally { runtime.close(); }
});

test('local Assistance drafts and exact retries reconnect using the actual local signer',async t=>{
  const f=await fixture(t),send=f.config.assistanceSend;let drop=false;
  f.config.assistanceSend=async(url,options)=>{
    const result=await send(url,options);
    if(drop&&new URL(url).pathname==='/v1/assistance'){drop=false;throw new Error('Synthetic lost Assistance acknowledgement');}
    return result;
  };
  let runtime=createLocalHostRuntime(f.config);t.after(()=>runtime.close());
  let draft=await runtime.controller.createAssistanceDraft();
  draft=await runtime.controller.saveAssistanceDraft({id:draft.id,expectedRevision:draft.revision,content:{...draft.content,values:{title:'Runtime recovery',hours:'24'},index:2}});
  assert.equal(f.calls(),0);
  runtime.close();runtime=createLocalHostRuntime(f.config);
  assert.equal((await runtime.controller.getAssistanceDraft(draft.id)).content.values.title,'Runtime recovery');
  const connect=async()=>{const p=await runtime.controller.prepare();await runtime.controller.execute(p,p.confirmation);};
  await connect();
  const local=await createCaseDraft(f.directory,{title:'Recovery source',failureSummary:'Synthetic failure'});
  const publication=await runtime.controller.preparePublication(local.id,{visibility:'Public'});
  const published=await runtime.controller.executePublication(publication,publication.confirmation);
  const preview=await runtime.controller.prepareCollaboration({draftId:draft.id,draftRevision:draft.revision,
    request:{id:draft.id,caseId:published.caseId,title:'Runtime recovery',problem:'Compiler fails',attemptedApproaches:[],scope:'Inspect',
      visibility:'Public',collaboration:'open-assistance',enrollmentExpiresAt:f.f.now+1800}});
  drop=true;await assert.rejects(runtime.controller.executeCollaboration(preview,preview.confirmation),/lost Assistance/);
  runtime.close();runtime=createLocalHostRuntime(f.config);
  assert.equal((await runtime.controller.listCollaborationOperations()).items[0].status,'unknown');
  await connect();assert.equal((await runtime.controller.reconcileCollaboration(preview.eventId)).state,'acknowledged');
  await assert.rejects(runtime.controller.prepareCollaborationRetry(preview.eventId),/acknowledged/);
  assert.equal((await f.f.db.query('SELECT id FROM assistance_requests WHERE id=$1',[draft.id])).rows.length,1);
  assert.equal((await runtime.controller.getAssistance(draft.id)).contextAccessGranted,false);
  let eventDraft=await runtime.controller.createAssistanceEventDraft({record:await runtime.controller.getAssistance(draft.id),eventKind:'cancel'});
  eventDraft=await runtime.controller.saveAssistanceDraft({id:eventDraft.id,expectedRevision:eventDraft.revision,
    content:{...eventDraft.content,values:{reason:'Runtime cancellation draft'},step:'review'}});
  runtime.close();runtime=createLocalHostRuntime(f.config);await connect();
  eventDraft=await runtime.controller.getAssistanceDraft(eventDraft.id);
  const cancel=await runtime.controller.prepareCollaboration({draftId:eventDraft.id,draftRevision:eventDraft.revision,
    assistanceId:draft.id,event:{kind:'cancel'}});
  assert.equal(cancel.eventId,eventDraft.id);
  await runtime.controller.executeCollaboration(cancel,cancel.confirmation);
  assert.equal((await runtime.controller.getAssistance(draft.id)).state,'canceled');
  await runtime.controller.forgetCollaborationOperation(cancel.eventId);
  await runtime.controller.forgetCollaborationOperation(preview.eventId);
  assert.equal((await runtime.controller.listAssistanceDrafts()).items.length,0);
});

test('local Builder management and durable retry reconnect using the actual local signer',async t=>{
  const f=await fixture(t),send=f.config.builderSend;let drop=false,ownerActor;
  f.config.builderSend=async(url,options)=>{ownerActor=await f.f.access.authenticate(options.credential,'builders');if(drop&&new URL(url).pathname==='/v1/builders/events'){drop=false;throw new Error('Synthetic offline event');}return send(url,options);};
  let runtime=createLocalHostRuntime(f.config);t.after(()=>runtime.close());
  const connect=async()=>{const p=await runtime.controller.prepare();await runtime.controller.execute(p,p.confirmation);};
  await connect();const subjectId=(await runtime.controller.status()).subjectId;
  const original=await runtime.controller.prepareBuilder({kind:'declare',declaration:builderDeclaration('worker',subjectId),visibility:'Public'});
  drop=true;await assert.rejects(runtime.controller.executeBuilder(original,original.confirmation),/offline event/);
  runtime.close();runtime=createLocalHostRuntime(f.config);
  assert.equal((await runtime.controller.listBuilderOperations()).items[0].status,'unknown');
  await connect();const retry=await runtime.controller.prepareBuilderRetry(original.eventId);
  assert.equal(retry.payloadJson,original.payloadJson);assert.notEqual(JSON.parse(retry.intentJson).bindingId,JSON.parse(original.intentJson).bindingId);
  await runtime.controller.executeBuilder(retry,retry.confirmation);
  assert.equal((await runtime.controller.reconcileBuilder(original.eventId)).state,'acknowledged');
  await f.f.consents.revoke(ownerActor,JSON.parse(retry.intentJson).id);
  const owned=await runtime.controller.queryOwnedBuilders({});assert.equal(owned.items[0].name,null);
  const current=await runtime.controller.getBuilderManagement({builderId:original.builderId});assert.equal(current.declaration,null);
  const maintenance=await runtime.controller.prepareBuilder({kind:'maintenance',builderId:original.builderId,management:true,
    baseDeclarationId:current.declarationId,baseRevision:current.revision,action:'delist',summary:'Owner withdrew old release',visibility:'Public'});
  assert.equal(JSON.parse(maintenance.payloadJson).declaration,undefined);
  await runtime.controller.executeBuilder(maintenance,maintenance.confirmation);
  assert.equal((await runtime.controller.queryBuilderNotices({builderId:original.builderId})).items[0].action,'delist');
  const stored=await readFile(join(f.directory,'galaxy-local-state.json'),'utf8');assert.ok(stored.includes(original.eventId));assert.equal(stored.includes('PRIVATE KEY'),false);
});

test('preview does not read the private key; mismatched key cannot produce a binding response', async t => {
  const f = await fixture(t);
  const keyPath = join(f.directory, 'galaxy-id-private-key.pem');
  const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  await writeFile(keyPath, key);
  const runtime = createLocalHostRuntime(f.config);
  const preview = await runtime.controller.prepare(); assert.equal(f.calls(), 0);
  await assert.rejects(runtime.controller.execute(preview, preview.confirmation), /key mismatch/);
  assert.equal(f.calls(), 1); runtime.close();
  await rm(keyPath);
  const second = createLocalHostRuntime(f.config);
  await second.controller.prepare(); assert.equal(f.calls(), 1); second.close();
});

test('reset, scope revocation, pin revocation and manifest expiry stop connection after a pending response', async t => {
  const f = await fixture(t);
  for (const action of ['scope', 'pin', 'expiry', 'reset']) {
    f.config.trustedKeys.get('fixture').revoked = false; f.setTime(f.f.now);
    await saveConnectionProfile(f.directory, f.profile);
    const runtime = createLocalHostRuntime(f.config);
    const preview = await runtime.controller.prepare(), calls = f.calls();
    f.afterSend(async () => {
      if (action === 'scope') await saveConnectionProfile(f.directory, revokeConnectionScope(f.profile, 'bind'));
      if (action === 'pin') f.config.trustedKeys.get('fixture').revoked = true;
      if (action === 'expiry') f.setTime(f.f.now + 301);
      if (action === 'reset') await resetGalaxyIntegration(f.directory);
    });
    await assert.rejects(runtime.controller.execute(preview, preview.confirmation));
    assert.equal(f.calls(), calls + 1); runtime.close();
  }
});

test('uninitialized directory stays empty and an invalid manifest cannot dispatch', async t => {
  const f = await fixture(t);
  const empty = join(f.directory, 'absent');
  const runtime = createLocalHostRuntime({ ...f.config, dataDirectory: empty });
  await assert.rejects(runtime.controller.prepare());
  await assert.rejects(readdir(empty), { code: 'ENOENT' }); assert.equal(f.calls(), 0); runtime.close();
  const invalid = createLocalHostRuntime({ ...f.config, manifest: { signed: 'invalid' } });
  await assert.rejects(invalid.controller.prepare()); assert.equal(f.calls(), 0); invalid.close();
});

test('native audit approval signs the existing local identity only after confirmation and preserves identity bytes', async t => {
  const f = await fixture(t), runtime = createLocalHostRuntime(f.config);
  const key = await readFile(join(f.directory, 'galaxy-id-private-key.pem'));
  const state = await readFile(join(f.directory, 'galaxy-local-state.json'));
  try {
    const connection = await runtime.controller.prepare();
    const status = await runtime.controller.execute(connection, connection.confirmation);
    f.f.audit.reviewerIds = [status.subjectId]; f.f.audit.readerIds = [f.f.actor.subjectId];
    const input = { readerId: f.f.actor.subjectId, subjectIds: [f.f.actor.subjectId], actions: ['query', 'export'],
      reasonCode: 'native-review-001', lifetimeSeconds: 300 };
    const canceled = await runtime.controller.prepareAudit(input);
    assert.equal((await f.f.db.query('SELECT * FROM audit_access_grants')).rows.length, 0);
    runtime.controller.cancel(); await assert.rejects(runtime.controller.executeAudit(canceled, canceled.confirmation));
    const preview = await runtime.controller.prepareAudit(input);
    const result = await runtime.controller.executeAudit(preview, preview.confirmation);
    assert.equal(result.approved, true);
    const grants = await runtime.controller.readAudit('grants'); assert.equal(grants.items[0].reviewerId, status.subjectId);
    assert.equal((await runtime.controller.readAudit('query')).view, 'owner');
    await runtime.controller.readAudit('revoke', { id: result.id });
    assert.equal((await runtime.controller.readAudit('grants')).items[0].revoked, true);
    assert.deepEqual(await readFile(join(f.directory, 'galaxy-id-private-key.pem')), key);
    assert.deepEqual(await readFile(join(f.directory, 'galaxy-local-state.json')), state);
  } finally { runtime.close(); }
});


test('remote binding lifetime cannot exceed the local intent and unlisted fields cannot be sent', async t => {
  const f = await fixture(t);
  f.profile.scopes[0].expiresAt = new Date((f.f.now + 3600) * 1000).toISOString();
  await saveConnectionProfile(f.directory, f.profile);
  const runtime = createLocalHostRuntime(f.config);
  const preview = await runtime.controller.prepare();
  await assert.rejects(runtime.controller.execute(preview, preview.confirmation), /lifetime/);
  assert.equal(f.calls(), 1); runtime.close();
  f.profile.scopes[0].visibleFields = ['subjectId'];
  await saveConnectionProfile(f.directory, f.profile);
  const limited = createLocalHostRuntime(f.config);
  await assert.rejects(limited.controller.prepare()); assert.equal(f.calls(), 1); limited.close();
});

test('native deletion intake uses the existing local key after preview and can query and cancel without changing identity bytes', async t => {
  const f=await fixture(t),runtime=createLocalHostRuntime(f.config);
  const key=await readFile(join(f.directory,'galaxy-id-private-key.pem')),state=await readFile(join(f.directory,'galaxy-local-state.json'));
  try {
    const connection=await runtime.controller.prepare();await runtime.controller.execute(connection,connection.confirmation);
    const input={action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'};
    const preview=await runtime.controller.prepareDeletion(input);
    assert.equal((await f.f.db.query('SELECT * FROM deletion_requests')).rows.length,0);
    const requested=await runtime.controller.executeDeletion(preview,preview.confirmation);
    assert.equal(requested.state,'requested');
    const details=await runtime.controller.readDeletion('read',{id:requested.id});assert.equal(details.events.length,1);
    const cancel=await runtime.controller.prepareDeletion({action:'cancel',requestId:requested.id,expectedRevision:requested.revision});
    assert.equal((await runtime.controller.executeDeletion(cancel,cancel.confirmation)).state,'cancelled');
    runtime.controller.disconnect();
    const lookup=await runtime.controller.prepareDeletionStatus({requestId:requested.id});
    assert.equal((await runtime.controller.executeDeletionStatus(lookup,lookup.confirmation)).state,'cancelled');
    runtime.controller.cancel();
    assert.deepEqual(await readFile(join(f.directory,'galaxy-id-private-key.pem')),key);
    assert.deepEqual(await readFile(join(f.directory,'galaxy-local-state.json')),state);
  }finally{runtime.close();}
});
