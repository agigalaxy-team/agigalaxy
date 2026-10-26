import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {privacyConsumerFixture} from '../../galaxy-official/test/privacy-consumer-continuity-workflow.mjs';
import {createQualificationPermissionClient} from "../src/features/qualification-permissions/qualification-permission-client.mjs";
import {getContributionClient} from "../src/features/work-records/contribution-client.mjs";

async function fixture(t){
 const f=await privacyConsumerFixture();t.after(()=>f.close());const {runtime:peer}=await f.makeOther(),peerId=(await peer.status()).identity.subjectId,
  input={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'collaboration',title:'[合成] 当前可读的材料用途',summary:'没有预算或付费资格',
   workContext:{goal:'查看准确许可来源',currentSituation:'隔离签名与原权限',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now()+3600};
 const signed=await f.runtime.api.authorizePayload(input,{action:'assistance.publish',objectId:input.operationId,visibility:'Private',viewers:[peerId],confirmed:true});
 await f.runtime.api.call('/v2/tasks',signed);
 const ownerClient=createQualificationPermissionClient({runtime:f.runtime,subjectId:f.original.subjectId,now:f.now}),
  peerClient=createQualificationPermissionClient({runtime:peer,subjectId:peerId,now:f.now});
 const grant=async(ref,extra={})=>{const payload={id:randomUUID(),kind:'source-permission',taskId:input.taskId,candidateId:peerId,recipientId:f.original.subjectId,
   purpose:'this-task-eligibility-computation-only',expiresAt:new Date((f.now()+1800)*1000).toISOString(),sourceRefs:[ref],
   disclosure:'public-conditions-and-bounded-satisfaction-only; no-source-text-or-other-party-identity',...extra};
  const signature=await f.runtime.api.authorizePayload(payload,{action:'qualification.source-permission',objectId:payload.id,visibility:'Private',viewers:[peerId],confirmed:true});
  await f.runtime.api.call('/v2/qualification/calculation-permissions',signature);
  return(await ownerClient.grants({taskId:input.taskId})).items.find(row=>row.id===payload.id);
 };
 return{...f,peer,peerId,ownerClient,peerClient,task:input,grant};
}

test('current permission details show independently readable titles and selected facts, never infer source access from a material license',async t=>{
 const f=await fixture(t),caseId=f.marker.slice('SYNTHETIC_PRIVATE_EXPORT_'.length),
  source=(await f.runtime.api.call('/v2/contributions/sources',{kind:'case-event',parentId:caseId})).items[0].source,
  permit=await f.grant(source),details=await f.ownerClient.grantDetails(permit);
 assert.equal(details.target.title,f.task.title);assert.equal(details.materials[0].available,true);
 assert.equal(details.materials[0].title,'Synthetic privacy continuity');assert.equal(details.materials[0].summary,f.marker);
 let denied=await f.peerClient.grantDetails(permit);
 assert.equal(denied.materials[0].available,false);assert.equal(denied.materials[0].title,null);assert.equal(denied.materials[0].summary,null);
 assert.equal(JSON.stringify(denied).includes(f.marker),false);
 const publication={kind:'publish',sourceRefs:[{...source,fields:['eventType','actorId','title','summary']}],purposes:['honor'],
  purpose:'public-contribution-projections-only',expiresAt:new Date((f.now()+1800)*1000).toISOString(),redactionConfirmed:true,
  publicationScope:'selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged'};
 await getContributionClient(f.runtime,f.original.subjectId,{now:f.now}).submit(publication,{confirmed:true});
 denied=await f.peerClient.grantDetails(permit);assert.equal(denied.materials[0].reason,'independent-source-read-required');
 assert.equal(denied.materials[0].title,null);assert.equal(JSON.stringify(denied).includes(f.marker),false);
 const consent=(await f.f.db.query('SELECT consent_id FROM case_events WHERE id=$1',[source.id])).rows[0].consent_id;
 await f.runtime.api.call('/v1/consents/'+consent+'/revoke',{});
 const withdrawn=await f.ownerClient.grantDetails(permit);assert.equal(withdrawn.materials[0].available,false);
 assert.equal(withdrawn.materials[0].title,null);assert.equal(withdrawn.materials[0].summary,null);
});

test('owned computation details recheck foreign original reading; a changed connection cannot expose a late material projection',async t=>{
 const f=await fixture(t),caseId=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:f.original.subjectId,
  localRef:randomUUID(),title:'[合成] 独立允许阅读的他人工作',summary:'当前原权限允许的有限事实',synthetic:true,source:{kind:'local',reference:randomUUID()}},
  signature=await f.runtime.api.authorizePayload(root,{action:'case.teaser.publish',objectId:caseId,visibility:'Private',viewers:[f.peerId],confirmed:true});
 await f.runtime.api.call('/v2/cases/events',signature);
 const source=(await f.runtime.api.call('/v2/contributions/sources',{kind:'case-event',parentId:caseId})).items[0].source,
  permit=await f.grant(source),compute={...permit.payload,id:randomUUID(),kind:'compute',permissionIds:[permit.id],
   evidence:{participationIds:[],externalReviewRefs:[],capsuleUseIds:[],proofIds:[],assistanceIds:[]}},
  signed=await f.peer.api.authorizePayload(compute,{action:'qualification.compute',objectId:compute.id,visibility:'Private',viewers:[f.original.subjectId],confirmed:true});
 await f.peer.api.call('/v2/qualification/calculation-permissions',signed);
 const selected=(await f.peerClient.grants({})).items.find(row=>row.id===compute.id),details=await f.peerClient.grantDetails(selected);
 assert.equal(details.materials[0].available,true);assert.equal(details.materials[0].title,root.title);
 let changed=true;f.wireHooks.after=async(path,response)=>{if(changed&&path==='/v2/contributions/read'){changed=false;assert.equal(response.status,200);await f.peer.connect({confirmed:true});}};
 await assert.rejects(f.peerClient.grantDetails(selected),/receipt_status_authority_changed|Authorization changed during request/);
});
