import {verificationEventSchema,evidenceStatusQuerySchema,evidenceVersionRef,
  verificationOperationReceiptQuerySchema,verificationOperationReceiptResultSchema} from './shared/verification-record-schema.mjs';
import {verificationRecordRepository} from './infrastructure/verification-record-repository.mjs';
import {caseRepository} from './infrastructure/case-repository.mjs';
import {projectCaseFacts,latestFact,publicFactView} from './domain/intervention.mjs';
import {canReadProjection} from './domain/consent-policy.mjs';
import {digest} from './shared/digest.mjs';
import {ServiceError} from './shared/service-error.mjs';

const rule=(ok,code,status=409)=>{if(!ok)throw new ServiceError(code,status);};
const feedbackMethods=new Set(['participant-feedback','requester-acceptance']);
const sourceKey=source=>`declared-source:${digest(JSON.stringify([source.originSystem,source.externalStableId]))}`;

// These records attest to a current authorized subject's report. The data API
// does not execute user projects, infer external ownership, or certify experts.
export class VerificationRecordService {
  constructor(access,consents,{cases,tasks,proofs,lockCaseRead,lockRecordRead}={}){
    this.access=access;this.consents=consents;this.cases=cases;this.tasks=tasks;this.proofs=proofs;
    this.endpoint=access.endpoint;this.now=access.now;
    this.lockCaseRead=lockCaseRead;this.lockRecordRead=lockRecordRead;
  }
  parse(request){try{
    if(typeof request?.payloadJson!=='string'||Buffer.byteLength(request.payloadJson)>24000)throw new Error();
    return verificationEventSchema.parse(JSON.parse(request.payloadJson));
  }catch{throw new ServiceError('invalid_verification_record');}}

  async caseWithin(db,caseId){
    const repo=caseRepository(db),parent=await (this.lockCaseRead?this.lockCaseRead(db,caseId):repo.lockAnyForRead(caseId));
    rule(parent,'case_unavailable',404);
    const rows=await repo.events(caseId);
    return {parent,rows,facts:projectCaseFacts(rows,parent)};
  }

  async writeContextWithin(db,actor,data){
    let task=null,p=null;
    // Same lock order as Task/Case writes. A past participant can still revoke
    // or correct their own record, subject to access to the referenced material.
    if(data.taskId&&data.kind!=='revoke'){rule(this.tasks,'task_service_unavailable',503);
      task=await this.tasks.requireTaskWithin(db,actor,data.taskId,{write:true});
      rule(task.caseId===data.caseId,'task_case_link_required');}
    const context=await this.caseWithin(db,data.caseId),owner=context.parent.subject_id===actor.subjectId;
    if(data.kind!=='revoke')rule(context.parent.state!=='withdrawn','case_unavailable');
    if(data.kind!=='revoke'&&(!owner||data.participationId)){
      rule(data.taskId&&data.participationId&&this.tasks,'participation_required',403);
      p=await this.tasks.requireParticipationWithin(db,actor,{taskId:data.taskId,participationId:data.participationId});
      rule(p.subjectId===actor.subjectId,'participation_required',403);
      if(data.expectedVersion===0){
        rule(!p.paused&&!['closed','canceled'].includes(p.taskState),'participation_paused',403);
        rule(['active','delivered','accepted','disputed'].includes(p.state),'participation_required',403);
        rule(p.scopeVersion===(data.participationScopeVersion??1),'participation_scope_changed');
      }
    }
    if(context.facts.synthetic===true)rule(data.synthetic,'synthetic_mismatch',422);
    return {...context,task,p,owner};
  }

  async targetWithin(db,actor,target,{caseId,scopeVersion,latest=false,visited=new Set()}={}){
    rule(this.cases,'case_service_unavailable',503);
    const context=await this.caseWithin(db,caseId);
    rule(context.parent.state!=='withdrawn','case_unavailable');
    const current=latestFact(context.facts,target.type,target.id);
    rule(current,'target_not_found',422);
    if(latest)rule(current.version===target.version,'target_version_changed');
    const fact=await this.cases.requireFactWithin(db,actor,context.rows,context.facts,target.type,target,{visited});
    if(scopeVersion!==undefined)rule(fact.scopeVersion===scopeVersion,'target_scope_changed');
    return {fact,currentVersion:current.version,requesterId:context.parent.subject_id};
  }

  async submit(actor,request){
    const data=this.parse(request);rule(data.reportedBy===actor.subjectId,'reporter_mismatch',403);
    return this.access.runResourceWrite(actor,'evidence',{control:data.kind==='revoke'},async(db,authorization)=>{
      const context=await this.writeContextWithin(db,actor,data),repo=verificationRecordRepository(db);
      const type=data.kind==='revoke'?data.objectType:data.kind,hash=digest(request.payloadJson);
      await this.consents.require(db,{id:request.consentId,subjectId:actor.subjectId,action:'evidence.submit',
        objectId:data.operationId,recipient:this.endpoint,payloadJson:request.payloadJson});
      if(data.expectedVersion===0&&data.kind!=='revoke')await repo.ensure(data,type,actor.subjectId);
      const object=await repo.object(data.id,true);
      rule(object&&object.subject_id===actor.subjectId&&object.case_id===data.caseId&&object.object_type===type,'record_not_found',404);
      const duplicate=await repo.operation(data.operationId);
      if(duplicate){rule(duplicate.object_id===data.id&&duplicate.payload_hash===hash&&duplicate.consent_id===request.consentId,'record_conflict');
        const receipt=this.receiptView(object,duplicate);
        if(duplicate.payload.kind==='verification'){
          const current=await this.readWithin(db,actor,{type,id:data.id,version:duplicate.version});
          // Ordinary replay still requires current sources. It is not a minimal
          // historical receipt endpoint and cannot restore revoked access.
          rule(current.record!==null,current.reason??'evidence_reference_unavailable');
          receipt.synthetic=current.synthetic;
        }
        return receipt;}
      rule(object.version===data.expectedVersion,'record_version_changed');
      rule(object.state==='active','record_revoked');
      if(object.version>0)rule(data.reason,'correction_reason_required',422);
      const previous=object.version?await repo.event(data.id,object.version):null;
      if(previous?.context.synthetic)rule(data.synthetic,'synthetic_mismatch',422);
      if(previous?.payload.kind==='verification'&&data.kind==='verification'&&!data.synthetic){
        const prior=await this.readWithin(db,actor,{type,id:data.id,version:previous.version});
        // A false stored legacy projection does not prove a non-synthetic
        // history. With unavailable sources no downgrade can be established;
        // an explicit true correction can still replace those old sources.
        rule(prior.record!==null,prior.reason??'evidence_reference_unavailable');
        rule(prior.synthetic!==true,'synthetic_mismatch',422);
      }
      if(previous&&data.kind!=='revoke'){
        rule((previous.payload.taskId??null)===(data.taskId??null)&&(previous.payload.participationId??null)===(data.participationId??null),
          'record_context_changed');
        if(type==='evidence')rule(sourceKey(previous.payload.source)===sourceKey(data.source),'source_identity_changed');
        if(type==='verification')rule(previous.payload.target.type===data.target.type&&previous.payload.target.id===data.target.id,'verification_target_changed');
      }
      let derived={recordedAt:new Date(this.now()*1000).toISOString(),synthetic:data.synthetic||context.facts.synthetic===true,
        claimAuthority:'authenticated-subject-report',independentExecutionVerified:false,capabilityVerified:false};
      if(data.kind!=='revoke'){
        rule(Date.parse(data.observedAt)<=this.now()*1000,'future_observation',422);
        if(data.expiresAt)rule(Date.parse(data.expiresAt)>Date.parse(data.observedAt),'invalid_expiry',422);
      }
      if(data.kind==='evidence'){
        rule(Date.parse(data.source.originalAt)<=Date.parse(data.observedAt),'source_time_mismatch',422);
        derived={...derived,sourceKey:sourceKey(data.source),sourceStrength:'submitter-reported-reference',sourceIdentityVerified:false,
          importedAt:derived.recordedAt,currentSourceState:'not-checked',externalRevocation:'unknown'};
      }
      if(data.kind==='verification'){
        const {fact,requesterId}=await this.targetWithin(db,actor,data.target,{caseId:data.caseId,scopeVersion:data.scopeVersion,latest:true});
        rule(!data.taskId||fact.taskId===data.taskId,'target_task_mismatch',422);
        const feedback=feedbackMethods.has(data.method);
        if(data.method==='requester-acceptance')rule(actor.subjectId===requesterId,'requester_required',403);
        rule(feedback?['accepted','partially-accepted','rejected','comment','inconclusive'].includes(data.observation)
          :['passed','failed','inconclusive'].includes(data.observation),'observation_method_mismatch',422);
        if(!feedback)rule(data.evidenceRefs.length>0,'supporting_evidence_required',422);
        let sourceSynthetic=fact.synthetic===true;
        for(const ref of data.evidenceRefs){
          const source=await this.requireReferenceWithin(db,actor,{kind:'evidence',...ref},{caseId:data.caseId});
          sourceSynthetic ||= source.synthetic===true;
        }
        derived={...derived,synthetic:derived.synthetic||sourceSynthetic,
          sourceStrength:feedback?'participant-feedback':data.method==='local-test'||data.method.endsWith('-test')
          ?'user-side-test-report':'user-side-scoped-report',
          recordedRelationship:fact.actorId===actor.subjectId?'self':requesterId===actor.subjectId?'requester':'task-participant',
          declaredRelationship:data.relationship,relationshipIndependentlyVerified:false,targetAuthor:fact.actorId,
          scope:'declared-scope-only',taskOutcomeVerified:false};
      }
      await repo.append(data,request.consentId,request.payloadJson,hash,derived);
      await repo.dependencies(data);await repo.audit(actor,data,request.consentId,authorization);
      return this.receiptView({...object,version:data.expectedVersion+1,state:data.kind==='revoke'?'revoked':'active'},
        {version:data.expectedVersion+1,payload:data,context:derived});
    });
  }

  receiptView(object,event){return {id:object.id,type:object.object_type,version:event.version,operationId:event.payload.operationId,
    state:event.payload.kind==='revoke'?'revoked':'recorded',currentVersion:object.version,currentState:object.state,
    sourceStrength:event.context.sourceStrength??null,independentExecutionVerified:false,capabilityVerified:false,
    taskOutcomeVerified:false,synthetic:event.context.synthetic};}

  async visibleWithin(db,actor,object,event){
    rule(digest(event.payload_text)===event.payload_hash,'stored_integrity_mismatch',500);
    const intent=await this.consents.require(db,{id:event.consent_id,subjectId:object.subject_id,action:'evidence.submit',
      objectId:event.operation_id,recipient:this.endpoint,payloadJson:event.payload_text});
    rule(canReadProjection(intent,{viewerId:actor.subjectId,now:this.now(),hubEndpoint:this.endpoint}),'record_not_authorized',403);
  }

  async requireReferenceWithin(db,actor,ref,{caseId,scopeVersion,visited=new Set()}={}){
    const kind=ref.kind??'verification';
    rule(['evidence','verification'].includes(kind),'source_adapter_unavailable',503);
    const repo=verificationRecordRepository(db),peek=await repo.peek(ref.id);
    rule(peek,'evidence_reference_unavailable',404);
    const context=await this.caseWithin(db,peek.case_id);
    const object=await (this.lockRecordRead?this.lockRecordRead(db,ref.id):repo.object(ref.id));
    rule(object&&object.object_type===kind,'evidence_reference_unavailable',404);
    // Old M11 UUID references mean first generation only. Never retarget an
    // accepted delivery silently to a later correction of the same object.
    const version=ref.version??1;
    rule(evidenceVersionRef.safeParse({id:ref.id,version}).success,'invalid_evidence_reference',422);
    const event=await repo.event(ref.id,version);
    const visibilityEvent=event??await repo.event(ref.id,object.version);
    rule(visibilityEvent,'evidence_reference_unavailable',404);
    await this.visibleWithin(db,actor,object,visibilityEvent);
    rule(!caseId||caseId===object.case_id,'evidence_case_mismatch',422);
    rule(object.state==='active','evidence_revoked');
    rule(object.version===version,'evidence_version_changed');
    rule(event,'evidence_reference_unavailable',404);
    rule(context.parent.state!=='withdrawn','case_unavailable');
    rule(!event.payload.expiresAt||Date.parse(event.payload.expiresAt)>this.now()*1000,'evidence_expired');
    const key=`${kind}:${ref.id}:${version}`;rule(!visited.has(key),'circular_evidence_reference',422);visited.add(key);
    try{
      let sourceSynthetic=context.facts.synthetic===true;
      if(kind==='verification'){
        const target=await this.targetWithin(db,actor,event.payload.target,{caseId:object.case_id,scopeVersion:scopeVersion??event.payload.scopeVersion,latest:true,visited});
        sourceSynthetic ||= target.fact.synthetic===true;
        for(const evidence of event.payload.evidenceRefs){
          const source=await this.requireReferenceWithin(db,actor,{kind:'evidence',...evidence},{caseId:object.case_id,visited});
          sourceSynthetic ||= source.synthetic===true;
        }
      }
      return this.view(object,event,sourceSynthetic);
    }finally{visited.delete(key);}
  }

  view(object,event,sourceSynthetic=false){
    // The signed payload remains the subject's declaration. Effective source
    // provenance is rebuilt under current permission, including legacy rows
    // whose stored projection did not propagate an Evidence marker.
    const context={...event.context,synthetic:event.context.synthetic===true||event.payload.synthetic===true||sourceSynthetic};
    return {...this.receiptView(object,{...event,context}),record:publicFactView(event.payload),provenance:context,
    integrity:'payload-hash-matches-storage',authorization:'current',externalOwnershipVerified:false,
    availability:{record:'available',upstream:'not-checked',upstreamRevocation:'unknown'},revocation:object.state==='revoked'?'revoked':'not-revoked'};}

  async readWithin(db,actor,{type,id,version}){
    rule(['evidence','verification'].includes(type),'invalid_record_type',422);
    const repo=verificationRecordRepository(db),peek=await repo.peek(id);
    rule(peek,'record_not_found',404);
    const context=await this.caseWithin(db,peek.case_id),object=await repo.object(id);
    rule(object&&object.object_type===type,'record_not_found',404);
    const selected=version??object.version,event=await repo.event(id,selected);rule(event,'record_not_found',404);
    await this.visibleWithin(db,actor,object,event);
    rule(context.parent.state!=='withdrawn','case_unavailable');
    // Historical reports remain accessible under their own live consent. Their
    // status is not upgraded to the current version or source state.
    const view=this.view(object,event,context.facts.synthetic===true);
    if(object.state==='revoked'&&actor.subjectId!==object.subject_id)return {id,type,version:selected,currentVersion:object.version,
      referenceStatus:'revoked',record:null,capabilityVerified:false,taskOutcomeVerified:false};
    view.current=object.state==='active'&&object.version===selected;
    view.referenceStatus=object.state==='revoked'?'revoked':object.version!==selected?'superseded':'current';
    if(event.payload.expiresAt&&Date.parse(event.payload.expiresAt)<=this.now()*1000){view.referenceStatus='expired';view.current=false;}
    if(type==='verification'&&event.payload.kind!=='revoke'){
      try{
        const target=await this.targetWithin(db,actor,event.payload.target,{caseId:object.case_id,scopeVersion:event.payload.scopeVersion});
        let sourceSynthetic=target.fact.synthetic===true;
        for(const evidence of event.payload.evidenceRefs){
          const source=await this.requireReferenceWithin(db,actor,{kind:'evidence',...evidence},{caseId:object.case_id});
          sourceSynthetic ||= source.synthetic===true;
        }
        view.synthetic ||= sourceSynthetic;
        view.provenance.synthetic=view.synthetic;
        view.targetCurrentVersion=target.currentVersion;
        if(target.currentVersion!==event.payload.target.version){view.referenceStatus='target-version-changed';view.current=false;}
      }catch(error){if(!(error instanceof ServiceError))throw error;
        // A dependent summary can expose a revoked/private source. Return only
        // the observer's tombstone and bounded state, never the derived text.
        return {id,type,version:selected,currentVersion:object.version,referenceStatus:'dependency-unavailable',reason:error.code,
          observedAt:event.context.recordedAt,capabilityVerified:false,taskOutcomeVerified:false,record:null};}
    }
    return view;
  }

  async get(actor,ref){
    try{evidenceStatusQuerySchema.parse({refs:[ref]});}catch{throw new ServiceError('invalid_record_reference');}
    return this.access.runAuthorized(actor,'evidence',db=>this.readWithin(db,actor,ref));
  }
  async receipt(actor,input){
    let query;try{query=verificationOperationReceiptQuerySchema.parse(input);}catch{throw new ServiceError('invalid_verification_receipt_query');}
    return this.access.runAuthorized(actor,'evidence',async db=>{
      // Do not load payload, old Consent, Case or dependencies. The owner was
      // established at the original accepted write. Historical acceptance is
      // not current material permission, verification validity or resolution.
      const row=(await db.query(`SELECT e.operation_id,e.object_id,e.version,e.payload_hash,e.created_at,o.object_type
        FROM verification_events e JOIN verification_objects o ON o.id=e.object_id
        WHERE e.operation_id=$1 AND o.subject_id=$2`,[query.operationId,actor.subjectId])).rows[0];
      const state=!row?'absent':row.object_id!==query.id||row.object_type!==query.type||row.payload_hash!==query.payloadHash
        ?'conflict':'acknowledged';
      const result={...query,state,authority:'accepted-operation-only',audience:'owner-only',
        currentAccessGranted:false,contentReturned:false,sourceAccessChecked:false};
      if(state==='acknowledged')result.receipt={...query,version:row.version,acceptedAt:new Date(row.created_at).toISOString()};
      else if(state==='absent')result.absenceMeaning='no-retained-owner-operation';
      else result.reason='original-operation-mismatch';
      return verificationOperationReceiptResultSchema.parse(result);
    });
  }
  async status(actor,request){
    let query;try{query=evidenceStatusQuerySchema.parse(request);}catch{throw new ServiceError('invalid_evidence_status_query');}
    return this.access.runAuthorized(actor,'evidence',async (db,authorization)=>{
      const items=[];
      for(const ref of query.refs){try{
        if(ref.type==='ci-proof-v2'){
          rule(authorization.credentialScopes.includes('proof'),'proof_scope_required',403);
          rule(this.ciV2,'proof_service_unavailable',503);
          const proof=await this.ciV2.proofWithin(db,actor,ref.id);
          items.push({...ref,profile:'ci-execution-observation/facts-v2',...proof,taskOutcomeVerified:false});
        }else if(ref.type==='proof'){
          rule(authorization.credentialScopes.includes('proof'),'proof_scope_required',403);
          rule(this.proofs,'proof_service_unavailable',503);
          const proof=await this.proofs.readWithin(db,actor,ref.id,true);
          items.push({...ref,profile:'ci-execution-observation',...proof,taskOutcomeVerified:false});
        }else items.push(await this.readWithin(db,actor,ref));
      }catch(error){if(!(error instanceof ServiceError))throw error;
        items.push({...ref,referenceStatus:'unavailable',reason:error.code,currentRevocation:'unknown',capabilityVerified:false,taskOutcomeVerified:false});}}
      const groups=new Map();let records=0;
      for(const item of items)if(item.type==='evidence'&&item.provenance?.sourceKey){records++;
        const key=item.provenance.sourceKey;if(!groups.has(key))groups.set(key,[]);groups.get(key).push({id:item.id,version:item.version,synthetic:item.synthetic});}
      return {items,checkedAt:new Date(this.now()*1000).toISOString(),coverage:'requested-visible-references',
        sourceSummary:{evidenceRecordCount:records,declaredSourceGroupCount:groups.size,duplicateRecordCount:records-groups.size,
          independentlyVerifiedSourceCount:0,globalCountProvided:false,groups:[...groups].map(([key,refs])=>({sourceKey:key,refs}))}};
    });
  }
}
