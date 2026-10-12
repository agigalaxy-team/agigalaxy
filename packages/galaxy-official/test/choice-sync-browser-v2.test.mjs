import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {createHelpSearchClient} from '../../galaxy-web/src/help-search-client.mjs';
import {createChoiceSyncClient} from '../../galaxy-web/src/choice-sync-client.mjs';
test('Two real web runtimes retain draft base, reconcile lost sync response and restore a separate authorized choice branch',async()=>{
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),api=createApi({...f,rateLimit:1000});let a,b,ha,hb,ca,cb,drop=false;const writes=[];
 try{
  const id=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,actorId:f.actor.subjectId,localRef:randomUUID(),title:'Shared choice source',summary:'Public synthetic example',synthetic:true,source:{kind:'local',reference:randomUUID()}};
  const grant=await f.authorize(root,'case.teaser.publish',{objectId:id,visibility:'Public',purpose:'public-profile'});await f.cases.submitV2(f.actor,grant);
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`;
  const config={endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},wire=async(url,options)=>{const path=new URL(url).pathname;if(path==='/v2/choice-snapshots/put')writes.push(JSON.parse(options.body));const response=await fetch(origin+path,options);if(drop&&path==='/v2/choice-snapshots/put'){drop=false;throw new Error('synthetic lost response after server write');}return response;};
  const store=data=>({get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),update:memoryAtomicUpdate(data)});const aData=new Map();
  a=await createWebRuntime(config,{store:store(aData),fetch:wire,now:()=>f.now});await a.createIdentity({confirmed:true});await a.connect({confirmed:true});
  // Synthetic same authorized identity in two independent runtime caches; this
  // exercises version conflicts, not a claim of physical device-enrolment QA.
  b=await createWebRuntime(config,{store:store(structuredClone(aData)),fetch:wire,now:()=>f.now});await b.connect({confirmed:true});
  const subjectId=(await a.status()).identity.subjectId;ha=createHelpSearchClient(a,{authenticated:true,subjectId});hb=createHelpSearchClient(b,{authenticated:true,subjectId});ca=createChoiceSyncClient(a,{subjectId});cb=createChoiceSyncClient(b,{subjectId});
  const query={type:'history',query:{query:'Shared choice'}},ra=await ha.query(query),rb=await hb.query(query),choiceId=randomUUID();
  const make=(r,reason)=>({id:choiceId,expectedVersion:0,localTaskRef:'Local task',visibleRationale:reason,rationaleAuthor:'user',candidateKeys:[ha.candidateKey(r.items[0])],selectedKeys:[ha.candidateKey(r.items[0])],resultRefs:[]});
  await ha.saveChoice(make(ra,'Device A reasoning visible to user'));await hb.saveChoice(make(rb,'Device B alternative visible to user'));
  assert.equal((await ca.preferences()).enabled,false);await assert.rejects(ca.sync(choiceId),/not_selected/);
  await ca.savePreference({endpoint:f.access.endpoint,expectedRevision:0,enabled:true,snapshotIds:[choiceId]});
  const preview=await ca.localPreview(choiceId);
  await assert.rejects(ca.sync(choiceId,{expectedLocalHash:'f'.repeat(64)}),/choice_sync_preview_changed/);
  assert.equal(writes.length,0,'a stale preview cannot upload a different local version');
  drop=true;await assert.rejects(ca.sync(choiceId,{expectedLocalHash:preview.hash}),/lost response/);const original=(await ca.localState()).pending[choiceId];assert.ok(original);
  await assert.rejects(ca.sync(choiceId,{expectedPendingVersionId:randomUUID()}),/choice_sync_preview_changed/);
  assert.deepEqual((await ca.localState()).pending[choiceId],original,'a different pending operation cannot replace the previewed original');
  const accepted=await ca.sync(choiceId,{expectedPendingVersionId:original.versionId});assert.equal(accepted.replayed,true);
  assert.equal(writes.length,1,'an accepted original is recovered through its receipt without another upload');assert.equal(writes[0].versionId,original.versionId);assert.equal(accepted.operationVersionId,original.versionId);
  await cb.list();const alternative=await cb.sync(choiceId);assert.equal(alternative.syncState,'conflict','reading latest head did not rebase old local draft');
  assert.equal(alternative.current.content.visibleRationale,'Device A reasoning visible to user');assert.equal(alternative.conflicts[0].content.visibleRationale,'Device B alternative visible to user');
  const restored=await cb.restore(choiceId,alternative.current.versionId);assert.equal(restored.content.visibleRationale,'Device A reasoning visible to user');assert.equal((await hb.local()).choices[0].versions[0].visibleRationale,'Device B alternative visible to user');
  assert.equal(JSON.stringify(restored).includes('"query"'),false);
  const common={version:1,endpoint:f.access.endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,issuedAt:f.now,expiresAt:f.now+300};
  const pending=await f.deletion.submit(f.actor,await f.signForTest(JSON.stringify({...common,id:randomUUID(),action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'}),'galaxy-deletion-intent+jws'));
  const suspended=await cb.get(choiceId);assert.equal(suspended.current.content.visibleRationale,null);
  await f.choices.purgeInvalidSources();
  await f.deletion.submit(f.actor,await f.signForTest(JSON.stringify({...common,id:randomUUID(),action:'cancel',requestId:pending.id,expectedRevision:1}),'galaxy-deletion-intent+jws'));
  assert.equal((await cb.get(choiceId)).current.content.visibleRationale,'Device A reasoning visible to user','cancelled pending source deletion did not permanently erase otherwise valid rationale');
  await f.consents.revoke(f.actor,grant.consentId);const hidden=await cb.get(choiceId);assert.equal(hidden.current.content.visibleRationale,null);assert.equal(hidden.conflicts[0].content.visibleRationale,null);
  await cb.delete(choiceId);assert.equal((await hb.local()).choices.length,1);
  await ca.savePreference({endpoint:f.access.endpoint,expectedRevision:1,enabled:false,snapshotIds:[]});
  assert.equal((await ca.preferences()).enabled,false);
 }finally{ca?.close();cb?.close();ha?.close();hb?.close();a?.close();b?.close();await new Promise(resolve=>api.close(resolve));await f.db.close();}
});
import {memoryAtomicUpdate} from './memory-atomic-update.mjs';
