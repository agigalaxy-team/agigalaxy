import { recruitmentEnvelopeV2Schema,recruitmentEventV2Schema,recruitmentQueryV2Schema,
 recruitmentOperationReceiptQuerySchema,recruitmentOperationReceiptResultSchema } from "../shared/recruitment-schema-v2.mjs";
import { matchProjects, contactFunctions } from "../domain/discovery-match.mjs";
import { canReadProjection } from "../domain/consent-policy.mjs";
import { digest } from "../shared/digest.mjs";
import { ServiceError } from "../shared/service-error.mjs";
import { recordObjectAudit } from "../infrastructure/object-audit.mjs";

const day=86400,stamp=n=>new Date(n*1000).toISOString(),publishing=['create','revise','renew'];
const fail=(code,status=409)=>{throw new ServiceError(code,status);};
const parse=(schema,value)=>{const result=schema.safeParse(value);if(!result.success)fail('invalid_recruitment_request',400);return result.data;};
const unavailable=e=>e instanceof ServiceError&&[403,404].includes(e.status);

export class RecruitmentV2Service {
 constructor(access,{projects,consents,discovery,assistance,inbox,publicWrites}={}) {Object.assign(this,{access,projects,consents,discovery,assistance,inbox,publicWrites});}
 async rowWithin(db,id,{write=false}={}){
  const row=(await db.query(`SELECT * FROM recruitment_opportunities WHERE id=$1 ${write?'FOR UPDATE':'FOR SHARE'}`,[id])).rows[0];
  if(!row)fail('recruitment_not_found',404);return row;
 }
 state(row){return row.state==='active'&&Date.parse(row.expires_at)<=this.access.now()*1000?'expired':row.state;}
 receipt(row){return{schemaVersion:2,recruitmentId:row.id,projectId:row.project_id,publisherId:row.publisher_id,contactSubjectId:row.contact_subject_id,
  revision:row.revision,state:this.state(row),sourceEventId:row.current_event_id,expiresAt:new Date(row.expires_at).toISOString(),
  objectKind:'long-term-role-opportunity',taskAutomaticallyCreated:false};}
 async grantWithin(db,row){if(!row?.payload_text)fail('recruitment_source_unavailable',404);
  return this.consents.require(db,{id:row.consent_id,subjectId:row.subject_id,action:'recruitment.write',objectId:row.operation_id,recipient:this.access.endpoint,payloadJson:row.payload_text});}
 async readWithin(db,actor,id,{requireOpen=false}={}) {
  const row=await this.rowWithin(db,id),project=await this.projects.readWithin(db,actor,row.project_id);
  const source=(await db.query('SELECT * FROM recruitment_events WHERE operation_id=$1',[row.current_event_id])).rows[0],grant=await this.grantWithin(db,source);
  if(!canReadProjection(grant,{viewerId:actor?.subjectId??null,projection:'history',now:this.access.now()}))fail('recruitment_not_found',404);
  const event=parse(recruitmentEventV2Schema,JSON.parse(source.payload_text));
  if(!publishing.includes(event.kind)||event.recruitmentId!==row.id||event.projectId!==row.project_id)fail('recruitment_source_unavailable',404);
  const p=await this.projects.rowWithin(db,row.project_id);
  const publisherRoles=await this.projects.rolesWithin(db,p,row.publisher_id),contactRoles=await this.projects.rolesWithin(db,p,row.contact_subject_id);
  const authority=publisherRoles.some(r=>['owner','representative'].includes(r))&&contactRoles.some(r=>['owner','representative'].includes(r));
  const wish=await this.projects.effectiveWishWithin(db,row.contact_subject_id,row.project_id,{active:true,purposes:['recruitment']});
  const blocked=this.inbox?await this.inbox.isBlockedWithin(db,actor?.subjectId,row.contact_subject_id):false;
  const acceptingContacts=this.state(row)==='active'&&authority&&wish.enabled&&!blocked;
  if(requireOpen&&!acceptingContacts)fail('recruitment_unavailable_for_contact',404);
  const taskLinks=[];
  for(const link of (await db.query('SELECT task_id,subject_id,operation_id,created_at FROM recruitment_task_links WHERE recruitment_id=$1 ORDER BY task_id',[id])).rows){
   if(!actor?.scopes?.includes('assistance'))continue;
   try {const event=(await db.query('SELECT * FROM recruitment_events WHERE operation_id=$1',[link.operation_id])).rows[0],linkGrant=await this.grantWithin(db,event);
    if(!canReadProjection(linkGrant,{viewerId:actor.subjectId,projection:'history',now:this.access.now()}))continue;
    await this.assistance.requireTaskWithin(db,actor,link.task_id);taskLinks.push({taskId:link.task_id,linkedBy:link.subject_id,operationId:link.operation_id,linkedAt:new Date(link.created_at).toISOString()});}
   catch(error){if(!unavailable(error))throw error;}
  }
  return{...this.receipt(row),document:event.document,project:{projectId:project.projectId,title:project.document.title,classification:project.classification},
   acceptingContacts,representativeCurrentlyAuthorized:authority,contactPreferenceEnabled:wish.enabled,
   classification:'declared-role-requirement',capabilityVerified:false,taskLinks,taskLinkScope:'currently-readable-tasks-only',
   originalSource:{operationId:source.operation_id,subjectId:source.subject_id,consentId:source.consent_id,payloadHash:source.payload_hash,recordedAt:new Date(source.created_at).toISOString()},
   interpretation:'user-side-model-or-user',activeEntries:['discover','publish-task','participate-task','ordinary-chat']};
 }
 get(actor,id){return this.discovery.run(actor,db=>this.readWithin(db,actor,id));}
 operationReceipt(actor,input){
  const parsed=recruitmentOperationReceiptQuerySchema.safeParse(input);if(!parsed.success)fail('invalid_recruitment_receipt_query',400);
  const query=parsed.data;
  return this.access.runAuthorized(actor,'history',async db=>{
   // The original author and exact intent are independent of a later owner's
   // current statement or representative permission. Never load either body.
   const row=(await db.query(`SELECT operation_id,recruitment_id,payload_hash,revision,created_at
    FROM recruitment_events WHERE operation_id=$1 AND subject_id=$2`,[query.operationId,actor.subjectId])).rows[0];
   const common={schemaVersion:2,query,authority:'accepted-operation-only',audience:'owner-only',
    currentAccessGranted:false,contentReturned:false,sourceAccessChecked:false};
   if(!row)return recruitmentOperationReceiptResultSchema.parse({...common,state:'absent',absenceMeaning:'no-retained-owner-operation'});
   if(row.recruitment_id!==query.recruitmentId||row.payload_hash!==query.payloadHash)
    return recruitmentOperationReceiptResultSchema.parse({...common,state:'conflict',reason:'original-operation-mismatch'});
   return recruitmentOperationReceiptResultSchema.parse({...common,state:'acknowledged',receipt:{
    ...query,revision:row.revision,acceptedAt:new Date(row.created_at).toISOString()}});
  });
 }
 async opportunityWithin(db,actor,row,context){
  if(row.contact_subject_id===actor?.subjectId||!context.wish.purposes.includes('recruitment'))return null;
  let view;try{view=await this.readWithin(db,actor,row.id,{requireOpen:true});}catch(error){if(unavailable(error))return null;throw error;}
  const wish=await this.projects.effectiveWishWithin(db,row.contact_subject_id,row.project_id,{active:true,purposes:['recruitment']});
  const match=matchProjects(context.source,view.document,context.wish,wish);if(!match)return null;
  const ref={sourceKind:'recruitment',subjectId:row.contact_subject_id,projectId:row.project_id,recruitmentId:row.id,eventId:row.current_event_id};
  return{id:digest(JSON.stringify(ref)),opportunityRef:ref,subjectId:row.contact_subject_id,projectId:row.project_id,
   recruitmentId:row.id,project:{...view.document,id:row.project_id,kind:'role-requirement'},recruitment:view,
   participant:{subjectId:row.contact_subject_id,kind:'unknown',kindSource:'project-representative; human-or-agent-not-inferred'},classification:'declared-role-requirement',capabilityVerified:false,match,
   help:{statement:view.document.summary,functions:contactFunctions(match.sharedFunctions,context.wish,wish),purposes:['recruitment'],basis:'explicit-current-role-requirement-and-representative-authority',commitment:'not-contacted'},
   contactState:'welcome',willingness:{classification:'explicit-recruitment-publication',purposes:['recruitment'],temporaryUntil:wish.temporaryUntil,requiresRecipientAcceptance:true},
   sources:[view.originalSource],experience:{status:'not-loaded',refs:[],lookup:'discovery-detail',absenceMeaning:'no-history-is-not-ineligibility'},
   nextActions:['inspect','consider-contact'],invitationSent:false,roomJoined:false};
 }
 async opportunitiesWithin(db,actor,subjectId,context){
  const rows=(await db.query("SELECT * FROM recruitment_opportunities WHERE contact_subject_id=$1 AND state='active' AND expires_at>$2 ORDER BY id LIMIT 200",[subjectId,stamp(this.access.now())])).rows;
  const items=[];for(const row of rows){const item=await this.opportunityWithin(db,actor,row,context);if(item)items.push(item);}return items;
 }
 query(actor,input){const x=parse(recruitmentQueryV2Schema,input);if(x.view==='managed'&&!actor)fail('access_denied',401);
  return this.discovery.run(actor,async db=>{
   const context=x.view==='discover'?await this.discovery.contextWithin(db,actor,{context:x.context,purposes:['recruitment']}):null;
   const queryHash=digest(JSON.stringify({kind:'recruitment',view:x.view,context:x.context,limit:x.limit})),viewerId=actor?.subjectId??null;
   const cursor=x.after?this.discovery.openCursor(x.after,queryHash,viewerId):{startAfter:null};
   const rows=(await db.query(`SELECT o.* FROM recruitment_opportunities o WHERE ($1::uuid IS NULL OR o.id>$1)
    AND ($2='discover' AND o.state='active' AND o.expires_at>$3 OR $2='managed' AND EXISTS(SELECT 1 FROM projects_v2 p WHERE p.id=o.project_id
      AND (p.owner_id=$4 OR EXISTS(SELECT 1 FROM project_roles_v2 r WHERE r.project_id=p.id AND r.subject_id=$4 AND r.role='representative' AND r.state='active'))))
    ORDER BY o.id LIMIT $5`,[cursor.startAfter,x.view,stamp(this.access.now()),actor?.subjectId??null,x.limit+1])).rows;
   const items=[];for(const row of rows.slice(0,x.limit)){
    if(x.view==='discover'){const item=await this.opportunityWithin(db,actor,row,context);if(item)items.push(item);}
    else{try{await this.projects.requireRoleWithin(db,actor,row.project_id,['owner','representative']);let view;
      try{view=await this.readWithin(db,actor,row.id);}catch(error){if(!unavailable(error))throw error;view={...this.receipt(row),contentUnavailable:true};}items.push(view);
     }catch(error){if(!unavailable(error))throw error;}}
   }
   return{items,nextAfter:rows.length>x.limit?this.discovery.sealCursor({v:2,queryHash,viewerId,startAfter:rows[x.limit-1].id}):null,scanned:Math.min(rows.length,x.limit),globalCountProvided:false,
    currentSourceRechecked:true,interpretation:'user-side-model-or-user',taskAutomaticallyCreated:false};
  });
 }
 submit(actor,input){const envelope=parse(recruitmentEnvelopeV2Schema,input);let event;try{event=parse(recruitmentEventV2Schema,JSON.parse(envelope.payloadJson));}catch{fail('invalid_recruitment_request',400);}
  return this.access.runResourceWrite(actor,'history',{},async(db,authorization)=>{
   if(event.kind==='link-task'&&!authorization.credentialScopes.includes('assistance'))fail('recruitment_task_scope_required',403);
   let task;if(event.kind==='link-task')task=await this.assistance.requireTaskWithin(db,actor,event.taskId,{write:true});
   const project=await this.projects.requireRoleWithin(db,actor,event.projectId,['owner','representative'],{write:true});
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912361))',[event.recruitmentId]);
   const prior=(await db.query('SELECT * FROM recruitment_events WHERE operation_id=$1',[event.operationId])).rows[0];
   if(prior){if(prior.subject_id!==actor.subjectId||prior.recruitment_id!==event.recruitmentId||prior.consent_id!==envelope.consentId||prior.payload_hash!==digest(envelope.payloadJson))fail('recruitment_operation_conflict');
    return{...this.receipt(await this.rowWithin(db,event.recruitmentId)),operationId:event.operationId,appliedRevision:prior.revision,replayed:true};}
   const grant=await this.grantWithin(db,{operation_id:event.operationId,subject_id:actor.subjectId,consent_id:envelope.consentId,payload_text:envelope.payloadJson});
   if(grant.currentVisibility?.deletionPending||!['Public','Private'].includes(grant.visibility))fail('recruitment_write_unavailable',403);
   let row;if(event.kind==='create'){
    if(event.expectedRevision!==0||project.state!=='active')fail('recruitment_project_unavailable');
    if((await db.query('SELECT id FROM recruitment_opportunities WHERE id=$1',[event.recruitmentId])).rows.length)fail('recruitment_id_conflict');
   }else{row=await this.rowWithin(db,event.recruitmentId,{write:true});if(row.project_id!==event.projectId||row.revision!==event.expectedRevision)fail('recruitment_revision_conflict');
    if(row.state==='closed'&&event.kind!=='link-task'&&event.kind!=='close')fail('recruitment_closed');}
   if(publishing.includes(event.kind)){
    if(grant.visibility!=='Public'||grant.purpose!=='public-profile')fail('recruitment_public_consent_required',403);
    await this.projects.readWithin(db,null,event.projectId);
    if(row?.state==='closed')fail('recruitment_closed');
    if(event.expiresAt<=this.access.now()||event.expiresAt>this.access.now()+30*day)fail('recruitment_review_window',400);
    const roles=await this.projects.rolesWithin(db,project,event.document.contactSubjectId);
    if(!roles.some(r=>['owner','representative'].includes(r)))fail('recruitment_contact_representative_required',403);
    if(event.document.contactSubjectId!==actor.subjectId)fail('recruitment_contact_self_acceptance_required',403);
    if(!this.publicWrites)fail('recruitment_account_adapter_unavailable',503);
    await this.publicWrites.consumeWithin(db,actor,{kind:'recruitment',operationId:event.operationId,payloadHash:digest(envelope.payloadJson),recruitmentId:event.recruitmentId});
   }else if(event.kind==='link-task'){
    if(task.requesterId!==actor.subjectId||task.row.version!==event.expectedTaskVersion)fail('recruitment_task_owner_or_version_required',403);
    if((await db.query('SELECT task_id FROM recruitment_task_links WHERE recruitment_id=$1 AND task_id=$2',[event.recruitmentId,event.taskId])).rows.length)fail('recruitment_task_already_linked');
   }
   const revision=event.expectedRevision+1,at=stamp(this.access.now());
   if(event.kind==='create')await db.query(`INSERT INTO recruitment_opportunities(id,project_id,creator_id,publisher_id,contact_subject_id,revision,state,current_event_id,expires_at,created_at,updated_at)
    VALUES($1,$2,$3,$3,$4,1,'active',$5,$6,$7,$7)`,[event.recruitmentId,event.projectId,actor.subjectId,event.document.contactSubjectId,event.operationId,stamp(event.expiresAt),at]);
   await db.query(`INSERT INTO recruitment_events(operation_id,recruitment_id,subject_id,revision,kind,consent_id,payload_text,payload_hash,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[event.operationId,event.recruitmentId,actor.subjectId,revision,event.kind,envelope.consentId,envelope.payloadJson,digest(envelope.payloadJson),at]);
   if(row){await db.query('UPDATE recruitment_opportunities SET revision=$2,updated_at=$3 WHERE id=$1',[event.recruitmentId,revision,at]);
    if(publishing.includes(event.kind))await db.query("UPDATE recruitment_opportunities SET publisher_id=$2,contact_subject_id=$3,current_event_id=$4,expires_at=$5,state='active' WHERE id=$1",[row.id,actor.subjectId,event.document.contactSubjectId,event.operationId,stamp(event.expiresAt)]);
    if(['pause','close'].includes(event.kind))await db.query('UPDATE recruitment_opportunities SET state=$2 WHERE id=$1',[row.id,event.kind==='pause'?'paused':'closed']);
   }
   if(event.kind==='link-task')await db.query('INSERT INTO recruitment_task_links(recruitment_id,task_id,subject_id,operation_id,created_at) VALUES($1,$2,$3,$4,$5)',[event.recruitmentId,event.taskId,actor.subjectId,event.operationId,at]);
   await recordObjectAudit(db,{subjectId:actor.subjectId,objectId:event.operationId,action:'recruitment.event',httpRequestId:actor.httpRequestId??null,...authorization});
   return{...this.receipt(await this.rowWithin(db,event.recruitmentId)),operationId:event.operationId,appliedRevision:revision,replayed:false};
  });
 }
}
