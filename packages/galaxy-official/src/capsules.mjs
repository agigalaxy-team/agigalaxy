import { capsuleEventSchema,capsuleUseSchema,capsuleQuerySchema,capsuleReadSchema,capsuleUsesQuerySchema } from './shared/capsule-schema.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
import { canReadProjection } from './domain/consent-policy.mjs';
import { projectCaseReviews } from './domain/case-review.mjs';
import { transaction } from './database.mjs';
import { recordObjectAudit } from './infrastructure/object-audit.mjs';
function parse(payloadJson,schema){try{if(typeof payloadJson!=='string'||Buffer.byteLength(payloadJson)>16000)throw new Error();return schema.parse(JSON.parse(payloadJson));}catch{throw new ServiceError('invalid_capsule_payload');}}
export class CapsuleService {
  constructor(access,consents,proofs){Object.assign(this,{access,consents,proofs});}
  publishV2(actor,input){return this.v2.publish(actor,input);}
  getV2(actor,input){return this.v2.get(actor,input);}
  queryV2(actor,input){return this.v2.query(actor,input);}
  recordUseV2(actor,input){return this.v2.recordUse(actor,input);}
  usesV2(actor,input){return this.v2.uses(actor,input);}
  previewV2(actor,input){return this.v2.preview(actor,input);}
  permissionV2(actor,input){return this.v2.permission(actor,input);}
  permissionReadV2(actor,input){return this.v2.getPermission(actor,input);}
  receiptV2(actor,input){return this.v2.receipt(actor,input);}
  versionsV2(actor,input){return this.v2.versions(actor,input);}
  permissionsQueryV2(actor,input){return this.v2.permissions(actor,input);}
  readV2Within(db,actor,input){return this.v2.readWithin(db,actor,input);}
  usesV2Within(db,actor,input){return this.v2.usesWithin(db,actor,input);}
  grant(db,row,action){if(!row?.payload_text)throw new ServiceError('capsule_source_unavailable',404);return this.consents.require(db,{id:row.consent_id,subjectId:row.subject_id,objectId:row.id,action,recipient:this.access.endpoint,payloadJson:row.payload_text});}
  visible(grant,actor){return canReadProjection(grant,{viewerId:actor?.subjectId??null,now:this.access.now()});}
  async caseSource(db,caseId,subjectId){
    const parent=(await db.query('SELECT * FROM cases WHERE id=$1 AND subject_id=$2 FOR SHARE',[caseId,subjectId])).rows[0];
    if(!parent||parent.state==='withdrawn')throw new ServiceError('capsule_case_unavailable',403);
    const events=(await db.query('SELECT * FROM case_events WHERE case_id=$1 ORDER BY version LIMIT 1001',[caseId])).rows;
    if(events.length>1000)throw new ServiceError('case_event_limit',413);
    for(const event of events)await this.grant(db,event,'case.teaser.publish');
    const pending=projectCaseReviews(events.map(e=>e.payload)).some(r=>!['resolved','rejected'].includes(r.state));
    return {parent,events,needsReview:pending||events.some(e=>e.kind==='revision'&&!e.payload.review)};
  }
  async proofReferences(db,actor,ids,caseId,resultId,required=false){const proofs=[];
    for(const id of ids){try{const row=(await db.query('SELECT p.id FROM proofs p JOIN evidence_submissions e ON e.id=p.evidence_id WHERE p.id=$1 AND e.case_id=$2 AND e.result_id=$3',[id,caseId,resultId])).rows[0];
      if(!row)throw new ServiceError('capsule_proof_mismatch',409);await this.proofs.readWithin(db,actor,id);proofs.push({proofId:id,state:'current',strength:'ci-execution-fact',capabilityVerified:false});
    }catch(error){if(!(error instanceof ServiceError))throw error;if(required)throw error;proofs.push({proofId:id,state:'unavailable',capabilityVerified:false});}}
    return proofs;
  }
  async version(db,actor,capsuleId,versionId){
    const row=(await db.query("SELECT * FROM capsule_events WHERE capsule_id=$1 AND kind='version' AND ($2::uuid IS NULL OR id=$2) ORDER BY revision DESC",[capsuleId,versionId??null])).rows;
    if(row[0]?.payload_text && JSON.parse(row[0].payload_text).schemaVersion===2)throw new ServiceError('unsupported_semantics',409);
    for(const candidate of row){try{const grant=await this.grant(db,candidate,'capsule.publish');if(!this.visible(grant,actor))continue;
      const payload=JSON.parse(candidate.payload_text),source=await this.caseSource(db,payload.sourceResolution.caseId,candidate.subject_id);
      const notices=(await db.query("SELECT * FROM capsule_events WHERE capsule_id=$1 AND version_id=$2 AND kind<>'version' ORDER BY revision",[capsuleId,candidate.id])).rows;
      let deprecated=false,securityIssue=false;const visibleNotices=[];
      for(const notice of notices){if(notice.kind==='deprecate')deprecated=true;if(notice.kind==='security-issue')securityIssue=true;if(notice.kind==='resolve-security')securityIssue=false;
        try{if(this.visible(await this.grant(db,notice,'capsule.publish'),actor))visibleNotices.push({revision:notice.revision,...JSON.parse(notice.payload_text)});}catch(error){if(!(error instanceof ServiceError))throw error;}}
      return {row:candidate,payload,grant,source,deprecated,securityIssue,notices:visibleNotices};
    }catch(error){if(!(error instanceof ServiceError))throw error;}}
    throw new ServiceError('capsule_unavailable',404);
  }
  async publish(actor,{consentId,payloadJson}){const payload=parse(payloadJson,capsuleEventSchema);
    return this.access.runResourceWrite(actor,'capsules',{control:payload.kind!=='version'},async(db,authorization)=>{
      if(payload.kind==='version'&&payload.expectedRevision===0)await db.query('INSERT INTO capsules(id,subject_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[payload.capsuleId,actor.subjectId]);
      const parent=(await db.query('SELECT * FROM capsules WHERE id=$1 AND subject_id=$2 FOR UPDATE',[payload.capsuleId,actor.subjectId])).rows[0];if(!parent)throw new ServiceError('capsule_owner_required',403);
      const grant=await this.grant(db,{id:payload.id,subject_id:actor.subjectId,consent_id:consentId,payload_text:payloadJson},'capsule.publish');
      if(!['Private','Public'].includes(grant.visibility))throw new ServiceError('capsule_visibility_required',403);
      const previous=(await db.query('SELECT * FROM capsule_events WHERE id=$1',[payload.id])).rows[0];if(previous){if(previous.capsule_id!==parent.id||previous.subject_id!==actor.subjectId||previous.payload_hash!==digest(payloadJson)||previous.consent_id!==consentId)throw new ServiceError('capsule_conflict',409);return {capsuleId:parent.id,eventId:payload.id,revision:previous.revision};}
      if((await db.query("SELECT 1 FROM capsule_events WHERE capsule_id=$1 AND NULLIF(payload_text,'')::jsonb->>'schemaVersion'='2' LIMIT 1",[parent.id])).rows.length)throw new ServiceError('unsupported_semantics',409);
      if(parent.revision!==payload.expectedRevision||parent.revision>=200)throw new ServiceError('capsule_revision_conflict',409);
      let versionId=payload.versionId;
      if(payload.kind==='version'){
        const count=Number((await db.query("SELECT count(*) FROM capsule_events WHERE capsule_id=$1 AND kind='version'",[parent.id])).rows[0].count);
        if(payload.version!==count+1)throw new ServiceError('capsule_version_conflict',409);
        const source=await this.caseSource(db,payload.sourceResolution.caseId,actor.subjectId),result=source.events.find(e=>e.id===payload.sourceResolution.resultId&&e.kind==='result');
        if(!result||result.payload.outcome!=='succeeded'||source.needsReview)throw new ServiceError('capsule_resolution_required',409);
        await this.proofReferences(db,actor,payload.sourceResolution.proofIds,source.parent.id,result.id,true);
        for(const subjectId of payload.contributors)if(!(await db.query('SELECT id FROM subjects WHERE id=$1',[subjectId])).rows.length)throw new ServiceError('capsule_contributor_unknown',409);
        versionId=payload.id;
      }else{
        const current=await this.version(db,actor,parent.id,payload.versionId);
        if(grant.visibility!==current.grant.visibility||JSON.stringify([...grant.viewers].sort((a,b)=>a.localeCompare(b)))!==JSON.stringify([...current.grant.viewers].sort((a,b)=>a.localeCompare(b))))throw new ServiceError('capsule_notice_visibility_mismatch',403);
        if(payload.kind==='deprecate'&&current.deprecated||payload.kind==='security-issue'&&current.securityIssue||payload.kind==='resolve-security'&&!current.securityIssue)throw new ServiceError('capsule_transition_denied',409);
        if(payload.replacementVersionId){if(payload.replacementVersionId===payload.versionId)throw new ServiceError('capsule_replacement_mismatch');await this.version(db,actor,parent.id,payload.replacementVersionId);}
      }
      const revision=parent.revision+1;
      await db.query('INSERT INTO capsule_events(id,capsule_id,subject_id,revision,version_id,kind,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[payload.id,parent.id,actor.subjectId,revision,versionId,payload.kind,consentId,payloadJson,digest(payloadJson)]);
      await db.query('UPDATE capsules SET revision=$2 WHERE id=$1',[parent.id,revision]);
      await recordObjectAudit(db,{subjectId:actor.subjectId,objectId:payload.id,action:'capsule.event',httpRequestId:actor.httpRequestId??null,...authorization});
      return {capsuleId:parent.id,eventId:payload.id,revision};
    });
  }
  async recordUse(actor,{consentId,payloadJson}){const payload=parse(payloadJson,capsuleUseSchema);
    return this.access.runResourceWrite(actor,'capsules',{},async(db,authorization)=>{
      const parent=(await db.query('SELECT * FROM capsules WHERE id=$1 FOR UPDATE',[payload.capsuleId])).rows[0];if(!parent)throw new ServiceError('capsule_unavailable',404);
      const current=await this.version(db,actor,payload.capsuleId,payload.versionId);
      const grant=await this.grant(db,{id:payload.id,subject_id:actor.subjectId,consent_id:consentId,payload_text:payloadJson},'capsule.use');
      if(!['Private','Public'].includes(grant.visibility))throw new ServiceError('capsule_visibility_required',403);
      const previous=(await db.query('SELECT * FROM capsule_uses WHERE id=$1',[payload.id])).rows[0];
      if(previous){if(previous.subject_id!==actor.subjectId||previous.payload_hash!==digest(payloadJson)||previous.consent_id!==consentId)throw new ServiceError('capsule_use_conflict',409);return {capsuleId:payload.capsuleId,eventId:payload.id,kind:payload.kind};}
      if(payload.attribution!==parent.subject_id)throw new ServiceError('capsule_attribution_mismatch');
      const source=await this.caseSource(db,payload.caseId,actor.subjectId);
      if(payload.kind!=='reference'){
        if(current.deprecated||current.securityIssue||current.source.needsReview)throw new ServiceError('capsule_not_applicable',409);
        if(payload.caseId===current.payload.sourceResolution.caseId)throw new ServiceError('capsule_new_case_required',409);
        const result=source.events.find(e=>e.id===payload.resultId&&e.kind==='result'),attempt=source.events.find(e=>e.id===payload.attemptId&&e.kind==='attempt');
        if(!result||!attempt||result.payload.attemptId!==attempt.id||result.payload.outcome!==payload.outcome
          ||attempt.payload.configuration.environment!==payload.environment.name||attempt.payload.configuration.version!==payload.environment.version)throw new ServiceError('capsule_result_mismatch',409);
        if(payload.kind==='reverify'){
          const prior=(await db.query("SELECT * FROM capsule_uses WHERE id=$1 AND subject_id=$2 AND version_id=$3 AND case_id=$4 AND kind='apply'",[payload.priorUseId,actor.subjectId,payload.versionId,payload.caseId])).rows[0];
          if(!prior)throw new ServiceError('capsule_application_required',409);await this.grant(db,prior,'capsule.use');
          await this.proofReferences(db,actor,payload.proofIds,payload.caseId,payload.resultId,true);
        }
      }
      try{await db.query('INSERT INTO capsule_uses(id,capsule_id,version_id,subject_id,case_id,attempt_id,result_id,prior_use_id,kind,observed_revision,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[payload.id,payload.capsuleId,payload.versionId,actor.subjectId,payload.caseId,payload.attemptId??null,payload.resultId??null,payload.priorUseId??null,payload.kind,parent.revision,consentId,payloadJson,digest(payloadJson)]);}catch(error){if(error.code==='23505')throw new ServiceError('capsule_use_already_recorded',409);throw error;}
      await recordObjectAudit(db,{subjectId:actor.subjectId,objectId:payload.id,action:'capsule.use',httpRequestId:actor.httpRequestId??null,...authorization});
      return {capsuleId:payload.capsuleId,eventId:payload.id,kind:payload.kind};
    });
  }
  async readWithin(db,actor,input){const current=await this.version(db,actor,input.capsuleId,input.versionId),parent=(await db.query('SELECT * FROM capsules WHERE id=$1',[input.capsuleId])).rows[0];
    const versionRows=(await db.query("SELECT * FROM capsule_events WHERE capsule_id=$1 AND kind='version' ORDER BY revision",[parent.id])).rows,versions=[];
    for(const row of versionRows){try{if(this.visible(await this.grant(db,row,'capsule.publish'),actor)){const payload=JSON.parse(row.payload_text);versions.push({versionId:row.id,version:payload.version,title:payload.title});}}catch(error){if(!(error instanceof ServiceError))throw error;}}
    const sourceProofs=await this.proofReferences(db,actor,current.payload.sourceResolution.proofIds,current.payload.sourceResolution.caseId,current.payload.sourceResolution.resultId);
    return {capsuleId:parent.id,authorId:parent.subject_id,revision:actor?.subjectId===parent.subject_id?parent.revision:Math.max(current.row.revision,...current.notices.map(n=>n.revision)),
      versionId:current.row.id,version:current.payload,versions,notices:current.notices,deprecated:current.deprecated,securityIssue:current.securityIssue,
      sourceNeedsReview:current.source.needsReview,sourceProofs,capabilityVerified:false,
      contributorsAuthority:'author-declared attribution; not contributor approval',
      ...(actor?.subjectId===parent.subject_id?{nextVersion:versionRows.length+1,disclosure:{visibility:current.grant.visibility,viewers:current.grant.viewers}}:{})};
  }
  get(actor,input){if(!capsuleReadSchema.safeParse(input).success)throw new ServiceError('invalid_capsule_query');return actor?this.access.runAuthorized(actor,'capsules',db=>this.readWithin(db,actor,input)):transaction(this.access.db,db=>this.readWithin(db,null,input));}
  async query(actor,input={},{candidateIds=null}={}){const parsed=capsuleQuerySchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_capsule_query');const options=parsed.data;
    const read=async db=>{const rows=(await db.query(`SELECT p.id FROM capsules p WHERE ($1::uuid IS NULL OR p.id>$1) AND ($2::text IS NULL OR p.subject_id=$2)
      AND ($6::uuid[] IS NULL OR p.id=ANY($6))
      AND EXISTS(SELECT 1 FROM capsule_events v JOIN consents c ON c.id=v.consent_id JOIN bindings b ON b.id=c.binding_id
        JOIN cases source ON source.id=(NULLIF(v.payload_text,'')::jsonb->'sourceResolution'->>'caseId')::uuid
        WHERE v.capsule_id=p.id AND v.kind='version' AND source.subject_id=v.subject_id AND source.state<>'withdrawn'
          AND c.subject_id=v.subject_id AND b.subject_id=v.subject_id AND c.revoked_at IS NULL AND b.revoked_at IS NULL
          AND c.expires_at>$4 AND b.expires_at>$4 AND c.intent->>'recipient'=$5 AND c.intent->>'action'='capsule.publish'
          AND c.intent->>'objectId'=v.id::text AND c.intent->>'payloadHash'=v.payload_hash
          AND (v.subject_id=$3 OR c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile'
            OR c.intent->>'visibility'='Private' AND c.intent->'viewers' ? COALESCE($3,''))
          AND NOT EXISTS(SELECT 1 FROM case_events e LEFT JOIN consents source_grant ON source_grant.id=e.consent_id LEFT JOIN bindings binding ON binding.id=source_grant.binding_id
            WHERE e.case_id=source.id AND (source_grant.id IS NULL OR binding.id IS NULL OR source_grant.revoked_at IS NOT NULL OR binding.revoked_at IS NOT NULL
              OR source_grant.expires_at<=$4 OR binding.expires_at<=$4 OR source_grant.subject_id<>source.subject_id OR binding.subject_id<>source.subject_id
              OR source_grant.intent->>'action'<>'case.teaser.publish' OR source_grant.intent->>'recipient'<>$5
              OR source_grant.intent->>'objectId'<>e.id::text OR source_grant.intent->>'payloadHash'<>e.payload_hash)))
      ORDER BY p.id LIMIT 201`,[options.after??null,options.authorId??null,actor?.subjectId??null,new Date(this.access.now()*1000).toISOString(),this.access.endpoint,candidateIds])).rows,items=[];let last=null;
      for(const row of rows.slice(0,200)){try{const item=await this.readWithin(db,actor,{capsuleId:row.id});last=row.id;const version=item.version;
        if(options.capabilityId&&version.capabilityId!==options.capabilityId||!`${version.title} ${version.problemPattern}`.toLowerCase().includes(options.query.toLowerCase()))continue;
        items.push({capsuleId:row.id,versionId:item.versionId,version:version.version,title:version.title,capabilityId:version.capabilityId,deprecated:item.deprecated,securityIssue:item.securityIssue,sourceNeedsReview:item.sourceNeedsReview});if(items.length>options.limit)break;
      }catch(error){if(!(error instanceof ServiceError))throw error;}}
      const page=items.slice(0,options.limit),windowLimited=items.length<=options.limit&&rows.length>200;
      return {items:page,nextAfter:items.length>options.limit?page.at(-1).capsuleId:windowLimited?last:null,windowLimited};};
    return actor?this.access.runAuthorized(actor,'capsules',read):transaction(this.access.db,read);
  }
  async usesWithin(db,actor,input){const options=capsuleUsesQuerySchema.parse(input),rows=(await db.query(`SELECT u.* FROM capsule_uses u
      JOIN consents c ON c.id=u.consent_id JOIN bindings b ON b.id=c.binding_id
      JOIN capsule_events v ON v.id=u.version_id JOIN consents vc ON vc.id=v.consent_id JOIN bindings vb ON vb.id=vc.binding_id
      JOIN cases source ON source.id=u.case_id AND source.subject_id=u.subject_id
      WHERE ($1::uuid IS NULL OR u.capsule_id=$1) AND ($2::uuid IS NULL OR u.version_id=$2)
        AND ($3::uuid IS NULL OR u.case_id=$3) AND ($4::uuid IS NULL OR u.id>$4) AND source.state<>'withdrawn'
        AND c.subject_id=u.subject_id AND b.subject_id=u.subject_id AND c.revoked_at IS NULL AND b.revoked_at IS NULL
        AND c.expires_at>$6 AND b.expires_at>$6 AND c.intent->>'recipient'=$7 AND c.intent->>'action'='capsule.use'
        AND c.intent->>'objectId'=u.id::text AND c.intent->>'payloadHash'=u.payload_hash
        AND (u.subject_id=$5 OR c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile'
          OR c.intent->>'visibility'='Private' AND c.intent->'viewers' ? COALESCE($5,''))
        AND vc.subject_id=v.subject_id AND vb.subject_id=v.subject_id AND vc.revoked_at IS NULL AND vb.revoked_at IS NULL
        AND vc.expires_at>$6 AND vb.expires_at>$6 AND vc.intent->>'recipient'=$7 AND vc.intent->>'action'='capsule.publish'
        AND vc.intent->>'objectId'=v.id::text AND vc.intent->>'payloadHash'=v.payload_hash
        AND (v.subject_id=$5 OR vc.intent->>'visibility'='Public' AND vc.intent->>'purpose'='public-profile'
          OR vc.intent->>'visibility'='Private' AND vc.intent->'viewers' ? COALESCE($5,''))
        AND NOT EXISTS(SELECT 1 FROM case_events e LEFT JOIN consents g ON g.id=e.consent_id LEFT JOIN bindings gb ON gb.id=g.binding_id
          WHERE e.case_id=source.id AND (g.id IS NULL OR gb.id IS NULL OR g.revoked_at IS NOT NULL OR gb.revoked_at IS NOT NULL
            OR g.expires_at<=$6 OR gb.expires_at<=$6 OR g.subject_id<>source.subject_id OR gb.subject_id<>source.subject_id
            OR g.intent->>'recipient'<>$7 OR g.intent->>'action'<>'case.teaser.publish'
            OR g.intent->>'objectId'<>e.id::text OR g.intent->>'payloadHash'<>e.payload_hash))
      ORDER BY u.id LIMIT 201`,[options.capsuleId??null,options.versionId??null,options.caseId??null,options.after??null,actor?.subjectId??null,new Date(this.access.now()*1000).toISOString(),this.access.endpoint])).rows,items=[];let last=null;
    for(const row of rows.slice(0,200)){try{if(!this.visible(await this.grant(db,row,'capsule.use'),actor))continue;const source=await this.caseSource(db,row.case_id,row.subject_id),payload=JSON.parse(row.payload_text);
      const current=await this.version(db,actor,row.capsule_id,row.version_id);
      if(payload.kind==='reverify'){const prior=(await db.query('SELECT * FROM capsule_uses WHERE id=$1',[payload.priorUseId])).rows[0];if(!prior)continue;await this.grant(db,prior,'capsule.use');}
      const proofs=await this.proofReferences(db,actor,payload.proofIds??[],row.case_id,row.result_id);
      const verification=payload.kind==='reverify'&&proofs.length&&proofs.every(p=>p.state==='current')&&!source.needsReview?'current-ci-facts':'participant-reported';
      const reuseEvidence=payload.kind==='reference'?null:{type:'capsule-reuse',id:row.id,subjectId:row.subject_id,attribution:payload.attribution,
        capsuleId:row.capsule_id,versionId:row.version_id,caseId:row.case_id,attemptId:payload.attemptId,resultId:payload.resultId,
        outcome:payload.outcome,sourceHash:row.payload_hash,sourceCaseVersion:source.parent.version,sourceNeedsReview:source.needsReview,
        provenance:'case-owner-reported-application',verification,proofs,capabilityVerified:false,
        limitations:['CI verifies its referenced run, not Capsule causality or individual capability.'],checkedAt:this.access.now()};
      items.push({subjectId:row.subject_id,...payload,sourceNeedsReview:source.needsReview,capsuleDeprecated:current.deprecated,capsuleSecurityIssue:current.securityIssue,
        proofs,verification,reuseEvidence,capabilityVerified:false});last=row.id;if(items.length>options.limit)break;
    }catch(error){if(!(error instanceof ServiceError))throw error;}}
    const page=items.slice(0,options.limit),windowLimited=items.length<=options.limit&&rows.length>200;
    return {items:page,nextAfter:items.length>options.limit?page.at(-1).id:windowLimited?last:null,windowLimited,countsScope:'visible-page-only',
      counts:{references:page.filter(i=>i.kind==='reference').length,applications:page.filter(i=>i.kind==='apply').length,reverifications:page.filter(i=>i.kind==='reverify').length,failed:page.filter(i=>i.outcome==='failed').length},readingIsReuse:false};
  }
  uses(actor,input){if(!capsuleUsesQuerySchema.safeParse(input).success)throw new ServiceError('invalid_capsule_query');return actor?this.access.runAuthorized(actor,'capsules',db=>this.usesWithin(db,actor,input)):transaction(this.access.db,db=>this.usesWithin(db,null,input));}
  async visibleUpdate(db,actor,eventId){const event=(await db.query('SELECT * FROM capsule_events WHERE id=$1',[eventId])).rows[0];if(!event||!this.visible(await this.grant(db,event,'capsule.publish'),actor))return null;
    if(this.v2)return this.v2.visibleUpdateWithin(db,actor,event);
    const current=await this.version(db,actor,event.capsule_id,event.version_id),payload=JSON.parse(event.payload_text);
    return {title:current.payload.title,capsuleId:event.capsule_id,versionId:event.version_id,actorId:event.subject_id,eventKind:payload.kind,summary:payload.summary??'New Capsule version'};
  }
}
