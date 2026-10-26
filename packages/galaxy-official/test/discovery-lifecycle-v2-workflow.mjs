import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyContactsV2 } from './contacts-v2-workflow.mjs';
import { approveFixtureDeletion } from './deletion-execute-workflow.mjs';
import { executeDeletion,lockDeletionTables } from '../src/operations/deletion-execute.mjs';
import { cleanupProductV2Retention } from '../src/operations/lifecycle-retention-v2.mjs';
import { productV2ExportDatasets } from '../src/infrastructure/lifecycle-export-v2.mjs';
import { transaction } from "../src/infrastructure/database.mjs";

export async function verifyDiscoveryLifecycleV2(database=null,options={}) {
 return verifyContactsV2(database,{...options,afterWorkflow:async({f,p,request,project,contact,contactAcceptance,room,task})=>{
  const admin=options.adminDatabase??f.db,iso=n=>new Date(n*1000).toISOString();
  const projectEvent=async(who,kind,expectedRevision,extra={})=>{
   const event={operationId:randomUUID(),projectId:project.projectId,kind,expectedRevision,...extra};
   const grant=await who.authorize(event,'project.write',{objectId:event.operationId,visibility:'Public',purpose:'public-profile'});
   await request(who,'/v2/projects',grant);return event;
  };
  await projectEvent(p,'grant-role',1,{subjectId:f.actor.subjectId,role:'editor'});
  const edited=await projectEvent(f,'revise',2,{patch:{summary:'DELETING_AUTHOR_CURRENT_SUMMARY'}});
  await p.projects.savePreferences(p.actor,project.projectId,{expectedRevision:0,preferences:{enabled:true}});
  await f.projects.savePreferences(f.actor,project.projectId,{expectedRevision:0,preferences:{enabled:true}});
  const current=(await p.projects.get(p.actor,project.projectId)).document;
  assert.equal(current.summary,'DELETING_AUTHOR_CURRENT_SUMMARY');

  // Synthetic transport reference is only a lifecycle fixture. No chat delivery
  // claim is made; the real summary API validates the current durable reference.
  const messageId=randomUUID();
  await admin.query(`INSERT INTO chat_message_refs(message_id,room_id,subject_id,client_message_id,payload_hash,actor_kind,state,sent_at,expires_at)
    VALUES($1,$2,$3,$4,$5,'human','accepted',$6,$7)`,[messageId,room.roomId,p.actor.subjectId,randomUUID(),'a'.repeat(64),iso(f.now),iso(f.now+86400)]);
  const summaryId=randomUUID();
  await f.summaries.savePreference(f.actor,{expectedRevision:0,endpoint:f.access.endpoint,enabled:true});
  await f.summaries.put(f.actor,{summaryId,versionId:randomUUID(),roomId:room.roomId,baseRevision:0,preferenceRevision:1,
   content:{generator:{kind:'user-model'},coverage:{fromSequence:'0',throughSequence:'1',complete:true},
    fragments:[{id:randomUUID(),kind:'derived',text:'PRIVATE_SUMMARY_SOURCE',sourceRefs:[{messageId,revision:1}]}],keyMessageRefs:[]}});
  const foreignSummaryId=randomUUID();
  await p.summaries.savePreference(p.actor,{expectedRevision:0,endpoint:p.access.endpoint,enabled:true});
  await p.summaries.put(p.actor,{summaryId:foreignSummaryId,versionId:randomUUID(),roomId:room.roomId,baseRevision:0,preferenceRevision:1,
   content:{generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'1',complete:true},
    fragments:[{id:randomUUID(),kind:'personal-note',text:'INDEPENDENT_PRIVATE_NOTE',sourceRefs:[]}],keyMessageRefs:[]}});

  // Typed receipt fixtures test deletion ownership, not experience qualification.
  const experienceId=randomUUID(),reviewId=randomUUID(),operationId=randomUUID(),reviewOp=randomUUID();
  const payload={id:operationId,summary:'EXPERIENCE_PRIVATE_BODY'},grant=await f.authorize(payload,'profile.publish');
  const reviewPayload={id:reviewOp,summary:'OTHER_REVIEW_BODY'},reviewGrant=await p.authorize(reviewPayload,'profile.publish');
  await admin.query("INSERT INTO experience_objects(id,object_type,subject_id,version,state,source_key) VALUES($1,'experience',$2,1,'active',$3)",[experienceId,f.actor.subjectId,'a'.repeat(64)]);
  await admin.query("INSERT INTO experience_objects(id,object_type,subject_id,version,state,experience_id) VALUES($1,'review',$2,1,'active',$3)",[reviewId,p.actor.subjectId,experienceId]);
  for(const row of [{id:operationId,obj:experienceId,grant},{id:reviewOp,obj:reviewId,grant:reviewGrant}])
   await admin.query("INSERT INTO experience_events(operation_id,object_id,version,consent_id,payload_text,payload_hash,context) VALUES($1,$2,1,$3,$4,$5,$6)",
    [row.id,row.obj,row.grant.consentId,row.grant.payloadJson,'b'.repeat(64),JSON.stringify({source:'SYNTHETIC_PRIVATE_CONTEXT'})]);
  const otherReviewBefore=(await admin.query('SELECT * FROM experience_events WHERE operation_id=$1',[reviewOp])).rows[0];
  const qualificationGrantId=randomUUID();
  await admin.query('INSERT INTO qualification_calculation_grants(id,subject_id,task_id,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6)',
   [qualificationGrantId,f.actor.subjectId,task.taskId,grant.consentId,'SYNTHETIC_TASK_PERMISSION','c'.repeat(64)]);
  const shareId=randomUUID(),otherShareId=randomUUID();
  for(const x of [{id:shareId,who:f,parent:null,text:'OWN_SHARED_BODY'},{id:otherShareId,who:p,parent:shareId,text:'OTHER_SHARED_BODY'}])
   await admin.query(`INSERT INTO room_shared_summaries(share_id,subject_id,room_id,member_revision,request_hash,notice_hash,supersedes_share_id,state,content,source_facts,created_at,expires_at)
     VALUES($1,$2,$3,2,$4,$4,$5,'published',$6,$7,$8,$9)`,[x.id,x.who.actor.subjectId,room.roomId,'d'.repeat(64),x.parent,JSON.stringify({syntheticBody:x.text}),JSON.stringify([{syntheticSource:x.text}]),iso(f.now),iso(f.now+86400)]);
  const otherShareBefore=(await admin.query('SELECT * FROM room_shared_summaries WHERE share_id=$1',[otherShareId])).rows[0];

  const selectedViews=[{kind:'project',id:project.projectId},{kind:'contact',id:contact.contactId},{kind:'personal-summary',id:summaryId}];
  const ticket=await f.dataExport.create(f.actor,{id:randomUUID(),datasets:[...productV2ExportDatasets,'authorized-views'],views:selectedViews});
  for(const dataset of productV2ExportDatasets)await f.dataExport.page(f.actor,{id:ticket.id,dataset});
  const source=await f.dataExport.page(f.actor,{id:ticket.id,dataset:'project-events-v2'});
  assert.ok(source.items.some(x=>x.operation_id===edited.operationId));assert.ok(source.items.every(x=>x.subject_id===f.actor.subjectId));
  const contactEvents=await f.dataExport.page(f.actor,{id:ticket.id,dataset:'contact-events-v2'});
  assert.equal(contactEvents.items.some(x=>x.operation_id===contactAcceptance.operationId),false,'raw export excludes the other party choice');
  assert.equal((await f.dataExport.page(f.actor,{id:ticket.id,dataset:'personal-summary-version-receipts'})).items.some(x=>'content' in x),false);
  const sharedReceipts=(await f.dataExport.page(f.actor,{id:ticket.id,dataset:'room-shared-summary-receipts'})).items;
  assert.equal(sharedReceipts.length,1);assert.equal('content' in sharedReceipts[0],false);assert.equal('source_facts' in sharedReceipts[0],false);
  assert.equal((await f.dataExport.page(f.actor,{id:ticket.id,dataset:'qualification-calculation-grants'})).items[0].id,qualificationGrantId);
  let cursor='';const views=[];for(let i=0;i<3;i++){const page=await f.dataExport.page(f.actor,{id:ticket.id,dataset:'authorized-views',after:cursor});views.push(...page.items);cursor=page.nextAfter??'';}
  assert.ok(JSON.stringify(views[2]).includes('PRIVATE_SUMMARY_SOURCE'));
  await admin.query("UPDATE chat_message_refs SET state='retracted',retracted_at=$2 WHERE message_id=$1",[messageId,iso(f.now)]);
  assert.ok(!JSON.stringify(await f.dataExport.page(f.actor,{id:ticket.id,dataset:'authorized-views',after:'00000002'})).includes('PRIVATE_SUMMARY_SOURCE'));
  assert.equal((await f.dataExport.page(f.actor,{id:ticket.id,dataset:'experience-events'})).items.some(x=>x.operation_id===reviewOp),false);

  await admin.query('UPDATE contact_events_v2 SET created_at=$2 WHERE operation_id=$1',[contact.operationId,iso(f.now-90*86400)]);
  const expired=await f.dataExport.page(f.actor,{id:ticket.id,dataset:'contact-events-v2'});
  assert.equal(expired.items[0].payload_text,'');assert.equal(expired.items[0].content_expired,true);
  const cleanup=await cleanupProductV2Retention(options.workerDatabase??admin,{now:()=>f.now});
  assert.equal(cleanup.removed.temporaryContactBodies,1);
  assert.equal((await admin.query('SELECT payload_text FROM contact_events_v2 WHERE operation_id=$1',[contact.operationId])).rows[0].payload_text,'');
  assert.ok((await admin.query('SELECT payload_text FROM contact_events_v2 WHERE operation_id=$1',[contactAcceptance.operationId])).rows[0].payload_text.includes(contactAcceptance.note));

  await transaction(admin,lockDeletionTables);
  const deletion=await approveFixtureDeletion(f,admin,{auditUntil:f.now+60}),result=await executeDeletion(admin,deletion,{now:()=>f.now});
  assert.equal(result.serviceWideDeletionComplete,false);
  assert.equal((await admin.query('SELECT owner_id,state FROM projects_v2 WHERE id=$1',[project.projectId])).rows[0].state,'active');
  const retained=(await admin.query('SELECT payload_text,affected_fields FROM project_events_v2 WHERE operation_id=$1',[edited.operationId])).rows[0];
  assert.equal(retained.payload_text,'');assert.deepEqual(retained.affected_fields,['summary']);
  await assert.rejects(p.projects.get(p.actor,project.projectId),/project_source_unavailable/);
  await projectEvent(p,'revise',3,{patch:{summary:'OWNER_REPLACEMENT'}});
  assert.equal((await p.projects.get(p.actor,project.projectId)).document.summary,'OWNER_REPLACEMENT');
  assert.equal((await admin.query('SELECT count(*)::int n FROM personal_summary_versions WHERE subject_id=$1',[f.actor.subjectId])).rows[0].n,0);
  assert.equal((await admin.query('SELECT count(*)::int n FROM qualification_calculation_grants WHERE subject_id=$1',[f.actor.subjectId])).rows[0].n,0);
  const ownShare=(await admin.query('SELECT content,source_facts,state FROM room_shared_summaries WHERE share_id=$1',[shareId])).rows[0];
  assert.deepEqual(ownShare,{content:{},source_facts:[],state:'retracted'});
  assert.deepEqual((await admin.query('SELECT * FROM room_shared_summaries WHERE share_id=$1',[otherShareId])).rows[0],otherShareBefore);
  assert.ok(JSON.stringify(await p.summaries.get(p.actor,{summaryId:foreignSummaryId})).includes('INDEPENDENT_PRIVATE_NOTE'));
  assert.deepEqual((await admin.query('SELECT * FROM experience_events WHERE operation_id=$1',[reviewOp])).rows[0],otherReviewBefore);
  const ownExperience=(await admin.query('SELECT payload_text,context FROM experience_events WHERE operation_id=$1',[operationId])).rows[0];
  if(ownExperience){assert.equal(ownExperience.payload_text,'');assert.deepEqual(ownExperience.context,{});}
  assert.equal((await p.contacts.get(p.actor,contact.contactId)).events.some(e=>e.note===contactAcceptance.note),true);
  assert.equal(result.delegatedStores.chat.primaryReferenceDeletionIsBodyDeletion,false);
 }});
}
