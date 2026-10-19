import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { oidcProviderFixture } from './oidc-provider-fixture.mjs';
import { createOidcLoginProvider } from '../src/oidc-login.mjs';
import { createApi } from '../src/http.mjs';
import { browserScopes } from '../src/browser-client.mjs';
import { createExistingWebRuntime, confirmFixtureAccountLink } from './existing-web-identity-fixture.mjs';
import { createTargetGovernanceClientV2 } from '../src/target-governance-client-v2.mjs';

// Diagnostic only: actual synthetic OIDC/PKCE/JWS verified Account, WebRuntime,
// signed Consent, HTTP/PGlite; explicit Map completion fault, no physical IDB,
// real user, OS notification, external host or model/Agent session.
async function fixture() {
  const endpoint = 'https://official.example.org', now = Math.floor(Date.now() / 1000);
  const issuer = await oidcProviderFixture([endpoint + '/v1/identity/callback/fixture'], { emailVerified: true });
  const values = new Map(), counts = { consents: 0, reports: 0 }; let f, server, runtime, loseAck = false;
  const close = async () => { runtime?.close(); if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); } await f?.db.close(); await issuer.close(); };
  try {
    const provider = await createOidcLoginProvider({ id: 'fixture', name: 'Synthetic OIDC', issuer: issuer.issuer,
      clientId: 'galaxy-fixture', redirectUri: endpoint + '/v1/identity/callback/fixture', allowLoopbackHttp: true, now: () => now });
    f = await serviceFixture(browserScopes, null, { now, identityProviders: [provider], syntheticCommunityQuota: false });
    server = createApi({ ...f, browserOrigins: ['https://galaxy.example.org'], rateLimit: 1000 });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const local = 'http://127.0.0.1:' + server.address().port;
    runtime = await createExistingWebRuntime({ endpoint, trustedKeys: f.bindings.trustedKeys }, {
      now: () => now,
      store: { get: async key => structuredClone(values.get(key)), put: async (key, value) => values.set(key, structuredClone(value)),
       update:async(key,change)=>{const value=change(structuredClone(values.get(key)));values.set(key,structuredClone(value));return structuredClone(value);} },
      fetch: async (url, options) => {
        const parsed = new URL(url), path = parsed.pathname;
        if (path === '/v1/consents') counts.consents++;
        if (path === '/v2/target-governance/reports') counts.reports++;
        const response = await fetch(local + path + parsed.search, { ...options, headers: { ...options.headers, Origin: 'https://galaxy.example.org' } });
        if (loseAck && path === '/v2/target-governance/reports' && response.status === 200) {
          loseAck = false; await response.arrayBuffer(); throw Error('synthetic caller lost ACK after governance report accepted');
        }
        return response;
      },
    });
    await runtime.connect({ confirmed: true });
    issuer.setAccount('synthetic-M24-consumer-owner');
    const start = await runtime.api.call('/v1/identity/begin', { providerId: 'fixture' });
    const callback = await issuer.authorize(start.authorizationUrl);
    const response = await fetch(local + callback.pathname + callback.search);
    assert.equal(response.status, 200); await response.arrayBuffer(); await confirmFixtureAccountLink(runtime, start.loginId);
    assert.equal((await runtime.api.call('/v2/account/quotas', {})).accountVerified, true);
    // The Task is an independently signed HTTP source fixture. This test
    // exercises governance continuity, not the Web task/Agent creation journey.
    const taskPayload = { operationId:randomUUID(),taskId:randomUUID(),caseId: null, intent: 'proactive-review',
      workContext: { goal: 'Synthetic limited governance', currentSituation: 'No fabricated failure', attemptRefs: [] },
      title: 'Synthetic M24 consumer', summary: 'Fictional bounded diagnostic', visibility: 'Private',
      collaboration: 'open-assistance', enrollmentExpiresAt: now + 3600 };
    const task = await runtime.api.call('/v2/tasks',await runtime.api.authorizePayload(taskPayload,{action:'assistance.publish',objectId:taskPayload.operationId,confirmed:true}));
    const target = await runtime.api.call('/v2/target-governance/target', { type: 'task', id: task.taskId });
    const payload = { schemaVersion: 2, id: randomUUID(), target: target.target, category: 'privacy', summary: 'Synthetic private M24 complaint sentinel' };
    const base = { api: runtime.api, getLocal: runtime.getLocal, putLocal: runtime.putLocal, subjectId: runtime.api.snapshot().subjectId };
    return { f, runtime, values, counts, payload, base, close, dropNextAck: () => { loseAck = true; } };
  } catch (error) { await close(); throw error; }
}

test('M24 original confirmed report must not be resigned or dispatched after same GUID reconnects during local read completion', async () => {
  const f = await fixture(); let switched = false, after;
  try {
    const before = f.runtime.api.snapshot(), baseline = { ...f.counts };
    const client = createTargetGovernanceClientV2({ ...f.base, getLocal: async key => {
      const result = await f.runtime.getLocal(key);
      if (!switched) { switched = true; f.runtime.api.disconnect(); await f.runtime.connect({ confirmed: true }); after = f.runtime.api.snapshot(); }
      return result;
    } });
    const preview = await client.prepare('report', f.payload);
    let result, error; try { result = await client.execute(preview, { confirmed: true }); } catch (caught) { error = caught; }
    const accepted = (await f.f.db.query('SELECT count(*)::int n FROM target_governance_events_v2 WHERE id=$1', [f.payload.id])).rows[0].n;
    const observation = { actualWebRuntime: true, actualSignedHttp: true, database: 'PGlite', account: 'verified synthetic OIDC/PKCE/JWS', syntheticCommunityQuota: false,
      storage: 'Map completion contract double, not physical IDB', modelTurns: 0, sameSubject: before.subjectId === after?.subjectId,
      bindingChanged: before.bindingId !== after?.bindingId, generationChanged: before.generation !== after?.generation,
      newConsentPosts: f.counts.consents - baseline.consents, newReportPosts: f.counts.reports - baseline.reports, acceptedEvents: accepted,
      returnedState: result?.state ?? null, rejected: !!error, originalLocatorRetained: [...f.values.values()].some(value => value?.active?.operationId === f.payload.id) };
    assert.equal(switched, true); assert.equal(observation.sameSubject, true); assert.equal(observation.bindingChanged, true); assert.equal(observation.generationChanged, true);
    assert.equal(observation.newConsentPosts, 0, 'old exact confirmation cannot authorize a replacement binding');
    assert.equal(observation.newReportPosts, 0); assert.equal(accepted, 0);
  } finally { await f.close(); }
});

test('M24 private pending report response must be withheld after same GUID reconnects during local read completion', async () => {
  const f = await fixture(); let switched = false, after;
  try {
    const original = createTargetGovernanceClientV2(f.base), preview = await original.prepare('report', f.payload);
    f.dropNextAck(); await assert.rejects(original.execute(preview, { confirmed: true }), /lost ACK/);
    assert.equal((await f.f.db.query('SELECT count(*)::int n FROM target_governance_events_v2 WHERE id=$1', [f.payload.id])).rows[0].n, 1);
    const before = f.runtime.api.snapshot(), baseline = { ...f.counts };
    const client = createTargetGovernanceClientV2({ ...f.base, getLocal: async key => {
      const result = await f.runtime.getLocal(key);
      if (!switched) { switched = true; f.runtime.api.disconnect(); await f.runtime.connect({ confirmed: true }); after = f.runtime.api.snapshot(); }
      return result;
    } });
    let result, error; try { result = await client.pending(); } catch (caught) { error = caught; }
    const bodyReturned = result?.some(item => item.payload?.summary === f.payload.summary) === true;
    const observation = { actualWebRuntime: true, actualSignedHttp: true, database: 'PGlite', account: 'verified synthetic OIDC/PKCE/JWS', syntheticCommunityQuota: false,
      storage: 'Map completion contract double, not physical IDB', modelTurns: 0, sameSubject: before.subjectId === after?.subjectId,
      bindingChanged: before.bindingId !== after?.bindingId, generationChanged: before.generation !== after?.generation,
      privateBodyReturned: bodyReturned, withheld: !!error, acceptedEvents: 1,
      newConsentPosts: f.counts.consents - baseline.consents, newReportPosts: f.counts.reports - baseline.reports,
      originalLocatorRetained: [...f.values.values()].some(value => value?.active?.operationId === f.payload.id) };
    assert.equal(switched, true); assert.equal(observation.sameSubject, true); assert.equal(observation.bindingChanged, true);
    assert.equal(bodyReturned, false, 'old confirmed complaint body cannot escape a late replaced lease');
    assert.equal(observation.originalLocatorRetained, true); assert.equal(observation.newReportPosts, 0);
  } finally { await f.close(); }
});

test('M24 old previews cannot inherit reconnects; lost ACK reloading queries the original body-free locator without new Consent', async () => {
 const f=await fixture();
 try{
  const client=createTargetGovernanceClientV2({...f.base,receiptStatus:f.runtime.receiptStatus});
  const old=await client.prepare('report',f.payload),baseline={...f.counts};
  f.runtime.api.disconnect();await f.runtime.connect({confirmed:true});
  await assert.rejects(async()=>client.execute(old,{confirmed:true}),/改变|changed/);
  assert.deepEqual(f.counts,baseline);
  const current=await client.prepare('report',f.payload);
  assert.equal(current.payloadHash,old.payloadHash);assert.equal(current.payloadJson,old.payloadJson);
  f.dropNextAck();await assert.rejects(client.execute(current,{confirmed:true}),/lost ACK/);
  const active=[...f.values.values()].find(value=>value?.active?.operationId===f.payload.id).active;
  const original={id:active.operationId,hash:active.payloadHash,bytes:active.payloadJson};
  assert.equal(original.hash,old.payloadHash);assert.equal(original.bytes,old.payloadJson);
  const accepted=(await f.f.db.query('SELECT payload_hash,payload_text FROM target_governance_events_v2 WHERE id=$1',[original.id])).rows[0];
  assert.equal(accepted.payload_hash,original.hash);assert.equal(accepted.payload_text,original.bytes);
  f.runtime.api.disconnect();await f.runtime.connect({confirmed:true});
  const fresh=createTargetGovernanceClientV2({...f.base,receiptStatus:f.runtime.receiptStatus}),before={...f.counts};
  const receipt=await fresh.reconcile(original.id);
  assert.equal(receipt.state,'acknowledged');assert.equal(receipt.eventId,original.id);
  assert.deepEqual(f.counts,before);assert.deepEqual(await fresh.pending(),[]);
  const journal=[...f.values.values()].find(value=>value?.stopped?.some(item=>item.operationId===original.id));
  assert.equal(journal.active,null);assert.deepEqual(journal.stopped.find(item=>item.operationId===original.id),
   {operationId:original.id,type:'report',payloadHash:original.hash,state:'acknowledged'});
  assert.equal(JSON.stringify(journal).includes(f.payload.summary),false);
  assert.equal((await fresh.reconcile(original.id)).state,'acknowledged');assert.deepEqual(f.counts,before);
 }finally{await f.close();}
});

test('M24 an ACK persisted before a reconnect is withheld from the old call but its exact locator remains queryable',async()=>{
 const f=await fixture();let switched=false;
 try{
  const client=createTargetGovernanceClientV2({...f.base,receiptStatus:f.runtime.receiptStatus,putLocal:async(key,value)=>{
   await f.runtime.putLocal(key,value);
   if(!switched&&value.active===null&&value.stopped.some(item=>item.state==='acknowledged')){
    switched=true;f.runtime.api.disconnect();await f.runtime.connect({confirmed:true});
   }
  }});
  const preview=await client.prepare('report',f.payload);
  await assert.rejects(client.execute(preview,{confirmed:true}),/改变|changed/);assert.equal(switched,true);
  const journal=[...f.values.values()].find(value=>value?.stopped?.some(item=>item.operationId===f.payload.id));
  assert.equal(journal.active,null);assert.equal(journal.stopped[0].payloadHash,preview.payloadHash);
  assert.equal(JSON.stringify(journal).includes(f.payload.summary),false);
  const before={...f.counts},fresh=createTargetGovernanceClientV2({...f.base,receiptStatus:f.runtime.receiptStatus});
  assert.equal((await fresh.reconcile(f.payload.id)).state,'acknowledged');
  assert.deepEqual(f.counts,before);
 }finally{await f.close();}
});

test('M24 explicit reauthorization keeps original bytes and ID; a late replacement binding cannot sign the old confirmation',async()=>{
 const f=await fixture();
 try{
  const client=createTargetGovernanceClientV2({...f.base,receiptStatus:f.runtime.receiptStatus,api:{
   ...f.runtime.api,submitAuthorization:async()=>{throw Error('synthetic pre-dispatch Consent failure');},
  }});
  const preview=await client.prepare('report',f.payload);
  await assert.rejects(client.execute(preview,{confirmed:true}),/pre-dispatch/);
  const journal=()=>[...f.values.values()].find(value=>value?.active?.operationId===f.payload.id);
  const original=structuredClone(journal().active),baseline={...f.counts};
  assert.equal((await f.runtime.api.reconcileAuthorization(original.prepared)).state,'absent');
  f.runtime.api.disconnect();await f.runtime.connect({confirmed:true});
  let invalidate=false;
  const late=createTargetGovernanceClientV2({...f.base,receiptStatus:f.runtime.receiptStatus,api:{
   ...f.runtime.api,reconcileAuthorization:async saved=>{
    const result=await f.runtime.api.reconcileAuthorization(saved);
    if(invalidate){invalidate=false;f.runtime.api.disconnect();await f.runtime.connect({confirmed:true});}
    return result;
   },
  }});
  const renewed=await late.reviewAuthorization(original.operationId);
  assert.equal(renewed.state,'reauthorization-required');assert.equal(renewed.payloadHash,original.payloadHash);
  invalidate=true;await assert.rejects(late.reauthorize(renewed,{confirmed:true}),/改变|changed/);
  assert.deepEqual(f.counts,baseline);assert.equal(journal().active.prepared.intent.id,original.prepared.intent.id);
  const fresh=createTargetGovernanceClientV2({...f.base,receiptStatus:f.runtime.receiptStatus});
  const explicit=await fresh.reviewAuthorization(original.operationId);
  assert.deepEqual(explicit.payload,JSON.parse(original.payloadJson));
  assert.equal((await fresh.reauthorize(explicit,{confirmed:true})).state,'acknowledged');
  assert.equal(f.counts.consents-baseline.consents,1);assert.equal(f.counts.reports-baseline.reports,1);
  const row=(await f.f.db.query('SELECT id,payload_hash,payload_text FROM target_governance_events_v2 WHERE id=$1',[original.operationId])).rows[0];
  assert.equal(row.id,original.operationId);assert.equal(row.payload_hash,original.payloadHash);assert.equal(row.payload_text,original.payloadJson);
 }finally{await f.close();}
});

test('M24 a stopped pre-dispatch retry preserves only the original locator and cannot become a new report',async()=>{
 const f=await fixture();
 try{
  const client=createTargetGovernanceClientV2({...f.base,receiptStatus:f.runtime.receiptStatus,api:{
   ...f.runtime.api,submitAuthorization:async()=>{throw Error('synthetic pre-dispatch Consent failure');},
  }});
  const preview=await client.prepare('report',f.payload);
  await assert.rejects(client.execute(preview,{confirmed:true}),/pre-dispatch/);
  const record=await client.stopLocalRetry(f.payload.id,{confirmed:true});
  assert.deepEqual(record,{operationId:f.payload.id,type:'report',payloadHash:preview.payloadHash,state:'stopped-local',serverCancellationConfirmed:false,reportId:f.payload.id,target:f.payload.target});
  assert.equal(JSON.stringify(await client.pending()).includes(f.payload.summary),false);
  const before={...f.counts};
  await assert.rejects(client.retry(f.payload.id,{confirmed:true}),/原操作/);
  assert.equal((await client.reconcile(f.payload.id)).state,'absent');assert.deepEqual(f.counts,before);
  const stopped=await client.stopped();assert.equal(stopped[0].canContinue,true);assert.equal(stopped[0].reportId,f.payload.id);
  assert.equal(JSON.stringify(stopped).includes(f.payload.summary),false);
  const fresh=createTargetGovernanceClientV2({...f.base,receiptStatus:f.runtime.receiptStatus});
  assert.equal((await fresh.resumePending()).state,'none');assert.deepEqual(f.counts,before);
  const continued=await fresh.continueStopped({operationId:f.payload.id,payloadHash:preview.payloadHash},{confirmed:true});
  assert.equal(continued.state,'acknowledged');assert.equal(continued.eventId,f.payload.id);
  assert.equal(f.counts.consents-before.consents,1);assert.equal(f.counts.reports-before.reports,1);
  assert.deepEqual(await fresh.stopped(),[]);
 }finally{await f.close();}
});

test('M24 automatic continuation preserves original bytes, fields, audience and deadline; replacement binding without Consent writes zero',async()=>{
 const f=await fixture();try{
  for(const stage of ['first-signature','same-binding-aged','accepted-consent-new-binding','absent-consent-new-binding']){
   const payload={...f.payload,id:randomUUID(),summary:'Synthetic original continuity '+stage};let interrupted=true,clock=Math.floor(Date.now()/1000);
   const originalApi=f.runtime.api,api={...originalApi,
    prepareAuthorization:async(...args)=>{if(stage==='first-signature'&&interrupted){interrupted=false;throw Error('synthetic interrupted first signature');}return originalApi.prepareAuthorization(...args);},
    submitAuthorization:async(...args)=>{if(stage!=='first-signature'&&stage!=='accepted-consent-new-binding'&&interrupted){interrupted=false;throw Error('synthetic interrupted original Consent');}return originalApi.submitAuthorization(...args);},
    call:async(path,...args)=>{if(stage==='accepted-consent-new-binding'&&interrupted&&path==='/v2/target-governance/reports'){interrupted=false;throw Error('synthetic business stopped before dispatch');}return originalApi.call(path,...args);},
   };
   const client=createTargetGovernanceClientV2({...f.base,api,receiptStatus:f.runtime.receiptStatus,now:()=>clock});
   const preview=await client.prepare('report',payload,{expiresAt:clock+3600});await assert.rejects(client.execute(preview,{confirmed:true}),/synthetic/);
   const saved=[...f.values.values()].find(value=>value?.active?.operationId===payload.id).active,original=structuredClone(saved),before={...f.counts};
   if(stage==='same-binding-aged')clock+=301;
   if(stage.endsWith('new-binding')){f.runtime.api.disconnect();await f.runtime.connect({confirmed:true});}
   const fresh=createTargetGovernanceClientV2({...f.base,receiptStatus:f.runtime.receiptStatus,now:()=>clock});
   const result=await fresh.resumePending(payload.id);
   if(stage==='absent-consent-new-binding'){
    assert.equal(result.reason,'original-binding-changed');assert.deepEqual(f.counts,before);
    const renewed=await fresh.reviewAuthorization(payload.id);assert.equal(renewed.expiresAt,original.expiresAt);assert.equal(renewed.payloadHash,original.payloadHash);
    assert.deepEqual(renewed.payload,JSON.parse(original.payloadJson));assert.deepEqual(renewed.viewers,original.viewers);
    assert.equal((await fresh.reauthorize(renewed,{confirmed:true})).state,'acknowledged');
   }else assert.equal(result.state,'acknowledged');
   const row=(await f.f.db.query('SELECT e.id,e.payload_text,e.payload_hash,c.intent FROM target_governance_events_v2 e JOIN consents c ON c.id=e.consent_id WHERE e.id=$1',[payload.id])).rows[0];
   assert.equal(row.id,original.operationId);assert.equal(row.payload_text,original.payloadJson);assert.equal(row.payload_hash,original.payloadHash);
   assert.equal(row.intent.expiresAt,original.expiresAt);assert.deepEqual(row.intent.viewers,original.viewers);
   assert.equal(f.counts.consents-before.consents,stage==='accepted-consent-new-binding'?0:1);assert.equal(f.counts.reports-before.reports,1);
   const counts={...f.counts};assert.equal((await fresh.receipt({operationId:payload.id,payloadHash:original.payloadHash,type:'report',reportId:payload.id})).state,'acknowledged');
   assert.deepEqual(f.counts,counts);
   // End this real report before the next independent recovery case. The
   // service deliberately permits only one active report per author/target.
   const withdrawal={schemaVersion:2,id:randomUUID(),reportId:payload.id,expectedVersion:1,kind:'withdraw-report',summary:'Synthetic fixture finished this independent report'};
   await fresh.execute(await fresh.prepare('event',withdrawal,{expiresAt:f.f.now+3600}),{confirmed:true});
  }
 }finally{await f.close();}
});

test('M24 queued confirmations and pending reads retain the runtime reference lease even when snapshot fields undergo ABA',async()=>{
 const subjectId='GUID'+'A'.repeat(28),endpoint='https://official.example.org';
 const snapshot={subjectId,endpoint,bindingId:randomUUID(),generation:7};let marker={},posts=0,release,entered;
 const ready=new Promise(resolve=>{entered=resolve;});
 const api={endpoint,snapshot:()=>({...snapshot}),call:async()=>{posts++;throw Error('unexpected business call');}};
 const receiptStatus={captureLease(){const original=marker;return{subjectId,endpoint,assertCurrent(){
  if(marker!==original)throw Error('receipt_status_authority_changed');
 }};}};
 const client=createTargetGovernanceClientV2({api,subjectId,receiptStatus,
  getLocal:async()=>null,putLocal:async()=>{},locks:{request:async(_key,_options,invoke)=>{
   entered();await new Promise(resolve=>{release=resolve;});return invoke();
  }},
 });
 const payload={schemaVersion:2,id:randomUUID(),target:{type:'room',id:randomUUID(),version:1},category:'privacy',summary:'Fictional contract'};
 const preview=await client.prepare('report',payload),pending=client.execute(preview,{confirmed:true});
 await ready;marker={};release();
 await assert.rejects(pending,/authority_changed/);assert.equal(posts,0);
 const reader=createTargetGovernanceClientV2({api,subjectId,receiptStatus,getLocal:async()=>{
  marker={};return{active:{operationId:payload.id,type:'report',payloadJson:JSON.stringify(payload),viewers:[]},stopped:[]};
 },putLocal:async()=>{}});
 await assert.rejects(reader.pending(),/authority_changed/);assert.equal(posts,0);
 // Contract double deliberately presents identical numeric snapshot fields;
 // the optional runtime reference lease catches the lifecycle replacement.
});

