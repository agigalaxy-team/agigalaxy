import * as z from 'zod/v4';
import {digest} from './shared/digest.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {currentControlKey} from './infrastructure/identity-control-repository.mjs';
import {transaction} from './database.mjs';
import {verifyControlSignature} from './domain/identity-control.mjs';
import {identityGroupIntentSchema,identityGroupProofSchema,identityGroupSubmitSchema,identityGroupQuerySchema,identityGroupReceiptSchema,identityGroupSignatureType,identityGroupSourceSelectionSchema} from './shared/identity-group-v2-schema.mjs';
const rule=(ok,code,status=409)=>{if(!ok)throw new ServiceError(code,status);},iso=n=>new Date(n*1000).toISOString();
const parse=(schema,x)=>{const p=schema.safeParse(x);rule(p.success,'invalid_identity_group',400);return p.data;};
const one=async(db,sql,args)=>(await db.query(sql,args)).rows[0];
const unavailable=e=>e instanceof ServiceError&&[401,403,404,409,422].includes(e.status);
const factsKey=r=>r.kind+':'+r.id+':'+r.version;
export class IdentityGroupServiceV2{
 constructor(access,{readSourceWithin}){Object.assign(this,{access,readSourceWithin});}
 now(){return this.access.now();}
 run(actor,write,control,fn){return write?this.access.runResourceWrite(actor,'binding',{control},fn):actor?this.access.runAuthorized(actor,'binding',fn):transaction(this.access.db,fn);}
 async control(db,actor){return currentControlKey(db,actor.subjectId,{keyId:actor.keyId??undefined,epoch:actor.controlEpoch??undefined,deviceId:actor.deviceId??undefined,scope:'manage-identity'});}
 current(actor){return this.run(actor,false,false,async db=>{const c=await this.control(db,actor);return{subjectId:actor.subjectId,keyId:c.keyId,epoch:c.epoch,endpoint:this.access.endpoint,checkedAt:this.now(),signingType:identityGroupSignatureType};});}
 source(actor,input){const x=parse(identityGroupSourceSelectionSchema,input);return this.run(actor,false,false,async db=>{
  const row=x.kind==='configuration'?await one(db,'SELECT subject_id,payload_hash FROM configuration_events WHERE configuration_id=$1 AND version=$2',[x.id,x.version]):await one(db,'SELECT subject_id,payload_hash FROM case_events WHERE id=$1 AND version=$2 AND case_id=$3',[x.id,x.version,x.caseId??null]);
  rule(row&&row.subject_id===actor.subjectId,'identity_group_source_unavailable',404);
  const ref={...x,sourceHash:row.payload_hash,originalSubjectId:row.subject_id},value=await this.readSourceWithin(db,actor,ref);
  return{...value,selectedOnly:true,groupHasNotBeenPublished:true};
 });}
 async deletionPending(db,ids){return!!(await one(db,"SELECT 1 FROM deletion_requests WHERE subject_id=ANY($1::text[]) AND state IN ('requested','review-needed','approved','partial','primary-erased') LIMIT 1",[ids]));}
 async approvedSources(db,p){if(p.kind==='revoke')return;
  for(const ref of p.sourceRefs){const source=await this.readSourceWithin(db,{subjectId:ref.originalSubjectId},ref,{authorApproval:true});rule(source.originalSubjectId===ref.originalSubjectId,'identity_group_source_author_changed');}
 }
 async required(db,g,p){
  if(p.kind==='create'){rule(g.version===0&&g.state==='proposed','identity_group_version_changed');return p.memberIds;}
  rule(g.version===p.expectedVersion&&g.current_operation_id===p.previousOperationId,'identity_group_version_changed');
  rule(g.state==='active'&&(p.kind==='revoke'||!g.source_erased_at),'identity_group_inactive');
  return p.kind==='revoke'?g.member_ids:[...new Set([...g.member_ids,...p.memberIds])];
 }
 async state(db,op){
  const approvals=(await db.query('SELECT * FROM identity_group_approvals_v2 WHERE operation_id=$1 ORDER BY sequence',[op.id])).rows;
  const latest=new Map();for(const a of approvals)latest.set(a.subject_id,a);
  const current=op.state==='pending'&&Date.parse(op.expires_at)<=this.now()*1000?'expired':op.state;
  return{operationId:op.id,groupId:op.group_id,payloadHash:op.payload_hash,state:current,resultVersion:op.result_version,
   requiredSubjectIds:op.required_ids,approvals:[...latest.values()].map(a=>({id:a.id,subjectId:a.subject_id,decision:a.decision,keyId:a.key_id,epoch:a.epoch,at:a.created_at,expiresAt:JSON.parse(a.proof_text).expiresAt})),
   expiresAt:op.expires_at,acceptedOperationOnly:true,currentAccessGranted:false};
 }
 async receiptWithin(db,actor,input){const x=parse(identityGroupReceiptSchema,input),op=await one(db,'SELECT * FROM identity_group_operations_v2 WHERE id=$1',[x.operationId]);
  if(!op)return{operationId:x.operationId,state:'absent'};
  rule(op.subject_id===actor.subjectId||op.required_ids.includes(actor.subjectId),'identity_group_unavailable',404);
  if(op.payload_hash!==x.payloadHash)return{operationId:x.operationId,state:'conflict'};return this.state(db,op);
 }
 receipt(actor,input){return this.run(actor,false,false,db=>this.receiptWithin(db,actor,input));}
 async submit(actor,input){const x=parse(identityGroupSubmitSchema,input);let p,proof;
  try{p=parse(identityGroupIntentSchema,JSON.parse(x.payloadJson));proof=parse(identityGroupProofSchema,JSON.parse(x.proofJson));}catch(e){throw new ServiceError('invalid_identity_group',400);}
  rule(p.endpoint===this.access.endpoint&&proof.endpoint===p.endpoint&&proof.operationId===p.operationId&&proof.groupId===p.groupId&&proof.payloadHash===digest(x.payloadJson)&&proof.subjectId===actor.subjectId,'identity_group_signature_scope',403);
  rule(p.kind==='create'?p.expectedVersion===0&&p.previousOperationId===null:p.expectedVersion>0&&p.previousOperationId!==null,'invalid_identity_group',400);
  return this.run(actor,true,p.kind==='revoke'||proof.decision!=='approve',async(db,auth)=>{
   const c=await this.control(db,actor);rule(c.keyId===proof.keyId&&c.epoch===proof.epoch,'identity_group_control_changed',401);
   await verifyControlSignature(x.signature,c.publicKey,x.proofJson,{type:identityGroupSignatureType});
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['identity-group:'+p.groupId]);
   let op=await one(db,'SELECT * FROM identity_group_operations_v2 WHERE id=$1 FOR UPDATE',[p.operationId]);
   const prior=await one(db,'SELECT * FROM identity_group_approvals_v2 WHERE id=$1',[proof.id]);
   if(prior){rule(prior.operation_id===p.operationId&&prior.subject_id===actor.subjectId&&prior.proof_text===x.proofJson&&prior.signature===x.signature&&op?.payload_text===x.payloadJson,'identity_group_operation_conflict');return this.state(db,op);}
   rule(p.issuedAt<=this.now()+2&&p.expiresAt>this.now()&&proof.issuedAt<=this.now()+2&&proof.expiresAt>this.now()&&proof.expiresAt<=p.expiresAt&&proof.expiresAt>proof.issuedAt,'identity_group_proposal_expired');
   let g=await one(db,'SELECT * FROM identity_groups_v2 WHERE id=$1 FOR UPDATE',[p.groupId]);
   if(!g){rule(p.kind==='create'&&p.memberIds.includes(actor.subjectId)&&proof.decision==='approve','identity_group_unavailable',404);
    await db.query('INSERT INTO identity_groups_v2(id,subject_id,member_ids,created_at,updated_at) VALUES($1,$2,$3,$4,$4)',[p.groupId,actor.subjectId,JSON.stringify([actor.subjectId]),iso(this.now())]);
    g=await one(db,'SELECT * FROM identity_groups_v2 WHERE id=$1',[p.groupId]);}
   if(!op){if(p.kind==='create')rule(g.subject_id===actor.subjectId,'identity_group_not_proposer',403);
    const required=await this.required(db,g,p);rule(required.includes(actor.subjectId),'identity_group_not_member',403);
    rule(proof.decision==='approve','identity_group_proposal_required');
    if(p.kind==='revoke')rule(g.member_ids.includes(actor.subjectId),'identity_group_not_member',403);
    const count=await one(db,"SELECT count(*)::int n FROM identity_group_operations_v2 WHERE subject_id=$1 AND state='pending' AND expires_at>$2",[actor.subjectId,iso(this.now())]);
    rule(p.kind==='revoke'||count.n<20,'identity_group_pending_limit',429);
    await db.query('INSERT INTO identity_group_operations_v2(id,group_id,subject_id,kind,expected_version,required_ids,payload_text,payload_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
     [p.operationId,p.groupId,actor.subjectId,p.kind,p.expectedVersion,JSON.stringify(required),x.payloadJson,digest(x.payloadJson),iso(this.now()),iso(p.expiresAt)]);
    op=await one(db,'SELECT * FROM identity_group_operations_v2 WHERE id=$1',[p.operationId]);
   }
   rule(op.payload_text===x.payloadJson&&op.group_id===p.groupId,'identity_group_operation_conflict');
   rule(op.required_ids.includes(actor.subjectId),'identity_group_not_member',403);rule(op.state==='pending','identity_group_operation_closed');
   rule(proof.decision!=='cancel'||op.subject_id===actor.subjectId,'identity_group_not_proposer',403);
   rule(p.kind==='revoke'||proof.decision!=='approve'||!await this.deletionPending(db,[actor.subjectId]),'identity_group_deletion_pending');
   // The signer reviews precisely these source references. Another member's
   // source stays private; its owner must independently approve before commit.
   if(proof.decision==='approve'&&p.kind!=='revoke')for(const ref of p.sourceRefs.filter(r=>r.originalSubjectId===actor.subjectId))await this.readSourceWithin(db,actor,ref);
   await db.query('INSERT INTO identity_group_approvals_v2(id,operation_id,subject_id,decision,proof_text,signature,key_id,epoch,public_key,chain_head,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [proof.id,p.operationId,actor.subjectId,proof.decision,x.proofJson,x.signature,c.keyId,c.epoch,c.publicKey,c.chainHead,iso(this.now())]);
   let end=proof.decision==='decline'?'declined':proof.decision==='cancel'?'cancelled':null;
   if(!end){const state=await this.state(db,op),latest=state.approvals;
    if(p.kind==='revoke'||op.required_ids.every(id=>latest.some(a=>a.subjectId===id&&a.decision==='approve'))){
     if(g.version!==p.expectedVersion||g.current_operation_id!==p.previousOperationId)end='conflict';
     else{
      const ids=p.kind==='revoke'?[actor.subjectId]:op.required_ids;
      rule(p.kind==='revoke'||!await this.deletionPending(db,ids),'identity_group_deletion_pending');
      for(const id of [...ids].sort()){const a=latest.find(a=>a.subjectId===id);rule(a.expiresAt>this.now(),'identity_group_approval_expired');await currentControlKey(db,id,{keyId:a.keyId,epoch:a.epoch,scope:'manage-identity'});}
      await this.approvedSources(db,p);
      await db.query('UPDATE identity_groups_v2 SET version=version+1,state=$2,current_operation_id=$3,member_ids=$4,updated_at=$5 WHERE id=$1',
       [p.groupId,p.kind==='revoke'?'revoked':'active',p.operationId,JSON.stringify(p.kind==='revoke'?g.member_ids:p.memberIds),iso(this.now())]);
      end='committed';
     }
    }
   }
   if(end)await db.query('UPDATE identity_group_operations_v2 SET state=$2,closed_at=$3,result_version=$4 WHERE id=$1',[p.operationId,end,iso(this.now()),end==='committed'?g.version+1:null]);
   await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
    SELECT $1,$2,$3,$4,'accepted',1,ch.payload->>'installationId',b.audience,'binding',b.id,$5,$4,b.scopes,$6::jsonb,b.id,ch.payload->>'installationId',b.audience,b.scopes
    FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id WHERE b.id=$7 AND b.subject_id=$1`,
    [actor.subjectId,'identity.group.approval',p.groupId,proof.id,actor.httpRequestId??null,JSON.stringify(auth.credentialScopes),auth.callerBindingId]);
   return this.state(db,await one(db,'SELECT * FROM identity_group_operations_v2 WHERE id=$1',[p.operationId]));
  });
 }
 async proposal(actor,id){parse(z.uuid(),id);return this.run(actor,false,false,async db=>{const op=await one(db,'SELECT * FROM identity_group_operations_v2 WHERE id=$1',[id]);
  rule(op&&(op.subject_id===actor.subjectId||op.required_ids.includes(actor.subjectId)),'identity_group_unavailable',404);
  const status=await this.state(db,op);return{...status,payloadJson:op.payload_text||null,proposerId:op.subject_id,originalIdsPreserved:true,capabilityMerged:false};});}
 async manifest(db,actor,g,{historical=false}={}){
  const op=await one(db,'SELECT * FROM identity_group_operations_v2 WHERE id=$1',[g.current_operation_id]);
  if(!op?.payload_text)return null;
  let p=JSON.parse(op.payload_text);if(p.kind==='revoke'){
   const prev=await one(db,'SELECT * FROM identity_group_operations_v2 WHERE id=$1',[p.previousOperationId]);if(!prev?.payload_text)return null;p=JSON.parse(prev.payload_text);
  }
  const own=p.memberIds.includes(actor?.subjectId),allowed=own||p.visibility==='Public'||p.viewers.includes(actor?.subjectId);
  rule(allowed,'identity_group_unavailable',404);
  const pending=await this.deletionPending(db,p.memberIds),erased=!!g.source_erased_at;
  const approved=(await db.query("SELECT DISTINCT subject_id FROM identity_group_approvals_v2 WHERE operation_id=$1 AND decision='approve'",[op.kind==='revoke'?JSON.parse(op.payload_text).previousOperationId:op.id])).rows.map(x=>x.subject_id);
  const complete=p.memberIds.every(id=>approved.includes(id)),active=g.state==='active'&&!pending&&!erased&&complete;
  return{op,p,active,own,pending,erased,complete};
 }
 async viewWithin(db,actor,g){const m=await this.manifest(db,actor,g);rule(m,'identity_group_unavailable',404);
  const {p,active,own}=m;rule(!(m.pending||m.erased)||own,'identity_group_unavailable',404);
  // Current member selection is explicit, but it never impersonates this
  // member for source reads. A private source needs the viewer's own grant.
  const sources=[];if(active)for(const ref of p.sourceRefs)try{
   const source=await this.readSourceWithin(db,actor,ref),correction=p.attributionCorrections.find(c=>factsKey(c.source)===factsKey(ref));
   sources.push({...source,displaySubjectId:correction?.displaySubjectId??ref.originalSubjectId,attributionCorrection:correction??null,originalActorUnchanged:true});
  }catch(e){if(!unavailable(e))throw e;sources.push({ref,state:'unavailable',record:null});}
  return{groupId:g.id,version:g.version,operationId:g.current_operation_id,state:m.erased?'source-deleted':m.pending?'source-deletion-pending':g.state==='active'&&!m.complete?'control-evidence-unavailable':g.state,
   memberIds:active||own?p.memberIds:[],canonicalDisplayId:active?p.canonicalDisplayId:null,
   visibility:p.visibility,sources,sourceCount:p.sourceRefs.length,originalIdsPreserved:true,capabilityMerged:false,accessGranted:false,
   permissionMeaning:'each-original-source-is-read-as-current-viewer; group-is-display-only',canRevoke:g.state==='active'&&own,
   history:active?[...new Map(sources.filter(s=>s.record).map(s=>[factsKey(s.ref),s])).values()]:[],
   caseGroups:active?[...new Set(sources.filter(s=>s.record&&s.ref.caseId).map(s=>s.ref.caseId))].map(caseId=>({caseId,events:sources.filter(s=>s.record&&s.ref.caseId===caseId),capabilityMerged:false})):[],
   historyDedup:'original-event-or-configuration-id-and-version; no-capability-statistics',checkedAt:this.now()};
 }
 read(actor,id){parse(z.uuid(),id);return this.run(actor,false,false,async db=>{const g=await one(db,'SELECT * FROM identity_groups_v2 WHERE id=$1',[id]);rule(g,'identity_group_unavailable',404);return this.viewWithin(db,actor,g);});}
 query(actor,input={}){const x=parse(identityGroupQuerySchema,input);return this.run(actor,false,false,async db=>{
  const rows=(await db.query(`SELECT * FROM identity_groups_v2 WHERE ($1::text IS NULL OR member_ids ? $1) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 200`,[x.subjectId??actor?.subjectId??null,x.after??null])).rows,items=[];
  let last=null;for(const g of rows){last=g.id;try{items.push(await this.viewWithin(db,actor,g));}catch(e){if(!unavailable(e))throw e;}if(items.length===x.limit)break;}
  return{items,next:rows.length&&last!==rows.at(-1).id||rows.length===200?last:null,coverage:'authorized-canonical-display-groups',capabilityMerged:false};
 });}
 async resolve(actor,input){const x=parse(z.strictObject({subjectId:identityGroupQuerySchema.shape.subjectId.unwrap()}),input),result=await this.query(actor,{subjectId:x.subjectId});
  const ids=[...new Set(result.items.filter(g=>g.state==='active').map(g=>g.canonicalDisplayId))];return{...result,canonicalDisplayIds:ids,ambiguous:ids.length>1,automaticIdentitySelection:false};}
}
