import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chatFixture,invite} from './chat-workflow.mjs';
import {ChatSharedSummaryService} from '../src/chat-shared-summaries.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {subjectResourceUsage,defaultResourceBudgetPolicy} from '../src/infrastructure/resource-budgets.mjs';
export async function verifySharedSummaryWorkflow(options={}){
 const bodies=new Map(),calls=[];let loseNext=false;
 // Explicit external transport contract double, not a running Prosody server.
 const transport={available:true,project:async()=>{},send:async x=>{calls.push(x);if(!bodies.has(x.messageId))bodies.set(x.messageId,{archiveId:x.messageId,text:x.text,revision:1});
  if(loseNext){loseNext=false;throw new ServiceError('chat_delivery_unknown',504);}return{archiveId:x.messageId};},
  read:async x=>x.ids.flatMap(id=>bodies.has(id)?[structuredClone(bodies.get(id))]:[]),erase:async x=>{bodies.delete(x.messageId);return{archiveDeleted:true};},
  edit:async x=>{const r=bodies.get(x.messageId);r.text=x.text;r.revision=x.expectedRevision+1;return{revision:r.revision};}};
 const f=await chatFixture({...options,transport});try{const{chat,people:[a,b,c]}=f;
  const shared=new ChatSharedSummaryService({db:options.runtimeDb??f.db,access:chat.access,chat,now:f.now});
  const roomId=randomUUID();await chat.create(a,{roomId,operationId:randomUUID(),title:'Shared context ordinary room'});await invite(chat,a,roomId,b);
  const m=await chat.send(a,roomId,{clientMessageId:randomUUID(),text:'Source message remains a real separate object'});
  const ref={messageId:m.messageId,revision:1},content={generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'1',complete:false},
   fragments:[{id:randomUUID(),kind:'derived',text:'A selected explanation',sourceRefs:[ref]}],keyMessageRefs:[ref]};
  const request={shareId:randomUUID(),roomId,expectedMemberRevision:(await chat.get(b,roomId)).memberRevision,audience:'room-authorized-members',content};
  loseNext=true;await assert.rejects(shared.publish(b,request),/chat_delivery_unknown/);
  const pending=await shared.get(b,{roomId,shareId:request.shareId});assert.equal(pending.state,'pending');await assert.rejects(shared.get(a,{roomId,shareId:request.shareId}),/unavailable/);
  await assert.rejects(shared.publish(b,{...request,content:{...content,generator:{kind:'user-model'}}}),/operation_conflict/);
  const published=await shared.publish(b,request);assert.equal(published.state,'published');assert.equal(published.publicationPermission,false);assert.equal(published.sourceFacts[0].authorId,a.subjectId);
  assert.equal(calls.at(-1).messageId,calls.at(-2).messageId,'Lost reply uses the same MAM ID');assert(!calls.at(-1).text.includes(content.fragments[0].text),'MAM notice stores no copied derived body');
  assert.equal((await chat.history(a,roomId)).messages.find(r=>r.messageId===published.messageId).sharedSummaryId,request.shareId);
  await assert.rejects(chat.edit(b,roomId,published.messageId,{operationId:randomUUID(),expectedRevision:1,text:'Replace selected share implicitly'}),/shared_summary_use_new_version/);
  const callsBeforeReplay=calls.length;assert.equal((await shared.publish(b,request)).messageId,published.messageId);assert.equal(calls.length,callsBeforeReplay);
  content.fragments[0].text='Later private editing';assert.equal((await shared.get(a,{roomId,shareId:request.shareId})).content.fragments[0].text,'A selected explanation','Personal mutation never changes independent share');
  await assert.rejects(shared.get(c,{roomId,shareId:request.shareId}),/access_denied/);
  const otherRoom=randomUUID();await chat.create(b,{roomId:otherRoom,operationId:randomUUID(),title:'No cross-room source'});
  await assert.rejects(shared.publish(b,{...request,shareId:randomUUID(),roomId:otherRoom,expectedMemberRevision:1}),/sources_unavailable/);
  await invite(chat,a,roomId,c,[b]);assert.equal((await shared.get(c,{roomId,shareId:request.shareId})).state,'published','Joint invitation retains authorized historical shares');
  await assert.rejects(shared.publish(b,{...request,shareId:randomUUID()}),/audience_changed/);
  const current=await chat.get(b,roomId),next={...request,shareId:randomUUID(),expectedMemberRevision:current.memberRevision};
  const usage=await subjectResourceUsage(f.db,b.subjectId,f.now());chat.access.resourceBudgetPolicy={...defaultResourceBudgetPolicy,maxPayloadBytesPerSubject:Number(usage.payloadBytes)};
  const beforeQuota=calls.length;await assert.rejects(shared.publish(b,next),/storage_quota_exceeded/);assert.equal(calls.length,beforeQuota);assert.equal((await f.db.query('SELECT share_id FROM room_shared_summaries WHERE share_id=$1',[next.shareId])).rows.length,0);
  chat.access.resourceBudgetPolicy=null;
  const concurrent=await Promise.all([shared.publish(b,next),shared.publish(b,next)]);assert.equal(concurrent[0].messageId,concurrent[1].messageId);
  const deletionId=randomUUID();await f.db.query(`INSERT INTO deletion_requests(id,subject_id,binding_id,requester_public_key,payload_text,payload_hash,signature,state,revision)
   VALUES($1,$2,$3,'fixture-public-key','{}','fixture-hash','fixture-signature','requested',1)`,[deletionId,a.subjectId,a.bindingId]);
  assert.equal((await shared.get(b,{roomId,shareId:request.shareId})).content.fragments.length,0);await shared.purgeInvalidSources();
  assert.equal((await f.db.query('SELECT content FROM room_shared_summaries WHERE share_id=$1',[request.shareId])).rows[0].content.fragments.length,1);
  await f.db.query("UPDATE deletion_requests SET state='cancelled' WHERE id=$1",[deletionId]);assert.equal((await shared.get(b,{roomId,shareId:request.shareId})).content.fragments.length,1);
  const correction=await shared.publish(b,{...next,shareId:randomUUID(),supersedesShareId:request.shareId});assert.equal(correction.supersedesShareId,request.shareId);assert.equal((await shared.get(a,{roomId,shareId:request.shareId})).content.fragments[0].text,'A selected explanation');
  await assert.rejects(shared.retract(a,{roomId,shareId:correction.shareId}),/author_required/);await shared.retract(b,{roomId,shareId:correction.shareId});assert.equal((await shared.get(a,{roomId,shareId:correction.shareId})).state,'retracted');
  await chat.retract(a,roomId,m.messageId);assert((await shared.purgeInvalidSources()).changed>0);assert.equal((await shared.get(c,{roomId,shareId:request.shareId})).content.fragments.length,0);
  const manual={...next,shareId:randomUUID(),content:{generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'0',complete:false},fragments:[{id:randomUUID(),kind:'personal-note',text:'My independently selected note',sourceRefs:[]}],keyMessageRefs:[]}};
  const v=await shared.publish(b,manual);assert.equal(Date.parse(v.expiresAt)-Date.parse(v.createdAt),90*86400000);
  const d=randomUUID(),r=await chat.get(a,roomId);await chat.proposeDecision(a,roomId,{decisionId:d,expectedRevision:r.revision,action:'retention',retentionDays:7});await chat.voteDecision(b,roomId,{decisionId:d,choice:'approve'});await chat.voteDecision(c,roomId,{decisionId:d,choice:'approve'});
  const short=await shared.publish(b,{...manual,shareId:randomUUID()});assert.equal(Date.parse(short.expiresAt)-Date.parse(short.createdAt),7*86400000);assert.equal((await shared.get(b,{roomId,shareId:v.shareId})).expiresAt,v.expiresAt);
  await f.db.query('UPDATE room_shared_summaries SET created_at=$2,expires_at=$3 WHERE share_id=$1',[short.shareId,new Date((f.now()-10)*1000).toISOString(),new Date((f.now()-1)*1000).toISOString()]);
  await shared.purgeExpired();assert.deepEqual((await shared.get(b,{roomId,shareId:short.shareId})).content,{});
  await chat.leave(c,roomId);await assert.rejects(shared.get(c,{roomId,shareId:v.shareId}),/access_denied/);
  return{sameRoom:true,sharedVersionIndependent:true,stableMessageRetry:true,temporaryRestrictionRestored:true,sourceRetractionCleared:true,resourceBudgetBeforeSend:true,modelCalls:0,actualProsody:false};
 }finally{await f.close();}
}
