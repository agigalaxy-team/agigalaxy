import { qualificationPolicySchema, qualificationQuerySchema } from './shared/qualification-schema.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { readAssistanceReviewEvents,projectAssistanceReview } from './domain/assistance-case-review.mjs';
import { contributionProofs } from './domain/contribution-risk.mjs';
import { currentQualificationRegistry,qualificationDefinitionHash } from './infrastructure/qualification-policy-registry.mjs';
import { transaction } from './database.mjs';
export class QualificationService {
  constructor(access, proofs, assistance, policies = []) {
    this.access=access;this.proofs=proofs;this.assistance=assistance;
    this.policies=new Map();
    for(const input of policies){const policy=qualificationPolicySchema.parse(input);const key=`${policy.id}@${policy.version}`;
      if(this.policies.has(key))throw new Error('Duplicate qualification policy');this.policies.set(key,structuredClone(policy));}
  }
  policy(id,version,capabilityId,collaboration) {
    const policy=this.policies.get(`${id}@${version}`),now=this.access.now();
    if(!policy || policy.capabilityId!==capabilityId || collaboration && policy.collaboration!==collaboration
      || now<policy.notBefore || now>=policy.notAfter)throw new ServiceError('qualification_policy_unavailable',409);
    return policy;
  }
  async useRegistry(){await transaction(this.access.db,db=>currentQualificationRegistry(db,this.access.endpoint));this.registryEnabled=true;}
  async policyWithin(db,id,version,capabilityId,collaboration){
    const policy=this.policy(id,version,capabilityId,collaboration);
    if(this.registryEnabled){const registry=await currentQualificationRegistry(db,this.access.endpoint);
      if(!registry.policies.some(row=>row.policyId===id&&row.policyVersion===version&&row.definitionHash===qualificationDefinitionHash(policy)))
        throw new ServiceError('qualification_policy_unavailable',409);}
    return policy;
  }
  list(actor) {return this.access.runAuthorized(actor,'assistance',async db=>{
    const registry=this.registryEnabled?await currentQualificationRegistry(db,this.access.endpoint):null;
    return {issuer:this.access.endpoint,configurationEventId:registry?.configurationEventId??null,registeredPolicyVersions:Boolean(registry),policies:[...this.policies.values()]
      .filter(policy=>policy.notBefore<=this.access.now()&&policy.notAfter>this.access.now()
        &&(!registry||registry.policies.some(row=>row.policyId===policy.id&&row.policyVersion===policy.version&&row.definitionHash===qualificationDefinitionHash(policy))))
      .map(policy=>({...policy,definitionHash:qualificationDefinitionHash(policy),purpose:'participation-eligibility',capabilityVerified:false}))};
  });}
  async evaluateWithin(db,actor,input,collaboration) {
    const parsed=qualificationQuerySchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_qualification_query');
    const query=parsed.data,subjectId=query.subjectId??actor.subjectId,policy=await this.policyWithin(db,query.policyId,query.policyVersion,query.capabilityId,collaboration),now=this.access.now();
    const accepted=[],eligibleProofs=[],observations=[],unavailable=[];
    for(const id of [...query.evidence.assistanceIds].sort((a,b)=>a.localeCompare(b))) {
      try {
        const {row,grants,paused}=await this.assistance.load(db,id,{readOnly:true}),state=row.snapshot;
        if(paused || !this.assistance.visible(grants.get(id),actor.subjectId) || state.state!=='accepted' || state.selected?.providerId!==subjectId
          || state.request.capabilityId!==policy.capabilityId || state.createdAt<now-policy.historyWindowSeconds)continue;
        const revisions=await readAssistanceReviewEvents(db,{caseId:row.case_id,viewerId:actor.subjectId,consents:this.assistance.consents,endpoint:this.access.endpoint,now});
        const review=projectAssistanceReview(revisions,state),confirmation=state.events.find(item=>item.event.kind==='confirm'&&item.actorId===subjectId);
        if(!review.accepted||review.correctionPending||review.disputed||!confirmation
          ||![confirmation.event.id,state.delivery.id,review.acceptance.event.id].every(eventId=>this.assistance.visible(grants.get(eventId),actor.subjectId)))continue;
        accepted.push({assistanceId:id,caseId:state.request.caseId,evidenceIds:state.delivery?.evidenceIds??[],deliveryEventId:state.delivery.id,
          acceptanceEventId:review.acceptance.event.id,caseReviewVersion:state.delivery.caseReviewVersion??null});
      }catch(error){if(!(error instanceof ServiceError))throw error;unavailable.push({kind:'assistance',id});}
    }
    for(const id of query.evidence.proofIds) {
      try {
        const visible=await this.proofs.readWithin(db,actor,id);
        if(visible.caseContext?.status==='active-dispute')continue;
        const row=(await db.query('SELECT payload_text,subject_id,evidence_id FROM proofs WHERE id=$1',[id])).rows[0],payload=JSON.parse(row.payload_text);
        const held=(await db.query('SELECT m.id FROM moderation_reports m JOIN evidence_submissions e ON e.case_id=m.case_id WHERE e.id=$1 AND m.paused=true LIMIT 1',[row.evidence_id])).rows.length;
        if(held)continue;
        const revision=(await db.query("SELECT e.id FROM case_events e JOIN evidence_submissions v ON v.case_id=e.case_id WHERE v.id=$1 AND e.kind='revision' LIMIT 1",[row.evidence_id])).rows.length;
        if(revision&&!visible.caseContext)continue;
        if(payload.observedAt<now-policy.historyWindowSeconds
          || !policy.repositories.some(repo=>repo.owner.toLowerCase()===payload.source.owner.toLowerCase()&&repo.repository.toLowerCase()===payload.source.repository.toLowerCase())
          || row.subject_id!==subjectId&&!accepted.some(item=>item.evidenceIds.includes(row.evidence_id)))continue;
        const proof={proofId:id,evidenceId:row.evidence_id,sourceKey:visible.provenance.sourceKey,commit:payload.source.commit,conclusion:payload.conclusion,
          strength:'ci-execution-fact',attribution:payload.attribution};
        observations.push(proof);if(!policy.requireCiSuccess||payload.conclusion==='success')eligibleProofs.push(proof);
      }catch(error){if(!(error instanceof ServiceError))throw error;unavailable.push({kind:'proof',id});}
    }
    const proofs=contributionProofs([{proofs:eligibleProofs,observations}]),byCase=new Map();
    for(const item of accepted){
      if(!byCase.has(item.caseId))byCase.set(item.caseId,{...item,relatedAssistanceIds:[]});
      byCase.get(item.caseId).relatedAssistanceIds.push(item.assistanceId);
    }
    const acceptedCollaborations=[...byCase.values()].map(({evidenceIds:_evidenceIds,...item})=>item),reasons=[];
    if(proofs.length<policy.minProofs)reasons.push('insufficient-policy-matched-proof');
    if(acceptedCollaborations.length<policy.minAcceptedCollaborations)reasons.push('insufficient-related-accepted-history');
    return {subjectId,capabilityId:policy.capabilityId,policyId:policy.id,policyVersion:policy.version,issuer:this.access.endpoint,
      eligible:reasons.length===0,reasons,proofs,acceptedCollaborations,unavailable,
      evaluationRule:{id:'capability-participation',version:2,historyCounting:'distinct-case',proofCounting:'distinct-current-ci-source; conflicting-commit-or-conclusion-excluded'},
      policyDefinitionHash:qualificationDefinitionHash(policy),registeredPolicyVersion:Boolean(this.registryEnabled),
      evaluatedAt:now,cacheable:false,scope:'policy-specific-participation',capabilityVerified:false,
      limitations:['CI facts do not establish individual task quality.','Acceptance and capability association are participant-reported.','Recomputed on selection and provider confirmation.']};
  }
  evaluate(actor,input){return this.access.runAuthorized(actor,'assistance',db=>this.evaluateWithin(db,actor,input));}
}
