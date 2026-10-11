import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {ChatService} from '../src/chat.mjs';
import {ChatAttachmentsService} from '../src/chat-attachments.mjs';
import {OutcomeMaterialServiceV2} from '../src/outcome-material-v2.mjs';
import {loadAttachmentConfiguration} from '../src/infrastructure/attachment-configuration.mjs';
import {serviceFixture} from './service-fixture.mjs';
import {invite} from './chat-workflow.mjs';
import {digest} from '../src/shared/digest.mjs';

const id=()=>randomUUID();
test('outcome material attachment copy uses the configured real store and scanner',{timeout:180000},async()=>{
 assert.equal(process.env.GALAXY_TEST_CHAT_ISOLATED,'1');
 const configuration=await loadAttachmentConfiguration();assert.ok(configuration);
 const a=await serviceFixture(['binding','consent','case-teaser','evidence'],null,{syntheticCommunityQuota:false});
 const b=await serviceFixture(['binding','consent','case-teaser','evidence'],a.db,{migrateDatabase:false,syntheticCommunityQuota:false});
 const messages=new Map();
 const transport={available:true,async project(){},async send(x){messages.set(x.messageId,{archiveId:x.messageId,text:x.text,revision:1});return {archiveId:x.messageId};},async read(x){return x.ids.map(k=>messages.get(k)).filter(Boolean);},async erase(x){messages.delete(x.archiveId??x.messageId);return{archiveDeleted:true};}};
 const chat=new ChatService({db:a.db,access:a.access,transport,now:()=>a.now,requireAccountWithin:async()=>{},consumeInviteWithin:async()=>{},markInviteRespondedWithin:async()=>{}});
 const attachments=new ChatAttachmentsService({chat,store:configuration.store,scanner:configuration.scanner});chat.attachments=attachments;
 const materials=new OutcomeMaterialServiceV2(a.access,{consents:a.consents,chat,records:a.verificationRecords,attachments});
 try{
  const caseId=id();
  const root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:a.actor.subjectId,localRef:'real-outcome-'+caseId,title:'真实成果材料对象存储测试',summary:'隔离测试',source:{kind:'local',reference:'real-outcome'},synthetic:true};
  await a.cases.submitV2(a.actor,await a.authorize(root,'case.teaser.publish',{objectId:caseId}));
  const attemptId=id(),attempt={schemaVersion:2,kind:'attempt-start',eventId:attemptId,caseId,expectedVersion:1,actorId:a.actor.subjectId,role:'implementation',strategy:'real outcome material',inputScopeSummary:'isolated',permissionScope:['selected-context'],environment:{name:'Node',version:'24'}};
  await a.cases.submitV2(a.actor,await a.authorize(attempt,'case.teaser.publish',{objectId:attemptId}));
  const roomId=id();await chat.create(a.actor,{roomId,operationId:id(),title:'真实成果材料隔离房间'});await invite(chat,a.actor,roomId,b.actor);
  const bytes=Buffer.from('isolated real outcome material\n'),attachmentId=id();
  const input={attachmentId,roomId,name:'outcome.txt',mediaType:'text/plain',size:bytes.length,sha256:digest(bytes),purpose:'temporary-room-attachment',confirmed:true};
  await attachments.prepare(b.actor,input);await attachments.upload(b.actor,attachmentId,Readable.from([bytes]),{contentLength:bytes.length});await attachments.scanPending({limit:2});
  assert.equal((await attachments.get(b.actor,{attachmentId})).state,'available');
  const sent=await chat.send(b.actor,roomId,{clientMessageId:id(),text:'author-selected source',attachments:[{id:attachmentId,sha256:input.sha256}]});
  const source={kind:'attachment',id:attachmentId,version:1,sha256:input.sha256,roomId},materialId=id(),requestId=id();
  const request={id:requestId,materialId,kind:'request',source,caseId,purpose:'保存真实选定附件',title:'真实成果附件',audience:{visibility:'Private',viewers:[a.actor.subjectId,b.actor.subjectId]},uses:['evidence'],retention:'with-related-result; independently-authorized-copy',requestExpiresAt:new Date((a.now+3600)*1000).toISOString()};
  const requestConsent=await a.authorize(request,'outcome.material',{objectId:requestId,viewers:[a.actor.subjectId,b.actor.subjectId]});assert.equal((await materials.request(a.actor,{consentId:requestConsent.consentId,payloadJson:requestConsent.payloadJson})).state,'requested');
  const approvalId=id(),approval={id:approvalId,materialId,kind:'approve',expectedRevision:1,requestHash:digest(requestConsent.payloadJson),source,license:'authored-content',basis:'authored-content',scope:'真实隔离成果附件',independentRetention:true,temporarySourceExpiryRevokesCopy:false};
  const approvalConsent=await b.authorize(approval,'outcome.material',{objectId:approvalId,viewers:[a.actor.subjectId]});const approved=await materials.approve(b.actor,{consentId:approvalConsent.consentId,payloadJson:approvalConsent.payloadJson});assert.equal(approved.copyStored,true);
  const read=await materials.read(a.actor,{id:materialId,version:1});assert.equal(Buffer.from(read.bytesBase64,'base64').toString(),bytes.toString());
  const controlId=id(),control={id:controlId,materialId,kind:'revoke',expectedRevision:2,reason:'isolated cleanup'};const controlConsent=await b.authorize(control,'outcome.material',{objectId:controlId});await materials.control(b.actor,{consentId:controlConsent.consentId,payloadJson:controlConsent.payloadJson});
  const purged=await materials.purgeExpired({limit:10});assert.equal(purged.outcomeMaterialCopiesErased,1);assert.equal(await configuration.store.head({key:`outcome-materials/${materialId}`,keyId:configuration.store.keyId}),null);
  assert.ok(sent.messageId);
  console.log(JSON.stringify({transport:'fake-isolated-chat',storage:'real-configured-s3',scanner:'real-configured-clamav',copyStored:true,revocationAndPurge:true,productionStateChanged:false,backupStarted:false}));
 } finally {await attachments.eraseSubject(a.actor.subjectId).catch(()=>{});await attachments.eraseSubject(b.actor.subjectId).catch(()=>{});configuration.store.close();if(b.db!==a.db) await b.db.close().catch(()=>{});await a.db.close().catch(()=>{});}
});
