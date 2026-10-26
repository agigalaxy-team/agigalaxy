import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../../galaxy-official/src/shared/digest.mjs';
import {communityForumFixture} from '../../galaxy-official/test/community-forum-fixture.mjs';
import {createCommunityForumClient,newForumDraft} from "../src/features/community-forum/community-forum-client.mjs";

function runtimeFixture(f){
 const rows=new Map(),writes=[],signed=[];let generation=1,loss=null;
 const state=()=>({subjectId:f.owner.actor.subjectId,bindingId:f.owner.actor.bindingId,generation,scopes:f.owner.actor.scopes});
 const api={endpoint:f.owner.access.endpoint,snapshot:state,call:async(path,input,{method='POST',authenticated=true}={})=>{
  const writing=['/v2/community/posts','/v2/community/versions','/v2/community/replies'].includes(path);
  if(writing){writes.push(structuredClone(input));if(loss==='before'){loss=null;throw Error('offline before submission');}}
  const response=await f.request(path,{input:method==='GET'?undefined:input,method,authorization:authenticated});
  if(response.status!==200)throw Object.assign(Error(response.body.error),{code:response.body.error,outcome:'rejected',status:response.status});
  if(writing&&loss==='after'){loss=null;throw Error('offline after acceptance');}return response.body;
 },prepareAuthorization:async(payloadJson,options)=>{
  const intent={version:1,id:crypto.randomUUID(),subjectId:f.owner.actor.subjectId,bindingId:f.owner.actor.bindingId,endpoint:api.endpoint,
   objectId:options.objectId,action:options.action,purpose:options.visibility==='Public'?'public-profile':'operational',recipient:api.endpoint,
   fields:Object.keys(JSON.parse(payloadJson)),visibility:options.visibility,viewers:options.viewers,payloadHash:digest(payloadJson),
   policyVersion:'0.1',issuedAt:f.clock.now,expiresAt:options.expiresAt};
  const signedIntent=await f.owner.signForTest(JSON.stringify(intent),'galaxy-consent+jws');signed.push(intent);
  return{version:1,endpoint:api.endpoint,intent,signedIntent,payloadJson};
 }};
 const runtime={api,getLocal:async key=>structuredClone(rows.get(key)),updateLocal:async(key,update)=>{
  const value=update(structuredClone(rows.get(key)));rows.set(key,structuredClone(value));return structuredClone(value);},
  receiptStatus:{captureLease:()=>{const captured=state();return{...captured,endpoint:api.endpoint,assertCurrent:()=>{
   if(['subjectId','bindingId','generation'].some(field=>captured[field]!==state()[field]))throw Error('receipt_status_authority_changed');
  }};}}};
 return{runtime,rows,writes,signed,client:()=>createCommunityForumClient(runtime,{subjectId:f.owner.actor.subjectId,now:()=>f.clock.now}),lose:value=>{loss=value;},
  reconnect:async()=>{await f.reconnect(f.owner);generation++;}};
}
test('forum resumes the approved publication through actual signed HTTP without repeat confirmation or duplicate content',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'automatic-publication');
  const local=runtimeFixture(f),client=local.client();await client.draft.load();
  const draft=newForumDraft('create-post',{}, {title:'A saved discussion',body:'Approved body with a lost acknowledgement'});await client.draft.save(draft);
  const first=await client.prepare('create-post',await f.post({title:draft.title,body:draft.body}),{draftRef:{id:draft.id,revision:draft.revision}});
  local.lose('after');await assert.rejects(client.execute(first,{confirmed:true}),/offline after acceptance/);
  const accepted=await client.resumePending();assert.equal(accepted.status,'acknowledged');assert.equal(local.writes.length,1);
  assert.equal(await client.draft.load(),null);assert.equal((await client.pending()).filter(item=>item.state==='awaiting-receipt').length,0);
  assert.equal((await f.ok('/v2/community/posts/'+first.payload.postId,{authorization:false})).payload.body,draft.body);

  const second=await client.prepare('create-post',await f.post({title:'Retry the same publication'}));
  local.lose('before');await assert.rejects(client.execute(second,{confirmed:true}),/offline before submission/);
  const pending=(await client.pending()).find(item=>item.state==='awaiting-receipt');await local.reconnect();
  await assert.rejects(async()=>client.resumePending(),/receipt_status_authority_changed/);
  const fresh=local.client(),writeCount=local.writes.length,signatureCount=local.signed.length;
  await assert.rejects(fresh.resumePending(),error=>error.code==='consent_reauthorization_required'&&error.reason==='original-binding-changed');
  assert.equal(local.writes.length,writeCount);assert.equal(local.signed.length,signatureCount);
  const reviewed=await fresh.reviewOperation(pending.operationId);assert.equal(reviewed.requiresReauthorization,true);assert.deepEqual(reviewed.payload,second.payload);
  assert.equal(reviewed.expiresAt,second.payload.publishedUntil);assert.equal(reviewed.payloadHash,pending.payloadHash);
  const recovered=await fresh.retry(pending.operationId,{confirmed:true,reauthorize:true});assert.equal(recovered.status,'acknowledged');
  assert.equal(local.writes.at(-1).payloadJson,local.writes.at(-2).payloadJson);
  assert.equal(local.signed.at(-1).expiresAt,local.signed.at(-2).expiresAt);
  assert.notEqual(local.signed.at(-1).bindingId,local.signed.at(-2).bindingId);
  assert.equal(recovered.operationId,pending.operationId);assert.equal(recovered.payloadHash,pending.payloadHash);
  assert.equal(Number((await f.db.query('SELECT count(*) n FROM forum_posts_v1')).rows[0].n),2);
  assert.equal((await local.client().resumePending()).status,'none');
 }finally{await f.close();}
});
test('forum renews only an aged same-binding signature while preserving the approved publication bytes and deadline',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'same-binding-publication');const local=runtimeFixture(f),client=local.client(),preview=await client.prepare('create-post',await f.post());
  local.lose('before');await assert.rejects(client.execute(preview,{confirmed:true}),/offline/);
  const key=`community-forum:${local.runtime.api.endpoint}:${f.owner.actor.subjectId}`,original=structuredClone(local.rows.get(key).active);
  f.clock.now+=301;const recovered=await client.resumePending();assert.equal(recovered.status,'acknowledged');assert.equal(recovered.operationId,original.operationId);
  assert.equal(local.writes.at(-1).payloadJson,original.payloadJson);assert.equal(local.signed.at(-1).expiresAt,original.prepared.intent.expiresAt);
  assert.equal(local.signed.at(-1).bindingId,original.prepared.intent.bindingId);assert.notEqual(local.signed.at(-1).id,original.prepared.intent.id);
  assert.equal(Number((await f.db.query('SELECT count(*) n FROM forum_posts_v1')).rows[0].n),1);
 }finally{await f.close();}
});
test('automatic forum recovery never revives stopped retry or extends an expired publication choice',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'stopped-publication');const local=runtimeFixture(f),client=local.client();
  const first=await client.prepare('create-post',await f.post());local.lose('before');await assert.rejects(client.execute(first,{confirmed:true}),/offline/);
  await client.stopLocalRetry(first.payload.operationId,{confirmed:true});const count=local.writes.length;
  assert.equal((await client.resumePending()).status,'none');assert.equal(local.writes.length,count);
  const expired=await client.prepare('create-post',await f.post({publishedUntil:f.clock.now-1}));
  await assert.rejects(client.execute(expired,{confirmed:true}),/forum_publication_expired|许可期限/);
  await assert.rejects(client.resumePending(),/forum_publication_expired|许可期限/);
  assert.equal(local.writes.length,count);assert.equal(local.signed.length,1);
  assert.equal((await client.pending()).find(item=>item.state==='awaiting-receipt').publishedUntil,expired.payload.publishedUntil);
 }finally{await f.close();}
});
