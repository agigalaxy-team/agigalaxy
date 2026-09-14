import {qualificationCalculationSchema} from './shared/qualification-calculation-schema.mjs';
import {canReadProjection} from './domain/consent-policy.mjs';
import {digest} from './shared/digest.mjs';
import {ServiceError} from './shared/service-error.mjs';
import canonicalize from 'canonicalize';
import * as z from 'zod/v4';
const rule=(ok,code,status=403)=>{if(!ok)throw new ServiceError(code,status);};
const key=ref=>`${ref.kind}:${ref.id}:${ref.payloadHash}`;
const action=kind=>kind==='compute'?'qualification.compute':'qualification.source-permission';
const omitGrant=e=>{const{calculationGrantId,...rest}=e;return rest;};
export class QualificationCalculationService{
  constructor(access,consents,assistance){Object.assign(this,{access,consents,assistance});}
  receipt(actor,input){const q=z.strictObject({operationId:z.uuid(),payloadHash:z.string().regex(/^[a-f0-9]{64}$/)}).safeParse(input);rule(q.success,'invalid_qualification_receipt',400);
    return this.access.runAuthorized(actor,'assistance',async db=>{const p=q.data,row=(await db.query(`SELECT id,payload_hash,consent_id FROM qualification_calculation_grants WHERE id=$1 AND subject_id=$2
      UNION ALL SELECT id,revoke_payload_hash payload_hash,revoke_consent_id consent_id FROM qualification_calculation_grants WHERE revoke_id=$1 AND subject_id=$2`,[p.operationId,actor.subjectId])).rows[0];
      return{operationId:p.operationId,state:!row?'absent':row.payload_hash===p.payloadHash?'acknowledged':'conflict',...(row?.payload_hash===p.payloadHash?{grantId:row.id,consentId:row.consent_id}:{}),currentReadPermissionConfirmed:false};});}
  owned(actor,input={}){const q=z.strictObject({taskId:z.uuid().optional(),after:z.uuid().optional(),limit:z.number().int().min(1).max(30).default(12)}).safeParse(input);rule(q.success,'invalid_qualification_grant_query',400);
    return this.access.runAuthorized(actor,'assistance',async db=>{const p=q.data,rows=(await db.query('SELECT * FROM qualification_calculation_grants WHERE subject_id=$1 AND ($2::uuid IS NULL OR task_id=$2) AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4',[actor.subjectId,p.taskId??null,p.after??null,p.limit+1])).rows;
      const items=[];for(const r of rows.slice(0,p.limit)){let payload=null,state=r.payload_text?'permission-unavailable':'source-erased';
        try{payload=(await this.readGrantWithin(db,actor,r.id)).payload;state='recorded-current-intent';}catch(e){if(!(e instanceof ServiceError&&[403,404,409,422,503].includes(e.status)))throw e;}
        if(r.revoked_at)state='revoked';items.push({id:r.id,taskId:r.task_id,state,kind:payload?.kind??null,expiresAt:payload?.expiresAt??null,createdAt:new Date(r.created_at).toISOString(),payload,
          sourceReadGranted:false,qualificationGranted:false});}
      return{items,nextAfter:rows.length>p.limit?items.at(-1).id:null};});}
  async sourceWithin(db,ref){
    const table=ref.kind==='case-event'?'case_events':'task_events';
    const row=(await db.query(`SELECT * FROM ${table} WHERE id=$1`,[ref.id])).rows[0];
    rule(row?.payload_text&&row.payload_hash===ref.payloadHash,'qualification_source_unavailable');return row;
  }
  async sourceGrantWithin(db,ref,row){
    const g=await this.consents.require(db,{id:row.consent_id,subjectId:row.subject_id,objectId:row.id,
      action:ref.kind==='case-event'?'case.teaser.publish':'assistance.publish',recipient:this.access.endpoint,payloadJson:row.payload_text});
    rule(!g.currentVisibility?.deletionPending,'qualification_source_unavailable');return g;
  }
  async readGrantWithin(db,actor,id){
    const row=(await db.query('SELECT * FROM qualification_calculation_grants WHERE id=$1 FOR SHARE',[id])).rows[0];rule(row?.payload_text&&!row.revoked_at,'qualification_calculation_unavailable');
    const payload=qualificationCalculationSchema.parse(JSON.parse(row.payload_text));rule(payload.kind!=='revoke','qualification_calculation_unavailable');
    const grant=await this.consents.require(db,{id:row.consent_id,subjectId:row.subject_id,objectId:row.id,action:action(payload.kind),recipient:this.access.endpoint,payloadJson:row.payload_text});
    rule(!grant.currentVisibility?.deletionPending&&canReadProjection(grant,{viewerId:actor.subjectId,now:this.access.now()})&&Date.parse(payload.expiresAt)>this.access.now()*1000,'qualification_calculation_unavailable');
    return{row,payload,grant};
  }
  async permissionsWithin(db,actor,compute){
    const covered=new Map();
    for(const id of compute.permissionIds){const p=await this.readGrantWithin(db,actor,id);rule(p.payload.kind==='source-permission','qualification_source_permission_required');
      for(const field of ['taskId','candidateId','recipientId','purpose','disclosure'])rule(p.payload[field]===compute[field],'qualification_source_permission_scope_mismatch');
      for(const ref of p.payload.sourceRefs){const row=await this.sourceWithin(db,ref);rule(row.subject_id===p.row.subject_id,'qualification_source_permission_author_mismatch');
        await this.sourceGrantWithin(db,ref,row);covered.set(key(ref),row.subject_id);}
    }return covered;
  }
  async authorizeReadWithin(db,actor,compute,covered,kind,row){
    rule(row?.id&&row.payload_text,'qualification_source_unavailable');
    const ref=compute.sourceRefs.find(r=>r.kind===kind&&r.id===row.id&&r.payloadHash===row.payload_hash);rule(ref&&row.payload_text,'qualification_source_not_selected');
    const g=await this.sourceGrantWithin(db,ref,row);
    rule(canReadProjection(g,{viewerId:compute.candidateId,now:this.access.now()}),'qualification_candidate_source_unavailable');
    rule(row.subject_id===compute.candidateId||covered.get(key(ref))===row.subject_id,'qualification_source_permission_required');
    return g;
  }
  async contextWithin(db,actor,q){
    rule(q.evidence.calculationGrantId,'qualification_calculation_required');const read=await this.readGrantWithin(db,actor,q.evidence.calculationGrantId),c=read.payload;
    rule(c.kind==='compute'&&read.row.subject_id===q.subjectId&&c.candidateId===q.subjectId&&[c.candidateId,c.recipientId].includes(actor.subjectId)&&c.taskId===q.taskId,'qualification_calculation_scope_mismatch');
    const target=(await db.query('SELECT requester_id FROM task_requests WHERE id=$1',[q.taskId])).rows[0];
    rule(target?.requester_id===c.recipientId,'qualification_calculation_recipient_mismatch');
    rule(canonicalize(omitGrant(c.evidence))===canonicalize(omitGrant(q.evidence)),'qualification_calculation_evidence_mismatch');
    const covered=await this.permissionsWithin(db,actor,c);
    return{payload:c,grantId:read.row.id,readEventWithin:(kind,row)=>this.authorizeReadWithin(db,actor,c,covered,kind,row)};
  }
  async submit(actor,input){let data;try{rule(typeof input.payloadJson==='string'&&Buffer.byteLength(input.payloadJson)<=48000,'invalid_qualification_calculation',400);data=qualificationCalculationSchema.parse(JSON.parse(input.payloadJson));}
    catch{throw new ServiceError('invalid_qualification_calculation',400);}
    return this.access.runResourceWrite(actor,'assistance',{control:data.kind==='revoke'},async(db,authorization)=>{
      let target=null,kind=data.kind;
      if(data.kind==='revoke'){target=(await db.query('SELECT * FROM qualification_calculation_grants WHERE id=$1 AND subject_id=$2 FOR UPDATE',[data.grantId,actor.subjectId])).rows[0];
        rule(target?.payload_text,'qualification_calculation_unavailable');kind=JSON.parse(target.payload_text).kind;}
      const grant=await this.consents.require(db,{id:input.consentId,subjectId:actor.subjectId,objectId:data.id,action:action(kind),recipient:this.access.endpoint,payloadJson:input.payloadJson});
      if(data.kind==='revoke'){
        if(target.revoked_at)rule(target.revoke_id===data.id&&target.revoke_consent_id===input.consentId&&target.revoke_payload_hash===digest(input.payloadJson),'qualification_calculation_conflict',409);
        else await db.query('UPDATE qualification_calculation_grants SET revoked_at=$2,revoke_id=$3,revoke_consent_id=$4,revoke_payload_text=$5,revoke_payload_hash=$6 WHERE id=$1',
          [data.grantId,new Date(this.access.now()*1000).toISOString(),data.id,input.consentId,input.payloadJson,digest(input.payloadJson)]);
      }else{
        rule(Date.parse(data.expiresAt)>this.access.now()*1000,'qualification_calculation_expired');
        const task=(await db.query('SELECT requester_id FROM task_requests WHERE id=$1',[data.taskId])).rows[0];rule(task?.requester_id===data.recipientId,'qualification_calculation_recipient_mismatch');
        rule(grant.visibility==='Private'&&[data.candidateId,data.recipientId].every(id=>canReadProjection(grant,{viewerId:id,now:this.access.now()}))
          &&grant.viewers.every(id=>[data.candidateId,data.recipientId].includes(id)),'qualification_calculation_visibility_required');
        if(data.kind==='compute'){
          rule(data.candidateId===actor.subjectId,'qualification_candidate_required');
          rule(['externalReviewRefs','capsuleUseIds','proofIds','assistanceIds'].every(k=>data.evidence[k].length===0),'qualification_calculation_source_kind_unsupported',422);
          await this.assistance.requireTaskWithin(db,actor,data.taskId);
        }
        const covered=data.kind==='compute'?await this.permissionsWithin(db,actor,data):null;
        for(const ref of data.sourceRefs){const row=await this.sourceWithin(db,ref),g=await this.sourceGrantWithin(db,ref,row);
          if(data.kind==='source-permission')rule(row.subject_id===actor.subjectId,'qualification_source_author_required');
          else{rule(canReadProjection(g,{viewerId:actor.subjectId,now:this.access.now()}),'qualification_candidate_source_unavailable');
            rule(row.subject_id===actor.subjectId||covered.get(key(ref))===row.subject_id,'qualification_source_permission_required');}}
        const prior=(await db.query('SELECT * FROM qualification_calculation_grants WHERE id=$1',[data.id])).rows[0];
        if(prior)rule(prior.subject_id===actor.subjectId&&prior.payload_hash===digest(input.payloadJson)&&prior.consent_id===input.consentId,'qualification_calculation_conflict',409);
        else await db.query('INSERT INTO qualification_calculation_grants(id,subject_id,task_id,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6)',[data.id,actor.subjectId,data.taskId,input.consentId,input.payloadJson,digest(input.payloadJson)]);
      }
      const audit=await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
        SELECT $1,$2,$3,$3,'accepted',1,ch.payload->>'installationId',b.audience,'assistance',c.id,b.id,$4,$3,b.scopes,$5::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
        FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$6::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id
        WHERE c.id=$7 AND c.subject_id=$1 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE actor=$1 AND action=$2 AND request_id=$3) RETURNING sequence`,
        [actor.subjectId,`${action(kind)}.${data.kind==='revoke'?'revoke':'grant'}`,data.id,actor.httpRequestId??null,JSON.stringify(authorization.credentialScopes),authorization.callerBindingId,input.consentId]);
      return{grantId:data.grantId??data.id,state:data.kind==='revoke'?'revoked':'recorded',sourceReadGranted:false,publicHistoryGranted:false};
    });
  }
}
