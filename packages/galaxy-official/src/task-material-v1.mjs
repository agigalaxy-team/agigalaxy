import * as z from 'zod/v4';
import {ServiceError} from './shared/service-error.mjs';
import {digest} from './shared/digest.mjs';
import canonicalize from 'canonicalize';
import {forumStamp,forumSeconds} from './community-forum-permissions-v1.mjs';
import {taskMaterialPrepareSchema,taskMaterialBodyIssue,taskTextFields,taskTextMaterialIds} from './shared/task-material-v1-schema.mjs';

const parse=(schema,value)=>{const p=schema.safeParse(value);if(!p.success)throw new ServiceError('invalid_task_material_request');return p.data;};
const sourceFields=['title','body'];
const fieldLimits={title:120,summary:10000,goal:10000,currentSituation:10000,expectedOutcome:1500};
const permanentlyUnavailableReasons=new Set(['content-erased','content-expired','permission-revoked','consent-revoked',
 'permission-evidence-mismatch','audience-mismatch','binding-explicitly-revoked','source-device-revoked']);
export class TaskMaterialServiceV1 {
 constructor(access,consents,{forum}){Object.assign(this,{access,consents,forum});}
 async sourceWithin(db,source,{ownerId=null,lock=true}={}){
  if(source.endpoint&&source.endpoint!==this.access.endpoint)return {available:false,permanent:true,reasons:['source-endpoint-mismatch']};
  const row=await this.forum.version(db,source.postId,source.versionId);
  if(!row)return {available:false,permanent:true,reasons:['source-not-found']};
  if(ownerId&&row.subject_id!==ownerId)return {available:false,permanent:true,reasons:['source-owner-mismatch']};
  if(row.state==='withdrawn'||row.post_state==='withdrawn')return {available:false,permanent:true,reasons:['source-withdrawn']};
  if(source.permissionId&&row.permission_id!==source.permissionId||source.payloadHash&&row.payload_hash!==source.payloadHash)
   return {available:false,permanent:true,reasons:['source-commitment-mismatch']};
  const permission=await this.forum.permissions.statusWithin(db,row.permission_id,{visibility:'Public',payloadHash:row.payload_hash,action:'forum.post.publish',objectId:source.versionId,lock});
  if(!permission.allowed){
   const pending=permission.reasons.includes('deletion-pending');
   const approved=pending&&(await db.query("SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('approved','partial','primary-erased') LIMIT 1",[row.subject_id])).rows.length>0;
   // A pending review or unprovable historical revocation hides the copy. A
   // separately established revoke/expiry still erases it, even while pending.
   const permanent=approved||permission.reasons.some(reason=>permanentlyUnavailableReasons.has(reason));
   return {available:false,permanent,reasons:permission.reasons,row};
  }
  if(!row.payload_text||row.erased_at||row.event_erased||digest(row.payload_text)!==row.payload_hash)
   return {available:false,permanent:true,reasons:['source-content-erased-or-invalid'],row};
  if(await this.forum.hiddenWithin(db,{kind:'post-version',postId:source.postId,versionId:source.versionId}))
   return {available:false,permanent:false,reasons:['source-governance-hidden'],row};
  const payload=JSON.parse(row.payload_text);
  return {available:true,permanent:false,row,payload,availableUntil:Math.min(forumSeconds(row.published_until),permission.row.intent?.expiresAt??forumSeconds(permission.row.published_until))};
 }
 selection(state,selection){
  if(!sourceFields.includes(selection.field)||typeof state.payload[selection.field]!=='string')throw new ServiceError('task_material_source_mismatch',409);
  const points=[...state.payload[selection.field]];
  if(selection.end>points.length||selection.start>=selection.end)throw new ServiceError('task_material_selection_mismatch',409);
  return points.slice(selection.start,selection.end).join('');
 }
 prepare(actor,input){
  const p=parse(taskMaterialPrepareSchema,input);
  return this.access.runAuthorized(actor,'assistance',async db=>{
   const state=await this.sourceWithin(db,p.source,{ownerId:actor.subjectId});
   if(!state.available)throw new ServiceError('task_material_source_unavailable',403);
   if(p.expiresAt<=this.access.now()||p.expiresAt>state.availableUntil)throw new ServiceError('task_material_expiry_invalid',403);
   const source={kind:'forum-post-version',endpoint:this.access.endpoint,postId:p.source.postId,versionId:p.source.versionId,
    permissionId:state.row.permission_id,payloadHash:state.row.payload_hash};
   const descriptors=[],materialBodies=[];
   for(const selection of p.selections){const selected=this.selection(state,selection),text=selection.text??selected;
    descriptors.push({materialId:selection.materialId,source:{...source,field:selection.field,start:selection.start,end:selection.end,selectionHash:digest(selected)},
     textHash:digest(text),purpose:'task-context',expiresAt:p.expiresAt});materialBodies.push({materialId:selection.materialId,text});}
   if(materialBodies.reduce((sum,b)=>sum+Buffer.byteLength(b.text),0)>49152)throw new ServiceError('task_material_body_too_large',413);
   return {descriptors,materialBodies,checkedAt:this.access.now(),source,sourceAvailableUntil:state.availableUntil};
  });
 }
 async validateWithin(db,actor,request,bodies,grant){
  const issue=taskMaterialBodyIssue(request,bodies);if(issue)throw new ServiceError('task_material_body_mismatch',409);
  if(grant.purpose!==(request.visibility==='Public'?'public-profile':'operational')||!grant.fields.includes('materials')||grant.currentVisibility?.deletionPending)
   throw new ServiceError('task_material_reuse_consent_required',403);
  const resolved=new Map(),rows=[];
  for(const descriptor of request.materials){
   if((await db.query('SELECT 1 FROM task_materials_v1 WHERE material_id=$1',[descriptor.materialId])).rows.length)throw new ServiceError('task_material_id_conflict',409);
   const state=await this.sourceWithin(db,descriptor.source,{ownerId:actor.subjectId});
   if(!state.available)throw new ServiceError('task_material_source_unavailable',403);
   if(descriptor.expiresAt<=this.access.now()||descriptor.expiresAt>state.availableUntil)throw new ServiceError('task_material_expiry_invalid',403);
   if(digest(this.selection(state,descriptor.source))!==descriptor.source.selectionHash)throw new ServiceError('task_material_selection_mismatch',409);
   const text=bodies.find(b=>b.materialId===descriptor.materialId).text;
   if(digest(text)!==descriptor.textHash)throw new ServiceError('task_material_body_mismatch',409);
   const expiresAt=Math.min(descriptor.expiresAt,grant.expiresAt,state.availableUntil);
   rows.push({descriptor,text,expiresAt});resolved.set(descriptor.materialId,{available:true,text,availableUntil:expiresAt});
  }
  const {fields}=this.projectText(request,resolved);
  for(const [field,maximum]of Object.entries(fieldLimits)){const value=fields[field]?.text;
   if(value!==undefined&&(!value.trim()||value.length>maximum))throw new ServiceError('task_material_field_invalid',400);}
  return rows;
 }
 async insertWithin(db,actor,request,consentId,rows){
  for(const row of rows)await db.query(`INSERT INTO task_materials_v1(material_id,task_id,subject_id,root_event_id,consent_id,descriptor,body_text,text_hash,created_at,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[row.descriptor.materialId,request.taskId,actor.subjectId,request.operationId,consentId,
   JSON.stringify(row.descriptor),row.text,row.descriptor.textHash,forumStamp(this.access.now()),forumStamp(row.expiresAt)]);
 }
 projectText(request,resolved){
  const fields={};
  for(const [key,value]of Object.entries(taskTextFields(request))){
   const input=typeof value==='string'?[{kind:'literal',text:value}]:value.segments,segments=[],parts=[],until=[];let missing=0;
   for(const segment of input){
    if(segment.kind==='literal'){segments.push({...segment});parts.push(segment.text);continue;}
    const current=resolved.get(segment.materialId);
    if(current?.available){segments.push({kind:'material',materialId:segment.materialId,status:'available',text:current.text});parts.push(current.text);until.push(current.availableUntil);}
    else{segments.push({kind:'material',materialId:segment.materialId,status:'unavailable'});missing++;}
   }
   fields[key]={state:missing?(parts.length?'partial':'unavailable'):'available',text:parts.join(''),segments,checkedAt:this.access.now(),...(until.length?{availableUntil:Math.min(...until)}:{})};
  }
  return {fields};
 }
 async statusWithin(db,row,{lock=true}={}){
  if(row.erased_at||!row.body_text)return {available:false,permanent:true,reasons:['material-erased']};
  if(forumSeconds(row.expires_at)<=this.access.now())return {available:false,permanent:true,reasons:['material-expired']};
  if(digest(row.body_text)!==row.text_hash||row.descriptor.textHash!==row.text_hash)return {available:false,permanent:true,reasons:['material-integrity-invalid']};
  const target=(await db.query(`SELECT c.intent,c.revoked_at,b.revoked_at binding_revoked,b.expires_at binding_expires,
    e.payload_hash,e.payload_text,t.snapshot,t.case_id FROM consents c JOIN bindings b ON b.id=c.binding_id
    JOIN task_events e ON e.id=$2 JOIN task_requests t ON t.id=e.task_id WHERE c.id=$1`,[row.consent_id,row.root_event_id])).rows[0];
  if(!target||target.revoked_at||target.binding_revoked||forumSeconds(target.binding_expires)<=this.access.now()||target.intent.expiresAt<=this.access.now()
   ||target.snapshot.contentDeleted||!target.payload_text||target.intent.payloadHash!==target.payload_hash)
   return {available:false,permanent:true,reasons:['target-permission-unavailable']};
  if(target.case_id){const parent=(await db.query('SELECT state FROM cases WHERE id=$1',[target.case_id])).rows[0];
   if(!parent||parent.state==='withdrawn')return {available:false,permanent:true,reasons:['target-case-unavailable']};}
  const source=await this.sourceWithin(db,row.descriptor.source,{ownerId:row.subject_id,lock});
  if(!source.available)return source;
  if(digest(this.selection(source,row.descriptor.source))!==row.descriptor.source.selectionHash)return {available:false,permanent:true,reasons:['source-selection-changed']};
  return {available:true,permanent:false,text:row.body_text,availableUntil:Math.min(forumSeconds(row.expires_at),source.availableUntil,target.intent.expiresAt,forumSeconds(target.binding_expires)),reasons:[]};
 }
 async projectWithin(db,actor,taskRow,{selectedFields=null}={}){
  const request=taskRow.snapshot.request,resolved=new Map(),materials=[];
  const selectedIds=selectedFields?new Set(selectedFields.flatMap(field=>taskTextMaterialIds(taskTextFields(request)[field]))):null;
  const descriptors=(request.materials??[]).filter(descriptor=>!selectedIds||selectedIds.has(descriptor.materialId));
  const rows=selectedIds?(descriptors.length?(await db.query('SELECT * FROM task_materials_v1 WHERE task_id=$1 AND material_id=ANY($2::uuid[]) ORDER BY material_id',
   [taskRow.id,descriptors.map(descriptor=>descriptor.materialId)])).rows:[]):(await db.query('SELECT * FROM task_materials_v1 WHERE task_id=$1 ORDER BY material_id',[taskRow.id])).rows;
  for(const descriptor of descriptors){
   const row=rows.find(r=>r.material_id===descriptor.materialId);
   const state=row&&canonicalize(row.descriptor)===canonicalize(descriptor)?await this.statusWithin(db,row):{available:false};
   const locator={taskId:taskRow.id,materialId:descriptor.materialId};resolved.set(descriptor.materialId,state);
   materials.push(state.available?{locator,status:'available',text:state.text,availableUntil:state.availableUntil,checkedAt:this.access.now()}:{locator,status:'unavailable',checkedAt:this.access.now()});
  }
  const {fields}=this.projectText(request,resolved);
  if(selectedFields)return {textView:{format:'task-text-view-v1',checkedAt:this.access.now(),
   fields:Object.fromEntries(selectedFields.map(field=>[field,fields[field]]))}};
  const projection={...request,title:fields.title.text,summary:fields.summary.text,
   workContext:{...request.workContext,goal:fields.goal.text,currentSituation:fields.currentSituation.text},...(fields.expectedOutcome?{expectedOutcome:fields.expectedOutcome.text}:{})};
  delete projection.materials;
  const original=(await db.query('SELECT payload_hash,payload_text FROM task_events WHERE id=$1',[taskRow.root_event_id])).rows[0];
  const rootCommitment={eventId:taskRow.root_event_id,payloadHash:original?.payload_hash,
   representation:'task-text-v1'};
  return {request:projection,textView:{format:'task-text-view-v1',checkedAt:this.access.now(),fields,materials},rootCommitment,
   ...(actor?.subjectId===taskRow.requester_id?{rootRequest:JSON.parse(original.payload_text)}:{})};
 }
 status(actor,taskId,tasks){
  if(!z.uuid().safeParse(taskId).success)throw new ServiceError('not_found',404);
  return this.access.runAuthorized(actor,'assistance',async db=>{
   const ctx=await tasks.requireTaskWithin(db,actor,taskId);if(ctx.requesterId!==actor.subjectId)throw new ServiceError('not_found',404);
   const rows=(await db.query('SELECT * FROM task_materials_v1 WHERE task_id=$1 ORDER BY material_id',[taskId])).rows,items=[];
   for(const row of rows){const state=await this.statusWithin(db,row);items.push({materialId:row.material_id,descriptor:row.descriptor,status:state.available?'available':'unavailable',
    reasons:state.reasons,permanent:state.permanent,...(state.available?{availableUntil:state.availableUntil}:{}),checkedAt:this.access.now()});}
   return {taskId,checkedAt:this.access.now(),items};
  });
 }
}
