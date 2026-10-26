import {randomUUID} from 'node:crypto';
import {ciRequestV2Schema,ciIdSchema,ciReceiptSchema,ciProofPreviewSchema,ciSourceMetadata,describeCiProofV2} from "../shared/ci-observation-v2-schema.mjs";
import {digest} from "../shared/digest.mjs";
import {ServiceError} from "../shared/service-error.mjs";
import {transaction} from "../infrastructure/database.mjs";
import {canReadProjection} from "../domain/consent-policy.mjs";
import {githubEvidenceSource} from './github-evidence.mjs';
import {checkedObservation} from './evidence-source.mjs';
const rule=(ok,code,status=409)=>{if(!ok)throw new ServiceError(code,status);};
const parse=(schema,value,code)=>{const p=schema.safeParse(value);rule(p.success,code,422);return p.data;};
const one=async(db,sql,args)=>(await db.query(sql,args)).rows[0];
const iso=now=>new Date(now*1000).toISOString();
const flags={taskOutcomeVerified:false,capabilityVerified:false,independentExecutionVerified:false};

// API callers are authenticated normally. A worker has no user actor or session:
// sourceReader builds a read-only reader limited to this signed request. Its
// subject ID is a delegated read recipient, never an authentication substitute.
export class CiObservationV2Service{
  constructor(access,consents,{records,sourceReader,db=access?.db,endpoint=access?.endpoint,now=access?.now,
    source=githubEvidenceSource,sign,verifyEnvelope=null,trustedKeys=access?.trustedKeys,resourceBudgetPolicy=access?.resourceBudgetPolicy}={}){
    Object.assign(this,{access,consents,records,sourceReader,db,endpoint,now,source,sign,verifyEnvelope,trustedKeys,resourceBudgetPolicy});
    this.jobKind='verify-github-v2';
  }
  async requestWithin(db,id){const row=await one(db,'SELECT * FROM ci_requests_v2 WHERE id=$1',[id]);rule(row,'ci_request_unavailable',404);return row;}
  receipt(actor,input){const q=parse(ciReceiptSchema,input,'invalid_ci_receipt');return this.access.runAuthorized(actor,q.type==='request'?'evidence':'proof',async db=>{
    const row=await one(db,`SELECT * FROM ${q.type==='request'?'ci_requests_v2':'ci_proofs_v2'} WHERE id=$1 AND subject_id=$2`,[q.id,actor.subjectId]);
    return row?{id:q.id,type:q.type,state:'recorded',payloadHash:row.payload_hash,consentId:row.consent_id,
      objectState:q.type==='request'?row.state:row.revoked_at?'revoked':'recorded-not-current-verified',...flags}:{id:q.id,type:q.type,state:'absent'};
  });}
  async sourceWithin(db,row){
    rule(row.state!=='revoked'&&row.payload_text&&digest(row.payload_text)===row.payload_hash,'ci_source_unavailable');
    const data=parse(ciRequestV2Schema,JSON.parse(row.payload_text),'ci_request_unavailable');
    const grant=await this.consents.require(db,{id:row.consent_id,subjectId:row.subject_id,action:'ci.observe',objectId:row.id,
      recipient:this.endpoint,payloadJson:row.payload_text});
    rule(!grant.currentVisibility?.deletionPending,'ci_source_unavailable');
    const records=this.sourceReader?this.sourceReader(row):this.records;
    rule(records,'ci_source_reader_unavailable',503);
    const recipient={subjectId:row.subject_id};
    const evidence=await records.requireReferenceWithin(db,recipient,{kind:'evidence',...data.evidenceRef},{caseId:data.caseId});
    const {fact:result}=await records.targetWithin(db,recipient,{type:'result',...data.resultRef},{caseId:data.caseId,latest:true});
    await records.targetWithin(db,recipient,{type:result.origin.kind,id:result.origin.id,version:result.origin.version},{caseId:data.caseId,latest:true});
    const context=await records.caseWithin(db,data.caseId),root=context.rows.find(r=>['case','case-created'].includes(r.kind));
    const rootGrant=await records.cases.requireEventVisibleWithin(db,recipient,root);
    rule(!rootGrant.currentVisibility?.deletionPending,'ci_source_unavailable');
    const record=evidence.record;
    rule(record.reportedBy===row.subject_id&&result.actorId===row.subject_id,'ci_source_author_required',403);
    rule(record.evidenceType==='ci-result','ci_profile_mismatch',422);
    const metadata=ciSourceMetadata(data.source);
    rule(Object.entries(metadata).every(([key,value])=>record.source[key]===value),'ci_profile_mismatch',422);
    rule(!record.taskId||record.taskId===result.taskId,'ci_task_mismatch',422);
    rule(!record.participationId||record.participationId===result.participationId,'ci_participation_mismatch',422);
    rule(!record.participationScopeVersion||record.participationScopeVersion===result.participationScopeVersion,'ci_scope_mismatch');
    // A CI label is never sufficient. Source ownership remains asserted; the
    // provider adapter checks the actual public run and numeric repository ID.
    return{data,evidence,result,synthetic:evidence.synthetic||context.facts.synthetic===true};
  }
  async audit(db,actor,id,consentId,action,scope,authorization){
    const saved=await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,
      consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
      SELECT $1,$2,$3,$3,'accepted',1,ch.payload->>'installationId',b.audience,$4,c.id,b.id,$5,$3,b.scopes,$6::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
      FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id
      JOIN bindings cb ON cb.id=$7::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id
      WHERE c.id=$8::uuid AND c.subject_id=$1 RETURNING sequence`,[actor.subjectId,action,id,scope,actor.httpRequestId??null,
        JSON.stringify(authorization.credentialScopes),authorization.callerBindingId,consentId]);
    rule(saved.rows.length===1,'ci_audit_context_unavailable',500);
  }
  async submit(actor,request){
    rule(typeof request?.payloadJson==='string'&&Buffer.byteLength(request.payloadJson)<=8000,'invalid_ci_request',422);
    let input;try{input=JSON.parse(request.payloadJson);}catch{throw new ServiceError('invalid_ci_request',422);}
    const data=parse(ciRequestV2Schema,input,'invalid_ci_request');
    return this.access.runResourceWrite(actor,'evidence',{},async(db,authorization)=>{
      const row={id:data.id,subject_id:actor.subjectId,consent_id:request.consentId,payload_text:request.payloadJson,payload_hash:digest(request.payloadJson),state:'pending'};
      await this.sourceWithin(db,row);
      await db.query(`INSERT INTO ci_requests_v2(id,subject_id,consent_id,case_id,evidence_id,evidence_version,result_id,result_version,source_key,payload_text,payload_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,[data.id,actor.subjectId,request.consentId,data.caseId,
        data.evidenceRef.id,data.evidenceRef.version,data.resultRef.id,data.resultRef.version,this.source.sourceKey(data.source),request.payloadJson,row.payload_hash]);
      const saved=await one(db,'SELECT * FROM ci_requests_v2 WHERE id=$1 FOR UPDATE',[data.id]);
      rule(saved.subject_id===actor.subjectId&&saved.consent_id===request.consentId&&saved.payload_hash===row.payload_hash,'ci_request_conflict');
      rule(saved.state!=='revoked','ci_request_revoked');
      await db.query(`INSERT INTO jobs(id,kind,deduplication_key,payload,state,available_at) VALUES($1,$2,$3,$4::jsonb,'pending',$5)
        ON CONFLICT(deduplication_key) DO NOTHING`,[randomUUID(),this.jobKind,`ci-v2:${data.id}`,JSON.stringify({ciRequestId:data.id}),iso(this.now())]);
      await this.audit(db,actor,data.id,request.consentId,'ci.observe','evidence',authorization);
      return{requestId:data.id,state:saved.state,...flags};
    });
  }
  async get(actor,input){const{id}=parse(ciIdSchema,input,'invalid_ci_id');return this.access.runAuthorized(actor,'evidence',async db=>{
    const row=await this.requestWithin(db,id);rule(row.subject_id===actor.subjectId,'ci_request_unavailable',404);
    if(row.state==='revoked')return{requestId:id,state:'revoked',...flags};
    let current;try{current=await this.sourceWithin(db,row);}catch(e){if(!(e instanceof ServiceError))throw e;return{requestId:id,state:'source-unavailable',...flags};}
    const latest=await one(db,'SELECT * FROM ci_observations_v2 WHERE request_id=$1 ORDER BY attempt DESC LIMIT 1',[id]);
    const state=row.state==='observed'&&latest?.observation.validUntil<=this.now()?'stale':row.state;
    return{requestId:id,state,evidenceRef:current.data.evidenceRef,resultRef:current.data.resultRef,synthetic:current.synthetic,
      observation:latest?.observation??null,...flags};
  });}
  async revokeRequest(actor,input){const{id}=parse(ciIdSchema,input,'invalid_ci_id');return this.access.runResourceWrite(actor,'evidence',{control:true},async(db,a)=>{
    const row=await one(db,'SELECT * FROM ci_requests_v2 WHERE id=$1 AND subject_id=$2 FOR UPDATE',[id,actor.subjectId]);rule(row,'ci_request_unavailable',404);
    await db.query("UPDATE ci_requests_v2 SET state='revoked' WHERE id=$1",[id]);
    await this.audit(db,actor,id,row.consent_id,'ci.revoke','evidence',a);return{requestId:id,state:'revoked',...flags};
  });}
  async processNext(verify=this.source.verify){
    const job=await transaction(this.db,async db=>{
      const at=iso(this.now());
      if(this.resourceBudgetPolicy){await db.query('SELECT pg_advisory_xact_lock(734912310)');
        const active=Number((await one(db,"SELECT count(*) FROM jobs WHERE state='running' AND locked_until>$1",[at])).count);
        if(active>=this.resourceBudgetPolicy.maxActiveJobsGlobal)return null;}
      await db.query(`UPDATE jobs SET state='failed',lease_id=NULL,locked_until=NULL WHERE kind=$1 AND attempts>=5
        AND (state='pending' OR state='running' AND locked_until<=$2)`,[this.jobKind,at]);
      await db.query(`UPDATE ci_requests_v2 r SET state='unavailable' WHERE r.state='pending' AND EXISTS
        (SELECT 1 FROM jobs j WHERE j.kind=$1 AND j.payload->>'ciRequestId'=r.id::text AND j.state='failed')`,[this.jobKind]);
      const found=await one(db,`SELECT j.* FROM jobs j JOIN ci_requests_v2 r ON r.id=(j.payload->>'ciRequestId')::uuid
        WHERE j.kind=$1 AND j.attempts<5 AND (j.state='pending' AND j.available_at<=$2 OR j.state='running' AND j.locked_until<=$2)
        AND (SELECT count(*) FROM jobs other LEFT JOIN ci_requests_v2 own ON own.id::text=other.payload->>'ciRequestId'
          LEFT JOIN evidence_submissions legacy ON legacy.id::text=other.payload->>'evidenceId'
          WHERE (own.subject_id=r.subject_id OR legacy.subject_id=r.subject_id OR other.kind='builder-probe' AND other.payload->>'subjectId'=r.subject_id)
          AND other.state='running' AND other.locked_until>$2)<$3
        ORDER BY j.available_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,[this.jobKind,at,this.resourceBudgetPolicy?.maxActiveJobsPerSubject??5]);
      if(!found)return null;const lease=randomUUID();await db.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_id=$2,locked_until=$3 WHERE id=$1",
        [found.id,lease,iso(this.now()+30)]);return{...found,lease_id:lease,attempts:found.attempts+1};
    });
    if(!job)return{processed:false};let observation;
    try{const context=await transaction(this.db,async db=>this.sourceWithin(db,await this.requestWithin(db,job.payload.ciRequestId)));
      try{const at=this.now();observation=checkedObservation(this.source,await verify(context.data.source,at),context.data.source,at);
        rule(Buffer.byteLength(JSON.stringify(observation))<=16000,'ci_observation_too_large');}
      catch{observation={status:'unavailable',collectedAt:this.now(),capabilitiesVerified:false,reason:'source_unavailable_or_invalid'};}
    }catch(e){if(!(e instanceof ServiceError))throw e;observation={status:'revoked',collectedAt:this.now(),capabilitiesVerified:false};}
    return transaction(this.db,async db=>{
      // Lock original sources before lease/request rows: API writes use the same
      // source鈫抮equest order, so revocation and deletion cannot publish stale work.
      try{await this.sourceWithin(db,await this.requestWithin(db,job.payload.ciRequestId));}
      catch(e){if(!(e instanceof ServiceError))throw e;observation={status:'revoked',collectedAt:this.now(),capabilitiesVerified:false};}
      const current=await one(db,'SELECT * FROM jobs WHERE id=$1 FOR UPDATE',[job.id]);
      if(!current||current.state!=='running'||current.lease_id!==job.lease_id)return{processed:false,leaseLost:true};
      const row=await one(db,'SELECT * FROM ci_requests_v2 WHERE id=$1 FOR UPDATE',[job.payload.ciRequestId]);
      if(!row)return{processed:false,sourceDeleted:true};if(row.state==='revoked')observation={status:'revoked',collectedAt:this.now(),capabilitiesVerified:false};
      await db.query('INSERT INTO ci_observations_v2(id,request_id,job_id,attempt,observation) VALUES($1,$2,$3,$4,$5::jsonb)',
        [randomUUID(),row.id,job.id,job.attempts,JSON.stringify(observation)]);
      await db.query('UPDATE ci_requests_v2 SET state=$2 WHERE id=$1',[row.id,observation.status]);
      const retry=(observation.status==='unavailable'||observation.status==='observed'&&!observation.completed)&&job.attempts<5;
      await db.query('UPDATE jobs SET state=$2,lease_id=NULL,locked_until=NULL,available_at=$3 WHERE id=$1',[job.id,
        retry?'pending':observation.status==='unavailable'?'failed':'completed',iso(this.now()+Math.min(300,10*2**job.attempts))]);
      const audit=await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,idempotency_key,binding_scopes)
        SELECT $1,'ci.observed',$2::text,$3::text,$4,1,'galaxy-evidence-worker',b.audience,'evidence',c.id,b.id,$3::text||':'||$5::integer::text,b.scopes
        FROM ci_requests_v2 r JOIN consents c ON c.id=r.consent_id JOIN bindings b ON b.id=c.binding_id
        WHERE r.id=$2::text::uuid AND c.subject_id=r.subject_id AND b.subject_id=r.subject_id RETURNING 1`,
        [this.source.verifier,row.id,job.id,observation.status,job.attempts]);rule(audit.rows.length===1,'ci_audit_context_unavailable',500);
      return{processed:true,state:observation.status,...flags};
    });
  }
  async currentWithin(db,requestId){
    const row=await this.requestWithin(db,requestId),context=await this.sourceWithin(db,row);
    const current=await one(db,'SELECT * FROM ci_requests_v2 WHERE id=$1 FOR SHARE',[requestId]);rule(current?.state==='observed','ci_observation_unavailable');
    const observation=await one(db,'SELECT * FROM ci_observations_v2 WHERE request_id=$1 ORDER BY attempt DESC LIMIT 1',[requestId]);
    rule(observation?.observation.status==='observed'&&observation.observation.completed&&observation.observation.validUntil>this.now(),'ci_observation_unavailable');
    return{row,context,observation};
  }
  proofPayload(id,preparedAt,current){const o=current.observation.observation;return{version:2,type:'ci-execution-observation',
    sourceProfile:'facts-v2',id,subject:current.row.subject_id,issuer:this.endpoint,bindingId:current.row.id,observationId:current.observation.id,
    scope:'referenced-ci-run-only',strength:o.strength,independence:o.independence,attribution:o.attribution,source:o.source,sourceControl:o.sourceControl,
    conclusion:o.conclusion,synthetic:current.context.synthetic,taskOutcomeVerification:'not-independently-verified',capabilityVerified:false,
    preparedAt,observedAt:o.collectedAt,expiresAt:o.validUntil,limitations:o.limitations,statusPath:`/v2/ci/proofs/${id}/status`};}
  async preview(actor,input){const q=parse(ciProofPreviewSchema,input,'invalid_ci_proof_preview');return this.access.runAuthorized(actor,'proof',async db=>{
    const current=await this.currentWithin(db,q.requestId);rule(current.row.subject_id===actor.subjectId,'ci_request_unavailable',404);
    const payloadJson=JSON.stringify(this.proofPayload(q.id,this.now(),current));return{payloadJson,payloadHash:digest(payloadJson),published:false,...flags};
  });}
  async publish(actor,{consentId,payloadJson}){
    let q;try{rule(typeof payloadJson==='string'&&Buffer.byteLength(payloadJson)<=12000,'invalid_ci_proof',422);q=JSON.parse(payloadJson);
      parse(ciProofPreviewSchema,{id:q.id,requestId:q.bindingId},'invalid_ci_proof');rule(Number.isSafeInteger(q.preparedAt)&&q.preparedAt<=this.now()&&q.preparedAt>=this.now()-300,'invalid_ci_proof',422);
    }catch{throw new ServiceError('invalid_ci_proof',422);}
    return this.access.runResourceWrite(actor,'proof',{},async(db,a)=>{
      const current=await this.currentWithin(db,q.bindingId);rule(current.row.subject_id===actor.subjectId,'ci_request_unavailable',404);
      const expected=this.proofPayload(q.id,q.preparedAt,current);rule(JSON.stringify(expected)===payloadJson,'ci_proof_preview_changed');
      const grant=await this.consents.require(db,{id:consentId,subjectId:actor.subjectId,action:'proof.publish',objectId:q.id,recipient:this.endpoint,payloadJson});
      rule(!grant.currentVisibility?.deletionPending,'ci_source_unavailable');
      const prior=await one(db,'SELECT * FROM ci_proofs_v2 WHERE id=$1 FOR SHARE',[q.id]);
      if(prior){rule(prior.subject_id===actor.subjectId&&prior.consent_id===consentId&&prior.payload_hash===digest(payloadJson)&&!prior.revoked_at,'ci_proof_conflict');return{proofId:q.id,signed:prior.signed};}
      rule(this.sign,'ci_signer_unavailable',503);const signed=await this.sign('proof',expected,q.id,q.expiresAt-this.now());
      await db.query(`INSERT INTO ci_proofs_v2(id,subject_id,request_id,observation_id,consent_id,payload_text,payload_hash,signed)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[q.id,actor.subjectId,q.bindingId,q.observationId,consentId,payloadJson,digest(payloadJson),signed]);
      const saved=await one(db,'SELECT * FROM ci_proofs_v2 WHERE id=$1 FOR SHARE',[q.id]);rule(saved.payload_hash===digest(payloadJson)&&saved.subject_id===actor.subjectId&&saved.consent_id===consentId&&!saved.revoked_at,'ci_proof_conflict');
      await this.audit(db,actor,q.id,consentId,'ci.proof.publish','proof',a);return{proofId:q.id,signed:saved.signed,...flags};
    });
  }
  async proofWithin(db,actor,id){
    const row=await one(db,'SELECT * FROM ci_proofs_v2 WHERE id=$1',[id]);rule(row&&!row.revoked_at&&row.payload_text,'ci_proof_unavailable',404);
    const current=await this.currentWithin(db,row.request_id);rule(current.observation.id===row.observation_id,'ci_proof_unavailable');
    const grant=await this.consents.require(db,{id:row.consent_id,subjectId:row.subject_id,action:'proof.publish',objectId:id,recipient:this.endpoint,payloadJson:row.payload_text});
    rule(!grant.currentVisibility?.deletionPending&&canReadProjection(grant,{viewerId:actor?.subjectId??null,projection:'proof',hubEndpoint:this.endpoint,now:this.now()}),'ci_proof_unavailable',404);
    const locked=await one(db,'SELECT revoked_at FROM ci_proofs_v2 WHERE id=$1 FOR SHARE',[id]);rule(locked&&!locked.revoked_at,'ci_proof_unavailable',404);
    if (!this.verifyEnvelope) throw new ServiceError('ci_proof_verifier_unavailable',503);
    const envelope=await this.verifyEnvelope(row.signed,{type:'proof',issuer:this.endpoint,audience:this.endpoint,trustedKeys:this.trustedKeys,now:this.now(),maxAge:86400});
    rule(digest(row.payload_text)===row.payload_hash&&JSON.stringify(envelope.data)===row.payload_text,'ci_proof_integrity_mismatch',500);
    return{proofId:id,status:'active',signed:row.signed,data:envelope.data,provenance:describeCiProofV2(envelope.data),...flags};
  }
  getProof(actor,input){const{id}=parse(ciIdSchema,input,'invalid_ci_id');const read=db=>this.proofWithin(db,actor,id);
    return actor?this.access.runAuthorized(actor,'proof',read):transaction(this.db,read);}
  async proofsForWithin(db,actor,{subjectId,caseId,resultRef,evidenceRefs,policy=null}){
    const allowed=new Set(evidenceRefs.map(r=>`${r.id}:${r.version}`)),items=[];let after=null;
    for(;;){const rows=(await db.query(`SELECT p.id,r.evidence_id,r.evidence_version FROM ci_proofs_v2 p JOIN ci_requests_v2 r ON r.id=p.request_id
      WHERE p.subject_id=$1 AND r.subject_id=$1 AND r.case_id=$2 AND r.result_id=$3 AND r.result_version=$4
      AND ($5::uuid IS NULL OR p.id>$5) ORDER BY p.id LIMIT 100`,[subjectId,caseId,resultRef.id,resultRef.version,after])).rows;
      for(const row of rows){if(!allowed.has(`${row.evidence_id}:${row.evidence_version}`))continue;
        try{const view=await this.proofWithin(db,actor,row.id),d=view.data;
          if(policy&&!policy.repositories.some(r=>r.owner.toLowerCase()===d.source.owner.toLowerCase()&&r.repository.toLowerCase()===d.source.repository.toLowerCase()))continue;
          items.push({proofId:row.id,sourceKey:view.provenance.sourceKey,commit:d.source.commit,conclusion:d.conclusion,
            statusUrl:`${this.endpoint}${d.statusPath}`,synthetic:d.synthetic,independentExecutionVerified:false});
        }catch(e){if(!(e instanceof ServiceError))throw e;}}
      if(rows.length<100)break;after=rows.at(-1).id;
    }return items;
  }
  async revokeProof(actor,input){const{id}=parse(ciIdSchema,input,'invalid_ci_id');return this.access.runResourceWrite(actor,'proof',{control:true},async(db,a)=>{
    const row=await one(db,'SELECT * FROM ci_proofs_v2 WHERE id=$1 AND subject_id=$2 FOR UPDATE',[id,actor.subjectId]);rule(row,'ci_proof_unavailable',404);
    await db.query('UPDATE ci_proofs_v2 SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1',[id,iso(this.now())]);
    await this.audit(db,actor,id,row.consent_id,'ci.proof.revoke','proof',a);return{proofId:id,status:'revoked',...flags};
  });}
}
