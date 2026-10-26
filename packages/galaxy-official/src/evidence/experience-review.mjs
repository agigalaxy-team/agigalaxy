import {experienceEventSchema,experienceReadSchema,experienceReviewerSchema} from "../shared/experience-review-schema.mjs";
import {ServiceError} from "../shared/service-error.mjs";
import {digest} from "../shared/digest.mjs";
import {canReadProjection} from "../domain/consent-policy.mjs";
import {transaction} from "../infrastructure/database.mjs";
import {experienceReviewerHash,currentExperienceReviewerRegistry} from "../infrastructure/experience-reviewer-registry.mjs";
const rule=(ok,code,status=409)=>{if(!ok)throw new ServiceError(code,status);};
const absent=e=>e instanceof ServiceError&&[403,404,409,422,503].includes(e.status);
const sourceKey=data=>digest(JSON.stringify([data.source.system.toLowerCase(),data.source.stableRecord]));
export class ExperienceReviewService{
  constructor(access,consents,{reviewers=[],resolveControllerWithin=null}={}){
    Object.assign(this,{access,consents,resolveControllerWithin});
    this.reviewers=reviewers.map(p=>experienceReviewerSchema.parse(p));
    if(new Set(this.reviewers.map(p=>p.subjectId)).size!==this.reviewers.length)throw new Error('Duplicate experience reviewer');
  }
  reviewer(subjectId,capabilityId,kind){const now=this.access.now(),r=this.reviewers.find(r=>r.subjectId===subjectId&&r.capabilityIds.includes(capabilityId)
    &&r.kinds.includes(kind)&&r.notBefore<=now&&r.notAfter>now);rule(r,'experience_reviewer_unavailable',403);return r;}
  async useRegistry(){await transaction(this.access.db,db=>currentExperienceReviewerRegistry(db,this.access.endpoint));this.registryEnabled=true;}
  async reviewerWithin(db,subjectId,capabilityId,kind){const r=this.reviewer(subjectId,capabilityId,kind);
    if(this.registryEnabled){const current=await currentExperienceReviewerRegistry(db,this.access.endpoint);rule(current.reviewers.some(p=>p.subjectId===subjectId&&p.definitionHash===experienceReviewerHash(r)),'experience_reviewer_unavailable',403);}return r;}
  async rowWithin(db,id,write=false){return(await db.query(`SELECT * FROM experience_objects WHERE id=$1 ${write?'FOR UPDATE':'FOR SHARE'}`,[id])).rows[0];}
  async eventWithin(db,id,version){return(await db.query('SELECT * FROM experience_events WHERE object_id=$1 AND version=$2',[id,version])).rows[0];}
  async visibleWithin(db,actor,row,event,readEventWithin=null){rule(event?.payload_text,'experience_unavailable',404);
    // Only the internal task calculation reader can license this exact event.
    // Public read() never supplies it and retains the original source ACL.
    if(readEventWithin)return readEventWithin('experience-event',{...event,id:event.operation_id,subject_id:row.subject_id});
    const grant=await this.consents.require(db,{id:event.consent_id,subjectId:row.subject_id,objectId:event.operation_id,action:'experience.submit',recipient:this.access.endpoint,payloadJson:event.payload_text});
    rule(canReadProjection(grant,{viewerId:actor?.subjectId??null,now:this.access.now()}),'experience_unavailable',404);return grant;}
  async readWithin(db,actor,{id,version},visited=new Set(),readEventWithin=null){
    rule(!visited.has(id),'experience_source_cycle');visited.add(id);
    try{
      const row=await this.rowWithin(db,id);rule(row,'experience_unavailable',404);
      const event=await this.eventWithin(db,id,version??row.version);await this.visibleWithin(db,actor,row,event,readEventWithin);
      const record=JSON.parse(event.payload_text),base={id,type:row.object_type,subjectId:row.subject_id,version:event.version,currentVersion:row.version,
        synthetic:record.synthetic,sourceGroup:row.source_key,capabilityVerified:false,taskOutcomeVerified:false,authority:'signed-author-or-registered-reviewer-report; not-automatic-external-verification'};
      if(row.state==='revoked')return{...base,record:null,referenceStatus:'revoked'};
      let status=event.version===row.version?'current':'superseded';
      if(record.expiresAt&&Date.parse(record.expiresAt)<=this.access.now()*1000)status='expired';
      if(row.object_type==='review'){
        try{
          const source=await this.readWithin(db,actor,record.experienceRef,visited,readEventWithin);
          rule(source.referenceStatus==='current'&&source.record,'experience_source_unavailable');
          const reviewer=await this.reviewerWithin(db,row.subject_id,record.capabilityId,source.record.kind);
          rule(source.record.subjectId!==row.subject_id,'experience_nonparty_reviewer_required',403);
          if(this.resolveControllerWithin){const [a,b]=await Promise.all([this.resolveControllerWithin(db,row.subject_id),this.resolveControllerWithin(db,source.record.subjectId)]);
            rule(!a||!b||a!==b,'experience_nonparty_reviewer_required',403);}
          return{...base,sourceGroup:source.sourceGroup,experienceSubjectId:source.record.subjectId,experienceKind:source.record.kind,
            record,referenceStatus:status,source,reviewer:{subjectId:reviewer.subjectId,scope:reviewer.scope,authorityReference:reviewer.authorityReference},
            synthetic:record.synthetic||source.synthetic||reviewer.synthetic,registeredRuntimeReviewer:!!this.registryEnabled,independence:'registered-nonparty-claim; undisclosed-control-relationships-not-inferred'};
        }catch(error){if(!absent(error))throw error;return{...base,record:null,referenceStatus:'dependency-unavailable',reason:error.code};}
      }
      return{...base,record,referenceStatus:status,verification:'not-reviewed-by-this-statement'};
    }finally{visited.delete(id);}
  }
  read(actor,input){rule(experienceReadSchema.safeParse(input).success,'invalid_experience_reference',400);
    return this.access.runAuthorized(actor,'assistance',db=>this.readWithin(db,actor,input));}
  async submit(actor,input){let data;try{rule(typeof input?.payloadJson==='string'&&Buffer.byteLength(input.payloadJson)<=24000,'invalid_experience_payload',400);data=experienceEventSchema.parse(JSON.parse(input.payloadJson));}
    catch{throw new ServiceError('invalid_experience_payload',400);}
    return this.access.runResourceWrite(actor,'assistance',{control:data.kind==='revoke'},async(db,authorization)=>{
      rule(data.reportedBy===actor.subjectId,'experience_reporter_mismatch',403);
      const grant=await this.consents.require(db,{id:input.consentId,subjectId:actor.subjectId,objectId:data.operationId,action:'experience.submit',recipient:this.access.endpoint,payloadJson:input.payloadJson});
      rule(['Private','Public'].includes(grant.visibility),'experience_visibility_required',403);
      const previous=(await db.query('SELECT e.*,o.subject_id FROM experience_events e JOIN experience_objects o ON o.id=e.object_id WHERE operation_id=$1',[data.operationId])).rows[0];
      if(previous){rule(previous.subject_id===actor.subjectId&&previous.object_id===data.id&&previous.payload_hash===digest(input.payloadJson)&&previous.consent_id===input.consentId,'experience_operation_conflict');
        return{id:data.id,version:previous.version,operationId:data.operationId,acknowledged:true};}
      let type=data.kind==='review'?'review':'experience',source=null,reviewer=null;
      if(data.kind==='review'){
        source=await this.readWithin(db,actor,data.experienceRef);rule(source.type==='experience'&&source.referenceStatus==='current'&&source.record,'experience_source_unavailable');
        reviewer=await this.reviewerWithin(db,actor.subjectId,data.capabilityId,source.record.kind);
        rule(data.capabilityId===source.record.capabilityId,'experience_capability_mismatch');
        rule(source.record.subjectId!==actor.subjectId,'experience_nonparty_reviewer_required',403);
        if(this.resolveControllerWithin){const [a,b]=await Promise.all([this.resolveControllerWithin(db,actor.subjectId),this.resolveControllerWithin(db,source.record.subjectId)]);rule(!a||!b||a!==b,'experience_nonparty_reviewer_required',403);}
        rule(data.synthetic||!source.synthetic&&!reviewer.synthetic,'synthetic_mismatch',422);
        rule(data.state!=='verified-in-scope'||Object.values(data.checked).every(Boolean),'experience_review_checks_incomplete');
        rule(Date.parse(data.observedAt)<=this.access.now()*1000+300000,'experience_observation_in_future');
      }else if(data.kind!=='revoke'){
        rule(data.subjectId===actor.subjectId,'experience_owner_required',403);
        rule(Date.parse(data.source.originalAt)<=this.access.now()*1000+300000,'experience_source_in_future');
      }
      if(data.expectedVersion===0&&data.kind!=='revoke')try{
        await db.query('INSERT INTO experience_objects(id,object_type,subject_id,source_key,experience_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',
          [data.id,type,actor.subjectId,type==='experience'?sourceKey(data):null,type==='review'?data.experienceRef.id:null]);
      }catch(error){if(error.code==='23505')throw new ServiceError('experience_stable_source_already_registered',409);throw error;}
      const row=await this.rowWithin(db,data.id,true);rule(row&&row.subject_id===actor.subjectId,'experience_owner_required',403);
      type=data.kind==='revoke'?data.objectType:type;rule(row.object_type===type,'experience_type_mismatch');
      rule(row.state==='active','experience_revoked');rule(row.version===data.expectedVersion&&row.version<100,'experience_version_conflict');
      if(data.kind!=='revoke'&&data.expectedVersion>0){rule(data.reason,'experience_correction_reason_required');
        if(type==='experience')rule(row.source_key===sourceKey(data),'experience_stable_source_mismatch');
        else rule(row.experience_id===data.experienceRef.id,'experience_source_mismatch');
        const old=await this.eventWithin(db,data.id,row.version);rule(old?.payload_text,'experience_unavailable',404);rule(data.synthetic||!JSON.parse(old.payload_text).synthetic,'synthetic_mismatch');}
      const context={recordedAt:new Date(this.access.now()*1000).toISOString(),reviewerAuthority:reviewer?.authorityReference??null,
        reviewerScope:reviewer?.scope??null,externalExecutionIndependentlyVerified:false};
      await db.query('INSERT INTO experience_events(operation_id,object_id,version,consent_id,payload_text,payload_hash,context) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
        [data.operationId,data.id,row.version+1,input.consentId,input.payloadJson,digest(input.payloadJson),JSON.stringify(context)]);
      await db.query('UPDATE experience_objects SET version=$2,state=$3 WHERE id=$1',[data.id,row.version+1,data.kind==='revoke'?'revoked':'active']);
      await this.auditWithin(db,actor,data,input.consentId,authorization);
      return{id:data.id,operationId:data.operationId,version:row.version+1,state:data.kind==='revoke'?'revoked':data.kind==='review'?data.state:'declared',capabilityVerified:false};
    });
  }
  async auditWithin(db,actor,data,consentId,authorization){
    const result=await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,
      consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
      SELECT $1,$2,$3,$4,'accepted',1,ch.payload->>'installationId',b.audience,'assistance',c.id,b.id,$5,$4,b.scopes,$6::jsonb,
        cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id
        JOIN bindings cb ON cb.id=$7::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=$8 AND c.subject_id=$1 RETURNING sequence`,
      [actor.subjectId,`experience.${data.kind}`,data.id,data.operationId,actor.httpRequestId??null,JSON.stringify(authorization.credentialScopes),authorization.callerBindingId,consentId]);
    rule(result.rows.length===1,'experience_audit_unavailable',503);
  }
}
