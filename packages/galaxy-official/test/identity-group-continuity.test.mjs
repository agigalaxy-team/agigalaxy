import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {identityGroupContinuityFixture} from './identity-group-continuity-fixture.mjs';
import {digest} from '../src/shared/digest.mjs';

test('durable identity locator precedes signing; lost ACK settles only the original proof after real rebind',{timeout:60000},async()=>{
 const f=await identityGroupContinuityFixture();try{const client=f.client('primary'),intent=f.payload();let locator;f.fault.lostAck=true;
  await assert.rejects(client.execute(await client.prepare(intent),{confirmed:true,onJournal:async selected=>{locator=selected;const row=(await f.runtimes.primary.getLocal(f.journal('primary'))).pending[0];assert.equal(row.signature,null);assert.equal(row.proofId,selected.proofId);assert.equal(f.packets.length,0);assert.equal(f.signatures.primary??0,0);}}),/original ACK lost/);
  const later=f.payload();await client.execute(await client.prepare(later),{confirmed:true});await f.apis.primary.connect();
  assert.equal((await client.receiptFor(locator)).state,'acknowledged');const result=await client.resumePending();assert.equal(result.items[0].state,'acknowledged');assert.equal(result.items[0].operationState,'pending');assert.equal(f.packets.length,2);
  assert.equal((await client.pending()).length,0);assert.equal(Number((await f.f.db.query('SELECT count(*) n FROM identity_group_approvals_v2')).rows[0].n),2);
 }finally{await f.close();}
});

test('real business rejection remains blocked through automatic reads; explicit original retry keeps exact bytes',{timeout:60000},async()=>{
 const f=await identityGroupContinuityFixture();try{const client=f.client('primary'),intent=f.payload({expectedVersion:1});const preview=await client.prepare(intent);
  await assert.rejects(client.execute(preview,{confirmed:true}),error=>error.code==='invalid_identity_group'&&error.status===400);const original=(await f.runtimes.primary.getLocal(f.journal('primary'))).pending[0],count=f.packets.length;
  for(let i=0;i<3;i++)assert.equal((await client.resumePending()).items[0].reason,'business-declined');assert.equal(f.packets.length,count);
  assert.deepEqual((await f.runtimes.primary.getLocal(f.journal('primary'))).pending[0],original);
  await assert.rejects(client.retry(original.proofId,{explicitRetry:true}),error=>error.code==='invalid_identity_group');assert.equal(f.packets.length,count+1);assert.deepEqual(f.packets.at(-1),f.packets[0]);
 }finally{await f.close();}
});

test('two pages use atomic CAS; a queued generation change cannot sign or send old input',{timeout:60000},async()=>{
 const f=await identityGroupContinuityFixture();try{const first=f.client('primary'),second=f.client('primary'),intent=f.payload(),a=await first.prepare(intent),b=await second.prepare(intent);let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;}),hold=new Promise(resolve=>{release=resolve;});const running=first.execute(a,{confirmed:true,onJournal:async()=>{enter();await hold;}});await entered;
  await assert.rejects(second.execute(b,{confirmed:true}),error=>error.code==='identity_group_operation_pending');await f.apis.primary.connect();release();
  await assert.rejects(running,error=>error.code==='identity_group_identity_changed');assert.equal(f.packets.length,0);assert.equal(f.signatures.primary??0,0);
  const recovery=await first.resumePending();assert.equal(recovery.items[0].reason,'explicit-approval-required');assert.equal(f.packets.length,0);
 }finally{await f.close();}
});

test('changed binding requires explicit same bytes approval; deadline and superseded original remain queryable',{timeout:60000},async()=>{
 const f=await identityGroupContinuityFixture();try{const client=f.client('primary');f.fault.beforeWrite=true;await assert.rejects(client.execute(await client.prepare(f.payload()),{confirmed:true}),/before commit/);f.fault.beforeWrite=false;
  const old=(await f.runtimes.primary.getLocal(f.journal('primary'))).pending[0];await f.apis.primary.connect();assert.equal((await client.resumePending()).items[0].reason,'binding-changed');
  const review=await client.reviewPending(old.proofId);assert.equal(JSON.stringify(review.payload),old.payloadJson);assert.equal(review.payload.expiresAt,JSON.parse(old.proofJson).expiresAt);
  const stable=(await f.runtimes.primary.getLocal(f.journal('primary'))).pending[0];for(let i=0;i<2;i++)assert.equal((await client.resumePending()).items[0].reason,'binding-changed');assert.deepEqual((await f.runtimes.primary.getLocal(f.journal('primary'))).pending[0],stable);
  assert.equal((await client.execute(review,{confirmed:true})).state,'acknowledged');const saved=await f.runtimes.primary.getLocal(f.journal('primary'));assert.equal(saved.originals.find(row=>row.proofId===old.proofId).payloadJson,old.payloadJson);
  assert.equal((await client.receiptFor(old.locator??{endpoint:f.f.access.endpoint,ownerId:f.f.actor.subjectId,operationId:old.operationId,groupId:old.groupId,proofId:old.proofId,payloadHash:old.payloadHash})).ownApprovalAcknowledged,false);
  assert.equal(f.packets.at(-1).payloadJson,old.payloadJson);assert.notEqual(f.packets.at(-1).proofJson,old.proofJson);
 }finally{await f.close();}
});

test('stopped and expired identity proofs never revive or extend the original proposal',{timeout:60000},async()=>{
 const f=await identityGroupContinuityFixture();try{const client=f.client('primary');f.fault.beforeWrite=true;await assert.rejects(client.execute(await client.prepare(f.payload()),{confirmed:true}),/before commit/);f.fault.beforeWrite=false;
  const row=(await client.pending())[0];assert.equal((await client.stopLocalRetry(row.proofId,{confirmed:true})).localRetryStopped,true);const count=f.packets.length;
  for(let i=0;i<2;i++)assert.equal((await client.resumePending()).items[0].localRetryStopped,true);assert.equal(f.packets.length,count);await assert.rejects(client.retry(row.proofId,{explicitRetry:true}),error=>error.code==='identity_group_local_retry_stopped');
  const active=f.payload();f.fault.beforeWrite=true;await assert.rejects(client.execute(await client.prepare(active),{confirmed:true}),/before commit/);f.fault.beforeWrite=false;const original=(await client.pending()).find(item=>item.operationId===active.operationId);
  f.setConsumerNow(active.expiresAt+1);assert.equal((await client.resumePending()).items.find(item=>item.locator.operationId===active.operationId).reason,'proposal-expired');await assert.rejects(client.reviewPending(original.proofId),error=>error.code==='identity_group_proposal_expired');
  assert.equal(JSON.parse((await f.runtimes.primary.getLocal(f.journal('primary'))).pending.find(item=>item.proofId===original.proofId).proofJson).expiresAt,active.expiresAt);
 }finally{await f.close();}
});

test('invitations are current-subject only and paginated; source read stays with each viewer and original proof ACK persists',{timeout:60000},async()=>{
 const f=await identityGroupContinuityFixture();try{const primary=f.client('primary'),secondary=f.client('secondary'),outsider=f.client('outsider'),caseId=randomUUID();
  const event={schemaVersion:2,eventId:caseId,caseId,kind:'case-created',expectedVersion:0,actorId:f.f.actor.subjectId,localRef:randomUUID(),title:'合成本人工作',summary:'原作者和私有来源范围不迁移',source:{kind:'local',reference:randomUUID()},synthetic:true};
  const env=await f.apis.primary.api.authorizePayload(JSON.stringify(event),{action:'case.teaser.publish',objectId:event.eventId,confirmed:true});await f.apis.primary.api.call('/v2/cases/events',env);
  const source=await primary.source({kind:'case-event',id:caseId,caseId,version:1}),intent=f.payload({sourceRefs:[source.ref]});let oldLocator;const earlierApprovals=new Map();
  await primary.execute(await primary.prepare(intent),{confirmed:true,onJournal:value=>{oldLocator=value;}});for(let i=0;i<2;i++)await primary.execute(await primary.prepare(f.payload()),{confirmed:true,onJournal:value=>{earlierApprovals.set(value.operationId,value);}});
  const first=await secondary.invitations({direction:'incoming',limit:1}),second=await secondary.invitations({direction:'incoming',limit:1,after:first.next});assert.equal(first.items.length,1);assert.ok(first.next);assert.equal(second.items.length,1);assert.notEqual(first.items[0].operationId,second.items[0].operationId);
  assert.deepEqual((await outsider.invitations()).items,[]);const anonymous=await f.apis.outsider.api.call('/v2/identity-groups/query',{subjectId:f.f.actor.subjectId,includeProposals:true},{authenticated:false});assert.deepEqual(anonymous.proposals,[]);
  const proposal=await secondary.proposal(intent.operationId);assert.ok(proposal.availableActions.includes('approve'));assert.equal(proposal.sources[0].record,null);await assert.rejects(secondary.source({kind:'case-event',id:caseId,caseId,version:1}),error=>error.status===404);
  assert.equal((await secondary.execute(await secondary.prepareResponse(intent.operationId),{confirmed:true})).operationState,'committed');assert.equal((await secondary.read(intent.groupId)).sources[0].record,null);assert.deepEqual((await primary.read(intent.groupId)).viewers,intent.viewers);assert.ok((await primary.read(intent.groupId)).availableActions.includes('revoke'));
  await f.apis.primary.api.call('/v1/consents/'+env.consentId+'/revoke',{});assert.equal((await primary.read(intent.groupId)).sources[0].record,null);
  const pending=(await primary.invitations({direction:'outgoing'})).items[0],decline=await primary.execute(await primary.prepareResponse(pending.operationId,'decline'),{confirmed:true});assert.equal(decline.operationState,'declined');
  const priorProof=earlierApprovals.get(pending.operationId),precise=await primary.receiptFor(priorProof);assert.equal(precise.state,'acknowledged');assert.equal(precise.operationState,'declined');assert.ok(precise.acknowledgedProofIds.includes(priorProof.proofId));assert.equal(precise.approvals.some(row=>row.id===priorProof.proofId),false);
  assert.equal((await primary.receiptFor(oldLocator)).state,'acknowledged');assert.equal((await secondary.proposal(intent.operationId)).availableActions.length,0);
  const revoke={schemaVersion:2,operationId:randomUUID(),groupId:intent.groupId,kind:'revoke',expectedVersion:1,previousOperationId:intent.operationId,endpoint:f.f.access.endpoint,issuedAt:f.f.now,expiresAt:f.f.now+3600,reason:'合成任一成员撤回整份共同展示'};
  assert.equal((await secondary.execute(await secondary.prepare(revoke),{confirmed:true})).operationState,'committed');assert.equal((await primary.read(intent.groupId)).state,'revoked');assert.equal((await f.f.db.query('SELECT payload_hash FROM case_events WHERE id=$1',[caseId])).rows[0].payload_hash,digest(JSON.stringify(event)));
 }finally{await f.close();}
});
