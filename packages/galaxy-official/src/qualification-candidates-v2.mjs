import {qualificationCandidatesV2Schema} from './shared/qualification-v2-schema.mjs';
import {ServiceError} from './shared/service-error.mjs';
const queries={
 participation:'SELECT id FROM task_participations WHERE subject_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 80',
 'external-review':"SELECT r.id,r.version FROM experience_objects r JOIN experience_objects e ON e.id=r.experience_id WHERE e.subject_id=$1 AND r.object_type='review' AND ($2::uuid IS NULL OR r.id>$2) ORDER BY r.id LIMIT 80",
 calculation:'SELECT id FROM qualification_calculation_grants WHERE subject_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 80',
 'capsule-use':'SELECT id FROM capsule_uses_v2 WHERE subject_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 80',
 proof:'SELECT id FROM proofs WHERE subject_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 80',
 'legacy-assistance':"SELECT id FROM assistance_requests WHERE snapshot->'selected'->>'providerId'=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 80",
};
// This is an owner-scoped chooser, never an applicant directory or a new grant.
// A returned cursor is the last currently authorized item, not a hidden review ID.
export function qualificationCandidates(service,actor,input){
 const parsed=qualificationCandidatesV2Schema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_qualification_candidates',400);
 const q=parsed.data;
 return service.access.runAuthorized(actor,'assistance',async db=>{
  const target=await service.assistance.requireTaskWithin(db,actor,q.taskId),request=target.snapshot.request;
  const policy=request.qualification?await service.legacy.policyWithin(db,request.qualification.policyId,request.qualification.policyVersion,request.capabilityId,request.collaboration):null;
  const items=[];let cursor=q.after??null,done=false;
  while(!done&&items.length<=q.limit){const rows=(await db.query(queries[q.kind],[actor.subjectId,cursor])).rows;done=rows.length<80;
   for(const row of rows){cursor=row.id;
    try{let item;
     if(q.kind==='participation'){
      if(!policy)continue;
      const r=await service.participationWithin(db,actor,row.id,actor.subjectId,policy);
      item={id:row.id,kind:q.kind,label:r.scope??'已有参与，当前接受依据不足',role:r.role??null,taskId:r.taskId??null,
       sourceStatus:r.usable?'current-accepted-scope':r.reason,synthetic:r.synthetic??null,evidence:{participationIds:[row.id]}};
     }else if(q.kind==='external-review'){
      const r=await service.experienceReviews.readWithin(db,actor,{id:row.id,version:row.version});
      if(r.referenceStatus!=='current'||!r.record||r.experienceSubjectId!==actor.subjectId||policy&&r.record.capabilityId!==policy.capabilityId)continue;
      item={id:row.id,kind:q.kind,version:row.version,label:r.record.scope,sourceStatus:r.record.state,synthetic:r.synthetic,
       evidence:{externalReviewRefs:[{id:row.id,version:row.version}]}};
     }else if(q.kind==='calculation'){
      if(!service.calculations)continue;
      const r=await service.calculations.readGrantWithin(db,actor,row.id),c=r.payload;
      if(c.kind!=='compute'||c.taskId!==q.taskId||c.candidateId!==actor.subjectId||c.recipientId!==target.requesterId)continue;
      const evidence={...c.evidence,calculationGrantId:row.id};
      await service.calculations.contextWithin(db,actor,{taskId:q.taskId,subjectId:actor.subjectId,evidence});
      item={id:row.id,kind:q.kind,label:'本任务限定资格计算许可',sourceStatus:'current-licensed-computation',expiresAt:c.expiresAt,evidence};
     }else if(q.kind==='capsule-use'){
      const raw=(await db.query('SELECT * FROM capsule_uses_v2 WHERE id=$1',[row.id])).rows[0],r=await service.capsules.v2.useWithin(db,actor,raw);
      if(!r.record||r.sourceStatus!=='current'||r.kind==='reference')continue;
      item={id:row.id,kind:q.kind,label:'已记录的实际应用；仍需限定审核',sourceStatus:'actual-application-requires-scoped-review',synthetic:r.synthetic,evidence:{capsuleUseIds:[row.id]}};
     }else if(q.kind==='legacy-assistance'){
      const r=await service.assistance.readWithin(db,actor,row.id);
      if(r.selected?.providerId!==actor.subjectId||policy&&r.request.capabilityId!==policy.capabilityId)continue;
      item={id:row.id,kind:q.kind,label:r.request.title,sourceStatus:r.state==='accepted'?'legacy-accepted-current-check-required':'legacy-not-yet-accepted',
       evidence:{assistanceIds:[row.id]}};
     }else{
      await service.legacy.proofs.readWithin(db,actor,row.id);
      item={id:row.id,kind:q.kind,label:'本人当前 CI 证明；不代替实际经历',sourceStatus:'current-ci-proof',evidence:{proofIds:[row.id]}};
     }
     items.push(item);if(items.length>q.limit)break;
    }catch(error){if(!(error instanceof ServiceError&&[403,404,409,422,503].includes(error.status)))throw error;}
   }
  }
  const more=items.length>q.limit;return {schemaVersion:2,subjectId:actor.subjectId,taskId:q.taskId,kind:q.kind,
   items:items.slice(0,q.limit),nextAfter:more?items[q.limit-1].id:null,checkedAt:service.access.now(),
   qualificationGranted:false,sourcePermissionsChanged:false,coverage:'currently-authorized-owned-materials; current evaluation required'};
 });
}
