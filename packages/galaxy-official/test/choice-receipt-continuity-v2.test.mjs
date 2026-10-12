import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {choiceReceiptResultSchema,choicePutIntent} from '../src/shared/choice-snapshot-schema-v2.mjs';
import {digest} from '../src/shared/digest.mjs';
import canonicalize from 'canonicalize';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {createHelpSearchClient} from '../../galaxy-web/src/help-search-client.mjs';
import {createChoiceSyncClient} from '../../galaxy-web/src/choice-sync-client.mjs';
import {createRetirementController} from '../src/retirement.mjs';

// Real HTTP, Binding/JWS, PGlite and WebRuntime. The local-store completion
// hooks and transport ACK loss are explicit doubles, not physical-device QA.
async function fixture({retiring=false}={}){
 const now=Math.floor(Date.now()/1000);let retirementNow=now;
 const retirement=retiring?createRetirementController({version:1,id:'choice-receipt-fixture',endpoint:'https://official.example.org',operator:'Synthetic fixture',reason:'Receipt continuity test',
  announcedAt:now+1,stopWritesAt:now+2,takeoutUntil:now+3,statusUntil:now+4,contactUrl:'https://official.example.org/contact',deletionPolicyUrl:'https://official.example.org/deletion'},
 {endpoint:'https://official.example.org',now:()=>retirementNow}):undefined;
 const f=await serviceFixture(browserScopes,null,{now,...(retiring?{retirement}:{})}),api=createApi({...f,rateLimit:1000});
 let runtime,cloud,search,drop=false,offline=false,onGet=null,onPut=null,onReceipt=null,receiptTransform=null;
 const data=new Map(),puts=[],receipts=[];
 try{
  const id=randomUUID(),payload={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,actorId:f.actor.subjectId,
   localRef:randomUUID(),title:'Receipt choice source',summary:'Synthetic selected public source',synthetic:true,source:{kind:'local',reference:randomUUID()}};
  const grant=await f.authorize(payload,'case.teaser.publish',{objectId:id,visibility:'Public',purpose:'public-profile'});await f.cases.submitV2(f.actor,grant);
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`;
  runtime=await createWebRuntime({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{now:()=>f.now,
   store:{get:async k=>{const v=structuredClone(data.get(k));if(onGet)await onGet(k,v);return v;},
    put:async(k,v)=>{data.set(k,structuredClone(v));if(onPut)await onPut(k,v);},
    update:memoryAtomicUpdate(data,async(k,v)=>{if(onPut)await onPut(k,v);})},
   fetch:async(url,options)=>{const path=new URL(url).pathname;
    if(path==='/v2/choice-snapshots/put')puts.push(JSON.parse(options.body));
    if(path==='/v2/choice-snapshots/receipt'){receipts.push(JSON.parse(options.body));if(offline)throw new Error('synthetic receipt offline');}
    const response=await fetch(origin+path,options);
    if(path==='/v2/choice-snapshots/put'&&drop){drop=false;throw new Error('synthetic original commit lost ACK');}
    if(path==='/v2/choice-snapshots/receipt'){
     if(onReceipt)await onReceipt();if(receiptTransform)return new Response(JSON.stringify(receiptTransform(await response.json())),{status:response.status,headers:{'content-type':'application/json'}});
    }return response;}});
  await runtime.createIdentity({confirmed:true});await runtime.connect({confirmed:true});const subjectId=(await runtime.status()).identity.subjectId;
  search=createHelpSearchClient(runtime,{authenticated:true,subjectId});cloud=createChoiceSyncClient(runtime,{subjectId});
  const page=await search.query({type:'history',query:{query:'Receipt choice source'}}),candidate=search.candidateKey(page.items[0]),snapshotId=randomUUID();
  await search.saveChoice({id:snapshotId,expectedVersion:0,localTaskRef:'Original private work',visibleRationale:'Original owner-only selected rationale',
   rationaleAuthor:'user',candidateKeys:[candidate],selectedKeys:[candidate],resultRefs:[]});
  await cloud.savePreference({endpoint:f.access.endpoint,expectedRevision:0,enabled:true,snapshotIds:[snapshotId]});
  const call=async(method,input,credential=f.credential)=>{const response=await fetch(origin+'/v2/choice-snapshots/'+method,{method:'POST',
   headers:{'content-type':'application/json',authorization:`Bearer ${credential}`},body:JSON.stringify(input)});return{status:response.status,body:await response.json()};};
  return{f,runtime,cloud,search,snapshotId,subjectId,grant,puts,receipts,data,call,
   loseNextPut(){drop=true;},offline(x){offline=x;},onGet(x){onGet=x;},onPut(x){onPut=x;},onReceipt(x){onReceipt=x;},transformReceipt(x){receiptTransform=x;},retirePhase(offset){retirementNow=now+offset;},
   async pending(){return(await cloud.localState()).pending[snapshotId];},
   async close(){cloud.close();search.close();runtime.close();await new Promise(resolve=>api.close(resolve));await f.db.close();}};
 }catch(error){cloud?.close();search?.close();runtime?.close();await new Promise(resolve=>api.close(resolve));await f.db.close();throw error;}
}
const locator=request=>({snapshotId:request.snapshotId,versionId:request.versionId,requestHash:digest(canonicalize(choicePutIntent(request)))});
function minimal(body,query){const parsed=choiceReceiptResultSchema.parse(body);assert.deepEqual(Object.fromEntries(Object.keys(query).map(k=>[k,parsed[k]])),query);
 assert.equal(parsed.currentAccessGranted,false);assert.equal(parsed.contentReturned,false);assert.equal(parsed.sourceAccessChecked,false);
 for(const forbidden of ['visibleRationale','localTaskRef','candidateRefs','selectedRefs','resultRefs','witnesses','payloadJson','consentId'])assert.equal(JSON.stringify(parsed).includes(forbidden),false);return parsed;}

test('Choice original-version receipt survives superseding, source revocation, opt-out, expiry and cloud-body deletion without reading or mutating content',async()=>{
 const t=await fixture();
 try{
  t.loseNextPut();await assert.rejects(t.cloud.sync(t.snapshotId),/lost ACK/);const request=await t.pending(),query=locator(request);
  const next={...request,versionId:randomUUID(),baseRevision:1,content:{...request.content,localVersion:2,visibleRationale:'Explicit later choice'}};
  await t.runtime.api.call('/v2/choice-snapshots/put',next);
  await t.f.consents.revoke(t.f.actor,t.grant.consentId);
  await t.cloud.savePreference({endpoint:t.f.access.endpoint,expectedRevision:1,enabled:false,snapshotIds:[]});
  const get=t.f.choices.getWithin.bind(t.f.choices),status=t.f.choices.sourceReader.statusWithin.bind(t.f.choices.sourceReader);
  t.f.choices.getWithin=()=>{throw new Error('receipt must not read current head/body');};t.f.choices.sourceReader.statusWithin=()=>{throw new Error('receipt must not renew source permission');};
  try{
   const ack=minimal(await t.runtime.api.call('/v2/choice-snapshots/receipt',query),query);assert.equal(ack.state,'acknowledged');assert.equal(ack.receipt.storedState,'superseded');
   const before=(await t.f.db.query('SELECT * FROM choice_snapshot_versions WHERE subject_id=$1 AND version_id=$2',[t.subjectId,query.versionId])).rows[0];
   const expiredAt=new Date((t.f.now-1)*1000).toISOString();await t.f.db.query('UPDATE choice_snapshot_versions SET expires_at=$3 WHERE subject_id=$1 AND version_id=$2',[t.subjectId,query.versionId,expiredAt]);
   const expired=minimal(await t.runtime.api.call('/v2/choice-snapshots/receipt',query),query);assert.equal(expired.receipt.contentRetentionDue,true);
   const after=(await t.f.db.query('SELECT * FROM choice_snapshot_versions WHERE subject_id=$1 AND version_id=$2',[t.subjectId,query.versionId])).rows[0];
   assert.deepEqual(after,{...before,expires_at:after.expires_at});assert.equal(new Date(after.expires_at).toISOString(),expiredAt,'receipt does not expire-write or extend retention');
   await t.runtime.api.call('/v2/choice-snapshots/delete',{snapshotId:t.snapshotId,expectedRevision:2});
   const deleted=minimal(await t.runtime.api.call('/v2/choice-snapshots/receipt',query),query);assert.equal(deleted.receipt.storedState,'deleted');assert.equal(deleted.receipt.contentExpiresAt,expiredAt);
  }finally{t.f.choices.getWithin=get;t.f.choices.sourceReader.statusWithin=status;}
  assert.equal(minimal((await t.call('receipt',query)).body,query).state,'absent','another owner cannot learn the original version');
  const wrongHash={...query,requestHash:'0'.repeat(64)},wrongId={...query,snapshotId:randomUUID()};
  assert.equal((await t.runtime.api.call('/v2/choice-snapshots/receipt',wrongHash)).state,'conflict');assert.equal((await t.runtime.api.call('/v2/choice-snapshots/receipt',wrongId)).state,'conflict');
  await assert.rejects(t.runtime.api.call('/v2/choice-snapshots/receipt',{...query,content:request.content}),/invalid_choice_snapshot_request/);
  // Actual SQL physical removal of this owner's retained Choice rows, using the
  // existing owner table scope. This is a deletion-boundary fixture, not a claim
  // that the full signed maintenance/delete workflow ran in this test.
  await t.f.db.query('DELETE FROM choice_snapshot_versions WHERE subject_id=$1',[t.subjectId]);
  const absent=minimal(await t.runtime.api.call('/v2/choice-snapshots/receipt',query),query);assert.equal(absent.state,'absent');assert.equal(absent.absenceMeaning,'no-retained-owner-operation');
  assert.equal(Number((await t.f.db.query('SELECT count(*) FROM choice_snapshot_versions WHERE subject_id=$1',[t.subjectId])).rows[0].count),0);
 }finally{await t.close();}
});

test('An unknown superseded original Choice is reconciled exactly after opt-out or local stop without another put or restored body',async()=>{
 const t=await fixture();
 try{
  t.loseNextPut();await assert.rejects(t.cloud.sync(t.snapshotId),/lost ACK/);const original=await t.pending(),query=locator(original);
  await t.runtime.api.call('/v2/choice-snapshots/put',{...original,versionId:randomUUID(),baseRevision:1,content:{...original.content,localVersion:2,visibleRationale:'Later owner choice'}});
  await t.cloud.discardPending(t.snapshotId);await t.cloud.savePreference({endpoint:t.f.access.endpoint,expectedRevision:1,enabled:false,snapshotIds:[]});
  const puts=t.puts.length,ack=minimal(await t.cloud.reconcile(t.snapshotId,{versionId:original.versionId}),query);
  assert.equal(ack.state,'acknowledged');assert.equal(ack.receipt.storedState,'superseded');assert.equal(t.puts.length,puts);
  const s=await t.cloud.localState(),stopped=s.stoppedVersions[original.versionId];assert.equal(stopped.state,'acknowledged');assert.equal(stopped.localRetryStopped,true);
  assert.equal(stopped.serverCancellationConfirmed,false);assert.equal(stopped.requestHash,query.requestHash);assert.equal(stopped.receipt.currentAccessGranted,false);
  assert.equal(JSON.stringify(stopped).includes(original.content.visibleRationale),false);assert.equal(s.synced?.[`${t.snapshotId}:anything`],undefined);
  assert.equal((await t.search.local()).choices[0].versions[0].visibleRationale,original.content.visibleRationale,'local private choice is independent from historical ACK');
 }finally{await t.close();}
});

test('Unknown Choice sync queries original receipt first, preserves offline/conflict and avoids accepted retries',async()=>{
 const t=await fixture();
 try{
  t.loseNextPut();await assert.rejects(t.cloud.sync(t.snapshotId),/lost ACK/);const original=await t.pending(),query=locator(original);
  t.offline(true);await assert.rejects(t.cloud.sync(t.snapshotId),/receipt offline/);assert.equal(t.puts.length,1);assert.deepEqual(await t.pending(),original);t.offline(false);
  const changed=await t.cloud.localState();changed.pending[t.snapshotId].content.visibleRationale='A changed body under the original version';await t.runtime.putLocal('choice-cloud-v2',changed);
  await assert.rejects(t.cloud.sync(t.snapshotId),/choice_original_operation_conflict/);assert.equal(t.puts.length,1);
  const restore=await t.cloud.localState();restore.pending[t.snapshotId]=original;await t.runtime.putLocal('choice-cloud-v2',restore);
  t.transformReceipt(result=>({...result,state:'conflict',reason:'original-operation-mismatch',receipt:undefined}));
  await assert.rejects(t.cloud.sync(t.snapshotId),/choice_original_operation_conflict/);assert.equal(t.puts.length,1);assert.deepEqual(await t.pending(),original);
  t.transformReceipt(result=>({...result,content:{visibleRationale:'Forbidden response body'}}));
  await assert.rejects(t.cloud.reconcile(t.snapshotId),/unrecognized_keys|Unrecognized key/);assert.deepEqual(await t.pending(),original);assert.equal(t.puts.length,1);
  t.transformReceipt(null);const actual=await t.cloud.sync(t.snapshotId);assert.equal(actual.operationVersionId,original.versionId);
  assert.equal(minimal(actual.operationReceipt,query).state,'acknowledged');assert.equal(t.puts.length,1);assert.equal(await t.pending(),undefined);
  assert.equal(actual.current.expiresAt,actual.operationReceipt.receipt.contentExpiresAt);
  await t.cloud.sync(t.snapshotId);assert.equal(t.puts.length,1,'historical acceptance prevents a fresh unchanged business version');
 }finally{await t.close();}
});

test('Confirmed exact absent allows explicit retry of original Choice version/defaults; no new business version or renewed TTL',async()=>{
 const t=await fixture();
 try{
  t.onPut(async(k,v)=>{if(k.endsWith(':choice-cloud-v2')&&v.pending?.[t.snapshotId]){t.onPut(null);await t.runtime.connect({confirmed:true});}});
  await assert.rejects(t.cloud.sync(t.snapshotId),/connection_changed/);assert.equal(t.puts.length,0);const original=await t.pending(),query=locator(original);
  // The old parser supplied resolveVersionIds when absent. Restore a legacy
  // journal with that optional wire field missing and the same canonical hash.
  const local=await t.cloud.localState();delete local.pending[t.snapshotId].resolveVersionIds;await t.runtime.putLocal('choice-cloud-v2',local);
  const absent=minimal(await t.cloud.reconcile(t.snapshotId),query);assert.equal(absent.state,'absent');assert.equal(t.puts.length,0);assert.ok(await t.pending());
  const accepted=await t.cloud.sync(t.snapshotId);assert.equal(t.puts.length,1);assert.equal(t.puts[0].versionId,original.versionId);assert.deepEqual(t.puts[0].content,original.content);
  assert.equal(accepted.operationVersionId,original.versionId);
  const row=(await t.f.db.query('SELECT request_hash,expires_at FROM choice_snapshot_versions WHERE subject_id=$1 AND version_id=$2',[t.subjectId,original.versionId])).rows[0];
  assert.equal(row.request_hash,query.requestHash);assert.equal(new Date(row.expires_at).toISOString(),accepted.current.expiresAt);
 }finally{await t.close();}
});

test('Same-owner reconnection during original receipt response withholds result and preserves the exact pending operation',async()=>{
 const t=await fixture();
 try{
  t.loseNextPut();await assert.rejects(t.cloud.sync(t.snapshotId),/lost ACK/);const original=await t.pending();
  t.onReceipt(async()=>{t.onReceipt(null);await t.runtime.connect({confirmed:true});});
  await assert.rejects(t.cloud.reconcile(t.snapshotId),/connection_changed/);assert.deepEqual(await t.pending(),original);assert.equal(t.puts.length,1);
  const ack=minimal(await t.cloud.reconcile(t.snapshotId),locator(original));assert.equal(ack.state,'acknowledged');assert.equal(t.puts.length,1);
 }finally{await t.close();}
});

test('Receipt local completion after a new lease keeps recorded acceptance and permits later read-only recovery without leaking body',async()=>{
 const t=await fixture();
 try{
  t.loseNextPut();await assert.rejects(t.cloud.sync(t.snapshotId),/lost ACK/);const original=await t.pending();
  t.onPut(async(k,v)=>{if(k.endsWith(':choice-cloud-v2')&&v.operationReceipts?.[original.versionId]){t.onPut(null);await t.runtime.connect({confirmed:true});}});
  await assert.rejects(t.cloud.reconcile(t.snapshotId),/connection_changed/);assert.equal(t.puts.length,1);
  const s=await t.cloud.localState();assert.equal(s.pending[t.snapshotId],undefined);assert.equal(s.operationReceipts[original.versionId].receipt.state,'acknowledged');
  const recovered=minimal(await t.cloud.reconcile(t.snapshotId,{versionId:original.versionId}),locator(original));assert.equal(recovered.state,'acknowledged');assert.equal(t.puts.length,1);
  assert.equal(JSON.stringify(s.operationReceipts[original.versionId]).includes(original.content.visibleRationale),false);
 }finally{await t.close();}
});

test('A stopped original locator from another owner cannot be queried or mistaken for cloud cancellation',async()=>{
 const t=await fixture();
 try{
  t.loseNextPut();await assert.rejects(t.cloud.sync(t.snapshotId),/lost ACK/);const original=await t.pending();await t.cloud.discardPending(t.snapshotId);
  const s=await t.cloud.localState();s.stoppedVersions[original.versionId].owner.subjectId=t.f.actor.subjectId;await t.runtime.putLocal('choice-cloud-v2',s);
  const before=t.receipts.length;await assert.rejects(t.cloud.reconcile(t.snapshotId,{versionId:original.versionId}),/choice_original_owner_mismatch/);
  assert.equal(t.receipts.length,before);assert.equal(t.puts.length,1);assert.equal((await t.cloud.localState()).stoppedVersions[original.versionId].serverCancellationConfirmed,false);
 }finally{await t.close();}
});

test('Only the original minimal Choice receipt stays readable during takeout and status-only retirement',async()=>{
 const t=await fixture({retiring:true});
 try{
  t.loseNextPut();await assert.rejects(t.cloud.sync(t.snapshotId),/lost ACK/);const original=await t.pending(),query=locator(original);
  t.retirePhase(2);assert.equal(minimal(await t.runtime.api.call('/v2/choice-snapshots/receipt',query),query).state,'acknowledged');
  await assert.rejects(t.runtime.api.call('/v2/choice-snapshots/put',original),/service_writes_stopped/);
  t.retirePhase(3);assert.equal(minimal(await t.cloud.reconcile(t.snapshotId),query).state,'acknowledged');
  await assert.rejects(t.cloud.get(t.snapshotId),/service_retired/);assert.equal(t.puts.length,2,'the second put was rejected at retirement, not a successful new write');
  assert.equal(Number((await t.f.db.query('SELECT count(*) FROM choice_snapshot_versions WHERE subject_id=$1',[t.subjectId])).rows[0].count),1);
  t.retirePhase(4);await assert.rejects(t.runtime.api.call('/v2/choice-snapshots/receipt',query),/service_retired/);
 }finally{await t.close();}
});

test('Queued original receipt reads retain the connection selected at enqueue and do not query through a later lease',async()=>{
 const t=await fixture();let release;const gate=new Promise(resolve=>{release=resolve;});let entered;const ready=new Promise(resolve=>{entered=resolve;});
 try{
  t.loseNextPut();await assert.rejects(t.cloud.sync(t.snapshotId),/lost ACK/);const original=await t.pending();
  t.onGet(async k=>{if(k.endsWith(':choice-cloud-v2')){t.onGet(null);entered();await gate;}});
  const first=t.cloud.reconcile(t.snapshotId).then(value=>({value}),error=>({error}));await ready;
  const second=t.cloud.reconcile(t.snapshotId).then(value=>({value}),error=>({error}));await t.runtime.connect({confirmed:true});release();
  const a=await first,b=await second;assert.match(a.error?.message??'',/connection_changed/);assert.match(b.error?.message??'',/connection_changed/);
  assert.equal(t.receipts.length,0);assert.equal(t.puts.length,1);assert.deepEqual(await t.pending(),original);
 }finally{release?.();await t.close();}
});
import {memoryAtomicUpdate} from './memory-atomic-update.mjs';
