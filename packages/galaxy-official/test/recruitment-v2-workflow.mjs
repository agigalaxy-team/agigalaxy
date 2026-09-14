import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyContactsV2 } from './contacts-v2-workflow.mjs';
import { approveFixtureDeletion } from './deletion-execute-workflow.mjs';
import { executeDeletion } from '../src/operations/deletion-execute.mjs';

export async function verifyRecruitmentV2(database=null,options={}){
 return verifyContactsV2(database,{...options,afterWorkflow:async({f,p,request,project,task})=>{
  const admin=options.adminDatabase??f.db;let projectRevision=1;
  const projectRole=async(kind,role)=>{const event={operationId:randomUUID(),projectId:project.projectId,expectedRevision:projectRevision,kind,subjectId:f.actor.subjectId,role};
   await request(p,'/v2/projects',await p.authorize(event,'project.write',{objectId:event.operationId,visibility:'Public',purpose:'public-profile'}));projectRevision++;};
  const recruitmentId=randomUUID(),doc={title:'Long term parser co-maintainer',role:'Discuss and maintain table extraction',summary:'Ongoing role; specific deliveries decided separately',
   functions:['table-extraction'],technologies:['Go'],conditions:'Flexible availability; no completed history required',contactSubjectId:f.actor.subjectId};
  const write=async(who,kind,expectedRevision,extra={},status=200)=>{
   const event={operationId:randomUUID(),recruitmentId,projectId:project.projectId,expectedRevision,kind,...extra};
   const pub=['create','revise','renew'].includes(kind),grant=await who.authorize(event,'recruitment.write',{objectId:event.operationId,
    visibility:pub?'Public':'Private',purpose:pub?'public-profile':'operational'});
   return{event,grant,receipt:await request(who,'/v2/recruitment',grant,status)};
  };
  await projectRole('grant-role','editor');
  await write(f,'create',0,{document:doc,expiresAt:f.now+30*86400},403);
  await projectRole('grant-role','representative');
  await write(f,'create',0,{document:doc,expiresAt:f.now+31*86400},400);
  const created=await write(f,'create',0,{document:doc,expiresAt:f.now+30*86400});
  assert.equal(created.receipt.taskAutomaticallyCreated,false);
  assert.equal((await request(f,'/v2/recruitment',created.grant)).replayed,true);
  const context={kind:'ephemeral',title:'Looking for an ongoing role',functions:['table-extraction'],technologies:['Rust']};
  const query={context,purposes:['recruitment']};
  const page=await request(p,'/v2/discovery/query',query),card=page.items.find(i=>i.recruitmentId===recruitmentId);
  assert.ok(card);assert.equal(card.help.commitment,'not-contacted');assert.equal(card.experience.status,'not-loaded');
  assert.deepEqual(card.match.differences.candidateOnlyTechnologies,['go']);
  const detail=await request(p,'/v2/discovery/detail',{...query,opportunityRef:card.opportunityRef});assert.equal(detail.opportunity.recruitmentId,recruitmentId);
  const initialTasks=(await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n;
  assert.equal(initialTasks,1);
  await projectRole('revoke-role','representative');
  assert.equal((await request(p,'/v2/discovery/query',query)).items.some(i=>i.recruitmentId===recruitmentId),false);
  assert.equal((await request(null,'/v2/recruitment/'+recruitmentId,null)).acceptingContacts,false);
  await projectRole('grant-role','representative');
  const contact=(opportunityRef)=>({operationId:randomUUID(),contactId:randomUUID(),expectedRevision:0,kind:'send',recipientId:f.actor.subjectId,
   purpose:'recruitment',context,opportunityRef,note:'Interested in talking about this role',roomTitle:'Recruitment conversation'});
  const contactWrite=async(who,event,other,status=200)=>request(who,'/v2/contacts',await who.authorize(event,'contact.write',{objectId:event.operationId,viewers:[other.actor.subjectId]}),status);
  const first=contact(card.opportunityRef);await contactWrite(p,first,f);
  const accepted=await contactWrite(f,{operationId:randomUUID(),contactId:first.contactId,expectedRevision:1,kind:'accept',note:'Discuss role scope'},p);
  assert.equal((await request(f,`/v2/chat/rooms/${accepted.roomId}/read`)).kind,'ordinary');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,initialTasks,'recruitment acceptance is not a new task');
  const second=contact(card.opportunityRef);await contactWrite(p,second,f);
  await write(f,'pause',1,{note:'Pause new conversations'});
  const awaitingAcceptance={operationId:randomUUID(),contactId:second.contactId,expectedRevision:1,kind:'accept',note:'Now available'};
  await contactWrite(f,awaitingAcceptance,p,403);
  const limited=await write(f,'renew',2,{document:doc,expiresAt:f.now+30*86400},429);
  assert.equal(limited.receipt.error,'community_quota_exceeded','Task publication and Recruitment share default daily publication allowance');
  await projectRole('revoke-role','representative');
  await write(f,'close',2,{},403);
  const ownerDocument={...doc,contactSubjectId:p.actor.subjectId,summary:'Owner continues the role after representative withdrawal'};
  const renewed=await write(p,'renew',2,{document:ownerDocument,expiresAt:f.now+30*86400});
  assert.equal(renewed.receipt.publisherId,p.actor.subjectId);
  await contactWrite(f,awaitingAcceptance,p,403,'old exact source does not change recipient after takeover');
  await contactWrite(p,{operationId:randomUUID(),contactId:second.contactId,expectedRevision:1,kind:'withdraw'},f);
  const newCard=(await request(f,'/v2/discovery/query',query)).items.find(i=>i.recruitmentId===recruitmentId);assert.equal(newCard.subjectId,p.actor.subjectId);
  assert.equal((await request(null,'/v2/recruitment/query',{view:'discover',context})).items.some(i=>i.recruitmentId===recruitmentId),true);
  // Move the durable deadline to simulate an elapsed review period while the
  // synthetic short-lived authentication session remains usable.
  await admin.query('UPDATE recruitment_opportunities SET expires_at=$2 WHERE id=$1',[recruitmentId,new Date((f.now-1)*1000).toISOString()]);
  assert.equal((await request(null,'/v2/recruitment/'+recruitmentId,null)).state,'expired');
  assert.equal((await request(f,'/v2/discovery/query',query)).items.some(i=>i.recruitmentId===recruitmentId),false);
  await write(p,'renew',3,{document:ownerDocument,expiresAt:f.now+30*86400});
  const concrete={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',title:'One concrete parser review',summary:'Specific review from ongoing role discussion',
   workContext:{goal:'Review one boundary',currentSituation:'Working parser',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+3600};
  await request(p,'/v2/tasks',await p.authorize(concrete,'assistance.publish',{objectId:concrete.operationId}));
  await write(p,'link-task',4,{taskId:task.taskId,expectedTaskVersion:4},403);
  const linked=await write(p,'link-task',4,{taskId:concrete.taskId,expectedTaskVersion:1});
  assert.equal((await request(p,'/v2/recruitment',linked.grant)).replayed,true);
  const view=await request(p,'/v2/recruitment/'+recruitmentId,null);assert.equal(view.taskLinks.length,1);assert.equal(view.taskLinks[0].taskId,concrete.taskId);
  assert.deepEqual((await request(null,'/v2/recruitment/'+recruitmentId,null)).taskLinks,[],'linked private Task IDs are not broadcast');
  const before=await request(p,'/v2/tasks/'+concrete.taskId,null);
  await write(p,'pause',5);assert.equal((await request(p,'/v2/tasks/'+concrete.taskId,null)).version,before.version);
  assert.equal((await request(p,'/v2/tasks/'+concrete.taskId,null)).state,before.state);
  await write(p,'close',6);await write(p,'renew',7,{document:ownerDocument,expiresAt:f.now+86400},409);
  const managed=await request(p,'/v2/recruitment/query',{view:'managed'});assert.ok(managed.items.some(i=>i.recruitmentId===recruitmentId&&i.state==='closed'));
  const ticket=await f.dataExport.create(f.actor,{id:randomUUID(),datasets:['recruitment-opportunities','recruitment-events','recruitment-task-links','community-write-receipts']});
  for(const dataset of ticket.datasets)await f.dataExport.page(f.actor,{id:ticket.id,dataset});
  const events=(await f.dataExport.page(f.actor,{id:ticket.id,dataset:'recruitment-events'})).items;
  assert.ok(events.some(e=>e.operation_id===created.event.operationId));assert.ok(events.every(e=>e.subject_id===f.actor.subjectId));
  const receipts=(await f.dataExport.page(f.actor,{id:ticket.id,dataset:'community-write-receipts'})).items;
  assert.ok(receipts.some(e=>e.recruitment_id===recruitmentId&&e.task_id===null&&e.category==='task'));
  const ownerExport=await p.dataExport.create(p.actor,{id:randomUUID(),datasets:['authorized-views'],views:[{kind:'recruitment',id:recruitmentId}]});
  assert.equal((await p.dataExport.page(p.actor,{id:ownerExport.id,dataset:'authorized-views'})).items[0].view.recruitmentId,recruitmentId);
  const independent=(await admin.query('SELECT * FROM recruitment_events WHERE operation_id=$1',[renewed.event.operationId])).rows[0];
  const deletion=await approveFixtureDeletion(f,admin,{auditUntil:f.now+60});
  const result=await executeDeletion(admin,deletion,{now:()=>f.now});assert.equal(result.serviceWideDeletionComplete,false);
  assert.equal((await admin.query('SELECT count(*)::int n FROM recruitment_events WHERE subject_id=$1',[f.actor.subjectId])).rows[0].n,0);
  assert.deepEqual((await admin.query('SELECT * FROM recruitment_events WHERE operation_id=$1',[renewed.event.operationId])).rows[0],independent);
  assert.equal((await request(p,'/v2/recruitment/'+recruitmentId,null)).document.contactSubjectId,p.actor.subjectId);
  assert.equal((await request(p,'/v2/tasks/'+concrete.taskId,null)).version,before.version);
  if(options.afterRecruitment)await options.afterRecruitment({f,p,request,recruitmentId,created,renewed,linked,concrete,project});
 }});
}
