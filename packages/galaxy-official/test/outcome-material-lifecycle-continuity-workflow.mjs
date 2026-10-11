import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {serviceFixture} from './service-fixture.mjs';
import {attachmentContractFixture} from './chat-attachments-workflow.mjs';
import {OutcomeMaterialServiceV2} from '../src/outcome-material-v2.mjs';
import {createApi} from '../src/http.mjs';

// Actual signed HTTP/PGlite service lifecycle. The object store, scanner and
// chat transport are explicit doubles, not a physical storage/Prosody claim.
export async function outcomeLifecycleFixture(){
 const f=await serviceFixture(['binding','consent','case-teaser','evidence'],null,{now:Math.floor(Date.now()/1000)});
 f.access.now=f.bindings.now=f.consents.now=f.chat.now=f.attachments.now=()=>f.now;
 f.chat.requireAccountWithin=async()=>{};
 f.chat.transport={available:true,project:async()=>{},send:async x=>({archiveId:x.messageId})};
 const contract=attachmentContractFixture();Object.assign(f.attachments,contract);
 const materials=new OutcomeMaterialServiceV2(f.access,{consents:f.consents,chat:f.chat,records:f.verificationRecords,attachments:f.attachments});
 const server=createApi({...f,outcomeMaterials:materials,rateLimit:1000});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const post=async(path,payload)=>{const response=await fetch(base+path,{method:'POST',headers:{Authorization:'Bearer '+f.credential,
  'Content-Type':'application/json'},body:JSON.stringify(payload)});return {status:response.status,body:await response.json()};};
 const roomId=randomUUID(),attachmentId=randomUUID(),bytes=Buffer.from('synthetic independently selected file'),sha256=createHash('sha256').update(bytes).digest('hex');
 await f.chat.create(f.actor,{roomId,operationId:randomUUID(),title:'Outcome independent copy lifecycle'});
 await f.attachments.prepare(f.actor,{attachmentId,roomId,name:'selected.txt',mediaType:'text/plain',size:bytes.length,
  sha256,purpose:'temporary-room-attachment',confirmed:true});
 await f.attachments.upload(f.actor,attachmentId,Readable.from([bytes]),{contentLength:bytes.length});await f.attachments.scanPending();
 return {f,materials,contract,post,attachmentId,roomId,bytes,sha256,
  async close(){server.closeAllConnections();await new Promise(r=>server.close(r));await f.db.close();}};
}

export async function approveOutcomeCopy(x,{requestGrantSeconds=3600,copyPermissionSeconds=300}={}){
 const caseId=randomUUID(),attemptId=randomUUID(),resultId=randomUUID();
 const facts=[
  {schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:x.f.actor.subjectId,
   localRef:'synthetic-'+caseId,title:'Independent selected copy',summary:'Synthetic retained file lifecycle',
   source:{kind:'local',reference:'synthetic-'+caseId},synthetic:true},
  {schemaVersion:2,kind:'attempt-start',eventId:attemptId,caseId,expectedVersion:1,actorId:x.f.actor.subjectId,
   role:'implementation',strategy:'Exact selected input',inputScopeSummary:'Synthetic scope',permissionScope:['selected-context']},
  {schemaVersion:2,kind:'result-recorded',eventId:resultId,caseId,expectedVersion:2,actorId:x.f.actor.subjectId,
   origin:{kind:'attempt',id:attemptId,version:1},scopeVersion:1,deliverableRefs:[],reportedOutcome:'succeeded',
   summary:'Synthetic independent copy',limitations:'Contract fixture; no external qualification'},
 ];
 for(const fact of facts)await x.f.cases.submitV2(x.f.actor,await x.f.authorize(fact,'case.teaser.publish',{objectId:fact.eventId}));
 const materialId=randomUUID(),requestId=randomUUID(),source={kind:'attachment',id:x.attachmentId,version:1,sha256:x.sha256,roomId:x.roomId};
 const request={id:requestId,materialId,kind:'request',source,caseId,purpose:'Exact synthetic independent material',title:'Independent copy',
  audience:{visibility:'Private',viewers:[]},uses:['evidence'],retention:'with-related-result; independently-authorized-copy',
  requestExpiresAt:new Date((x.f.now+requestGrantSeconds)*1000).toISOString()};
 const permission=await x.f.authorize(request,'outcome.material',{objectId:requestId,expiresAt:x.f.now+requestGrantSeconds});
 const requested=await x.post('/v2/outcome-materials/request',permission);assert.equal(requested.status,200,JSON.stringify(requested.body));
 const approvalId=randomUUID(),approval={id:approvalId,materialId,kind:'approve',expectedRevision:1,
  requestHash:createHash('sha256').update(permission.payloadJson).digest('hex'),source,license:'authored-content',basis:'authored-content',
  scope:'Exactly this synthetic selected file',expiresAt:new Date((x.f.now+copyPermissionSeconds)*1000).toISOString(),
  independentRetention:true,temporarySourceExpiryRevokesCopy:false};
 const authorized=await x.f.authorize(approval,'outcome.material',{objectId:approvalId});
 const approved=await x.post('/v2/outcome-materials/approve',authorized);assert.equal(approved.status,200,JSON.stringify(approved.body));
 assert.equal(approved.body.state,'available');
 return {materialId,approvalId,approvalConsentId:authorized.consentId,approvalHash:createHash('sha256').update(authorized.payloadJson).digest('hex'),
  requestId,requestHash:createHash('sha256').update(permission.payloadJson).digest('hex')};
}
