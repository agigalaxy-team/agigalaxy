import { honorRuleSchema, honorQuerySchema, honorRankingSchema,honorRuleHistorySchema } from './shared/honor-schema.mjs';
import { readAssistanceReviewEvents,projectAssistanceReview } from './domain/assistance-case-review.mjs';
import { canReadProjection } from './domain/consent-policy.mjs';
import { transaction } from './database.mjs';
import { digest } from './shared/digest.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { assessContributionRisk, contributionProofs } from './domain/contribution-risk.mjs';
import { currentHonorRegistry,registryRule } from './infrastructure/honor-rule-registry.mjs';
import { honorCandidates,honorProofRecords } from './infrastructure/honor-source-pages.mjs';
import { paginateHonor } from './domain/honor-pagination.mjs';
const evidenceKinds = new Set(['confirm','change-scope','confirm-scope','deliver','accept','cancel','dispute','propose-resolution','confirm-resolution']);
// Honor is an on-demand projection, never an editable badge or reward ledger.
export class HonorService {
  constructor(access, assistance, proofs, rules=[]) {
    Object.assign(this,{access,assistance,proofs});this.rules=new Map();
    for(const input of rules){const rule=honorRuleSchema.parse(input),key=`${rule.id}@${rule.version}`;
      if(this.rules.has(key))throw new Error('Duplicate Honor rule');this.rules.set(key,structuredClone(rule));}
  }
  rule(id,version){const rule=this.rules.get(`${id}@${version}`);if(!rule)throw new ServiceError('honor_rule_unavailable',404);return rule;}
  async useRegistry(){await currentHonorRegistry(this.access.db,this.access.endpoint);this.registryEnabled=true;}
  async selectRule(db,id,version,state){return this.registryEnabled?registryRule(db,this.access.endpoint,id,version,state??await currentHonorRegistry(db,this.access.endpoint)):
    {rule:this.rule(id,version),configured:true,registry:null};}
  publicRule(rule){const {members:_members,relatedPartyGroups:_groups,...publicRule}=rule;
    return {...publicRule,issuer:this.access.endpoint,...(rule.sourceProfile==='facts-v2'?{requiredApiVersion:2}:{}),method:rule.sourceProfile==='facts-v2'?'facts-v2 sources; use /v2/honor':'distinct accepted source Cases; distinct numeric CI repository/run/attempt sources, conflicts excluded',
      independence:'Related parties are issuer-declared; other relationships are unverified.',capabilityVerified:false};}
  async list(){
    if(!this.registryEnabled)return {issuer:this.access.endpoint,rules:[...this.rules.values()].map(rule=>this.publicRule(rule)),checkedAt:this.access.now(),ruleHistorySupported:false};
    return transaction(this.access.db,async db=>{const state=await currentHonorRegistry(db,this.access.endpoint),rules=[];
      for(const ref of state.rules){const entry=await this.selectRule(db,ref.ruleId,ref.ruleVersion,state);rules.push({...this.publicRule(entry.rule),registry:entry.registry});}
      return {issuer:this.access.endpoint,rules,checkedAt:this.access.now(),ruleHistorySupported:true,configurationEventId:state.configurationEventId};});
  }
  async ruleHistory(input={}){
    const parsed=honorRuleHistorySchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_honor_history_query');
    if(!this.registryEnabled)throw new ServiceError('honor_registry_unavailable',503);
    const query=parsed.data;
    return transaction(this.access.db,async db=>{
      const state=await currentHonorRegistry(db,this.access.endpoint);
      const rows=(await db.query(`SELECT v.* FROM honor_rule_versions v JOIN runtime_config_events c ON c.id=v.introduced_config_id
        WHERE v.endpoint=$1 AND v.sequence>$2 AND ($3::text IS NULL OR v.rule_id=$3) AND c.sequence<=$4 ORDER BY v.sequence LIMIT $5`,
        [this.access.endpoint,query.after,query.ruleId??null,state.sequence,query.limit+1])).rows;
      const items=[];
      for(const row of rows.slice(0,query.limit)){const selected=await registryRule(db,this.access.endpoint,row.rule_id,row.rule_version,state,row);
        items.push({sequence:Number(row.sequence),rule:this.publicRule(selected.rule),registry:selected.registry});}
      return {issuer:this.access.endpoint,items,nextAfter:rows.length>query.limit?items.at(-1).sequence:null,
        configurationEventId:state.configurationEventId,checkedAt:this.access.now(),capabilityVerified:false};
    });
  }
  visible(grant,actor){return canReadProjection(grant,{viewerId:actor?.subjectId??null,projection:'history',now:this.access.now()});}
  async sources(db,actor,subjectId,rule,{network=false,withProofs=!network,cache=new Map()}={}){
    const viewer=actor?.subjectId??null;
    const contributions=[];
    for await(const candidate of honorCandidates(db,{providers:network?rule.members:[subjectId],capabilityId:rule.capabilityId,members:rule.members,viewer})) {
      if(cache.has(candidate.id)){const cached=cache.get(candidate.id);if(cached)contributions.push(cached);continue;}
      cache.set(candidate.id,null);
      try {
        const {row,grants,paused}=await this.assistance.load(db,candidate.id,{readOnly:true}),state=row.snapshot,providerId=state.selected.providerId;
        if(!this.visible(grants.get(row.id),actor))continue;
        const work=state.events.filter(item=>evidenceKinds.has(item.event.kind));
        const confirmation=work.find(item=>item.event.kind==='confirm'&&item.actorId===providerId);
        if(!confirmation || !work.every(item=>this.visible(grants.get(item.event.id),actor)))continue;
        // A window is based on first participation, avoiding duplicate award windows after reopenings.
        if(confirmation.at<rule.windowFrom || confirmation.at>=rule.windowUntil)continue;
        const revisions=await readAssistanceReviewEvents(db,{caseId:row.case_id,viewerId:viewer,consents:this.assistance.consents,endpoint:this.access.endpoint,now:this.access.now()});
        const {textCorrections,corrected,correctionPending,disputed,acceptance,accepted}=projectAssistanceReview(revisions,state);
        const related=rule.relatedPartyGroups.some(group=>group.includes(providerId)&&group.includes(row.requester_id));
        const valid=accepted&&!paused&&!correctionPending&&!disputed;
        const correctionReview={version:1,state:!corrected?'not-required':correctionPending?'new-delivery-required':accepted?'participant-reaccepted':'awaiting-requester-acceptance',
          deliveredCaseReviewVersion:state.delivery?.caseReviewVersion??null,latestTextCorrectionVersion:textCorrections.at(-1)?.version??null,
          deliveryEventId:state.delivery?.id??null,acceptanceEventId:acceptance?.event.id??null,
          authority:'provider-versioned-delivery-and-requester-acceptance',independenceVerified:false,capabilityVerified:false};
        const linked=[],observations=[];
        if(withProofs && state.delivery?.evidenceIds.length) {
          for await(const proof of honorProofRecords(db,state.delivery.evidenceIds)) {
            try {const view=await this.proofs.readWithin(db,actor,proof.id);const payload=JSON.parse(proof.payload_text);
              if(payload.observedAt<rule.windowFrom || payload.observedAt>=rule.windowUntil
                || !rule.repositories.some(repo=>repo.owner.toLowerCase()===payload.source.owner.toLowerCase()&&repo.repository.toLowerCase()===payload.source.repository.toLowerCase()))continue;
              const observation={proofId:proof.id,evidenceId:proof.evidence_id,sourceKey:view.provenance.sourceKey,
                commit:payload.source.commit,conclusion:payload.conclusion,strength:'ci-execution-fact',
                independence:payload.independence,attribution:payload.attribution,
                independentExecutionVerified:false,capabilityVerified:false};
              observations.push(observation);
              if(valid&&payload.conclusion==='success')linked.push(observation);
            } catch(error){if(!(error instanceof ServiceError))throw error;}
          }
        }
        const contribution={assistanceId:row.id,caseId:row.case_id,subjectId:providerId,requesterId:row.requester_id,capabilityId:rule.capabilityId,
          collaboration:state.request.collaboration,participatedAt:confirmation.at,state:state.state,paused,corrected,correctionPending,correctionReview,disputed,
          accepted,eligible:valid,independence:related?'issuer-declared-related-party':'unverified-relationship',
          sourceEvents:work.map(item=>({eventId:item.event.id,kind:item.event.kind,actorId:item.actorId,at:item.at,
            ...(item.event.caseReviewVersion!==undefined?{caseReviewVersion:item.event.caseReviewVersion}:{}),...(item.event.outcome?{outcome:item.event.outcome}:{})})),
          revisionIds:revisions.map(r=>r.id),proofs:linked,observations,authority:'participant-reported collaboration; CI retains its limited scope',capabilityVerified:false};
        cache.set(candidate.id,contribution);contributions.push(contribution);
      } catch(error){if(!(error instanceof ServiceError))throw error;}
    }
    return {contributions,complete:true};
  }
  async project(db,actor,input,{includeRisk=true,registryState,sourceResult,selectedRule}={}){
    const query=honorQuerySchema.parse(input),selected=selectedRule??await this.selectRule(db,query.ruleId,query.ruleVersion,registryState),rule=selected.rule,now=this.access.now(),cache=new Map();
    if(rule.sourceProfile==='facts-v2')throw new ServiceError('unsupported_semantics',409);
    if(!rule.members.includes(query.subjectId))throw new ServiceError('honor_subject_outside_scope',404);
    const {contributions,complete}=sourceResult??await this.sources(db,actor,query.subjectId,rule,{cache});
    const eligible=contributions.filter(item=>item.eligible&&(rule.kind!=='open-contributor'||item.collaboration==='open-assistance'));
    const caseIds=[...new Set(eligible.map(item=>item.caseId))].sort((a,b)=>a.localeCompare(b));
    const proofs=contributionProofs(eligible);
    const active=selected.configured&&now>=rule.notBefore&&now<rule.notAfter&&!rule.revoked;
    const status=!active?'inactive-rule':!complete?'incomplete-source-scan':caseIds.length>=rule.minAcceptedCases&&proofs.length>=rule.minProofs?'active':'insufficient-evidence';
    const card={id:digest(JSON.stringify([this.access.endpoint,query.subjectId,rule.id,rule.version])),subjectId:query.subjectId,
      issuer:this.access.endpoint,rule:this.publicRule(rule),ruleHash:digest(JSON.stringify(rule)),projectionRule:{id:'honor-contribution',version:2},status,...(selected.registry?{registry:selected.registry}:{}),
      evidence:eligible.map(item=>({assistanceId:item.assistanceId,caseId:item.caseId,sourceEventIds:item.sourceEvents.map(e=>e.eventId),independence:item.independence})),proofs,
      acceptedCases:caseIds.length,checkedAt:now,cacheable:false,capabilityVerified:false,
      statusUrl:`${this.access.endpoint}/v1/honor/${query.subjectId}/${rule.id}/${rule.version}`,
      freshness:'Read statusUrl with current source authorization. A screenshot is not current evidence.',
      sharing:'Source visibility applies to every viewer; this card does not grant access.'};
    const network=includeRisk&&contributions.length?await this.sources(db,actor,query.subjectId,rule,{network:true,cache}):{contributions:[],complete};
    const riskAssessment=includeRisk?assessContributionRisk(contributions,{complete,checkedAt:now,subjectId:query.subjectId,network}):null;
    card.sourceFingerprint=digest(JSON.stringify({projectionRule:card.projectionRule,ruleHash:card.ruleHash,contributions,status,riskFlags:riskAssessment?.flags??null}));
    return {card,contributions,complete,riskAssessment,facets:{
      contribution:{acceptedCases:caseIds.length,relatedPartyCases:new Set(eligible.filter(c=>c.independence==='issuer-declared-related-party').map(c=>c.caseId)).size},
      capabilityEvidence:{proofCount:proofs.length,strength:'ci-execution-fact',capabilityVerified:false},
      collaborationReliability:{accepted:contributions.filter(c=>c.accepted).length,canceled:contributions.filter(c=>c.state==='canceled').length,
        disputed:contributions.filter(c=>c.disputed).length,paused:contributions.filter(c=>c.paused).length,coverage:'visible collaborations in the configured capability/community/window; not global reliability'},
      requesterReputation:{method:'separate participant-reported requester history',path:'/v1/requester-history/query'}},globalScore:null};
  }
  query(actor,input){const parsed=honorQuerySchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_honor_query');
    const read=async db=>paginateHonor(await this.project(db,actor,parsed.data),parsed.data);
    return this.retrySnapshot(()=>actor?this.access.runAuthorized(actor,'history',read,{isolation:'repeatable read'}):transaction(this.access.db,read,{isolation:'repeatable read'}));}
  async retrySnapshot(read){for(let attempt=0;;attempt++)try{return await read();}catch(error){
    if(error.code!=='40001')throw error;if(attempt>=1)throw new ServiceError('honor_sources_changed_retry',409);
  }}
  async ranking(input){const parsed=honorRankingSchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_honor_ranking');
    return this.retrySnapshot(()=>transaction(this.access.db,async db=>{
    const registryState=this.registryEnabled?await currentHonorRegistry(db,this.access.endpoint):undefined;
    const selected=await this.selectRule(db,parsed.data.ruleId,parsed.data.ruleVersion,registryState),rule=selected.rule,now=this.access.now();
    if(rule.sourceProfile==='facts-v2')throw new ServiceError('unsupported_semantics',409);
    const base={issuer:this.access.endpoint,rule:this.publicRule(rule),projectionRule:{id:'honor-contribution',version:2},checkedAt:now,cacheable:false,capabilityVerified:false,
      qualificationGranted:false,benchmarkConclusion:null,method:'public-source distinct accepted Cases, scoped cohort only; ties share rank'};
    if(!rule.rankingEnabled || rule.privacyReview!=='approved')return {...base,status:'suppressed',reason:'ranking-not-approved',items:[]};
    if(!selected.configured||rule.revoked||now<rule.notBefore||now>=rule.notAfter||now<rule.windowUntil)return {...base,status:'suppressed',reason:'rule-inactive-or-window-open',items:[]};
      const entries=[];
      const all=await this.sources(db,null,null,rule,{network:true,withProofs:true});
      const grouped=new Map();for(const contribution of all.contributions){if(!grouped.has(contribution.subjectId))grouped.set(contribution.subjectId,[]);grouped.get(contribution.subjectId).push(contribution);}
      for(const subjectId of [...rule.members].sort((a,b)=>a.localeCompare(b))){const view=await this.project(db,null,{ruleId:rule.id,ruleVersion:rule.version,subjectId},{includeRisk:false,registryState,selectedRule:selected,sourceResult:{contributions:grouped.get(subjectId)??[],complete:all.complete}});
        if(!view.complete)return {...base,status:'suppressed',reason:'incomplete-source-scan',items:[]};
        if(view.card.status==='active'&&view.card.acceptedCases>=rule.minimumCasesPerMember)entries.push({subjectId,acceptedCases:view.card.acceptedCases,
          relatedPartyCases:view.facets.contribution.relatedPartyCases,statusUrl:view.card.statusUrl});}
      if(entries.length<rule.minimumCohort)return {...base,status:'suppressed',reason:'insufficient-public-cohort',items:[]};
      entries.sort((a,b)=>b.acceptedCases-a.acceptedCases||a.subjectId.localeCompare(b.subjectId));
      let rank=0;const items=entries.map((entry,i)=>{if(i===0||entry.acceptedCases!==entries[i-1].acceptedCases)rank=i+1;return {...entry,rank};});
      return {...base,status:'published',items,statistics:{cohort:items.length,acceptedCases:items.reduce((sum,item)=>sum+item.acceptedCases,0),
        population:'policy-eligible publicly visible cohort',industryComparison:false}};
    },{isolation:'repeatable read'}));
  }
}
