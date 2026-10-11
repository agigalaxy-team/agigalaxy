import {honorQueryV2Schema} from './shared/honor-v2-schema.mjs';
import {honorRankingSchema} from './shared/honor-schema.mjs';
import {currentHonorRegistry,honorDefinition} from './infrastructure/honor-rule-registry.mjs';
import {contributionProofs} from './domain/contribution-risk.mjs';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {digest} from './shared/digest.mjs';
import {sourceFingerprint} from './domain/history-v2.mjs';
const rule=(ok,code,status=409)=>{if(!ok)throw new ServiceError(code,status);};
const absent=e=>e instanceof ServiceError&&[403,404,409,422,503].includes(e.status);
export class HonorV2Service{
  constructor(legacy,{qualification,sharing,ciV2}={}){Object.assign(this,{legacy,qualification,sharing,ciV2});this.access=legacy.access;}
  publicRule(policy){return{...this.legacy.publicRule(policy),method:'current scoped contributions from real distinct Cases; multiple actual roles; selected disclosed fields only',sourceProfile:'facts-v2'};}
  async select(db,id,version,registry){const selected=await this.legacy.selectRule(db,id,version,registry);
    rule(selected.rule.sourceProfile==='facts-v2','honor_source_profile_mismatch');return selected;}
  async sources(db,actor,subjectId,policy){
    const items=[];let after=null;
    for(;;){const candidates=(await db.query(`SELECT p.* FROM task_participations p JOIN task_requests t ON t.id=p.task_id
      WHERE p.subject_id=$1 AND t.snapshot->'request'->>'capabilityId'=$2 AND ($3::uuid IS NULL OR p.id>$3) ORDER BY p.id LIMIT 100`,
      [subjectId,policy.capabilityId,after])).rows;
      for(const candidate of candidates){
        const scope=candidate.snapshot;if(scope.contentDeleted||scope.confirmedAt===null||scope.confirmedAt<policy.windowFrom||scope.confirmedAt>=policy.windowUntil)continue;
        const task=await this.qualification.assistance.taskRepository.get(db,candidate.task_id);if(!task||task.snapshot.contentDeleted)continue;
        if(policy.kind==='open-contributor'&&task.snapshot.request.collaboration!=='open-assistance')continue;
        const permitted=new Map();
        const readEventWithin=async(kind,row)=>{const p=await this.sharing.authorizeWithin(db,actor,kind,row,{purpose:'honor'});
          permitted.set(`${kind}:${row.id}`,{row,kind,permission:p});return p;};
        let fact=null,problem=null;
        const readEvidenceWithin=async(ref,context)=>{
          try{return await this.qualification.cases.sources.requireReferenceWithin(db,actor??{subjectId:null},{kind:'evidence',...ref},{caseId:context.caseId});}
          catch(error){if(!absent(error)||!this.ciV2)throw error;
            // An explicitly disclosed CI proof permits only the bounded CI
            // conclusion, not the underlying evidence report or its private text.
            const proofs=await this.ciV2.proofsForWithin(db,actor,{...context,subjectId,evidenceRefs:[ref]});
            if(!proofs.length)throw error;return{boundedCiProofOnly:true};}
        };
        try{fact=await this.qualification.participationWithin(db,actor,candidate.id,subjectId,{...policy,historyWindowSeconds:Number.MAX_SAFE_INTEGER}, {readEventWithin,readEvidenceWithin});}
        catch(error){if(!absent(error))throw error;problem=error.code;}
        // No visible participant fact means no public disclosure that this
        // private participation exists. Task root alone is insufficient.
        if(![...permitted.values()].some(p=>p.kind==='task-event'&&p.row.participation_id===candidate.id&&p.row.subject_id===subjectId))continue;
        const projections=[];
        for(const p of permitted.values())projections.push({source:this.sharing.reference(p.row,p.kind,p.permission),
          projection:await this.sharing.projectWithin(db,actor,p.row,p.permission.fields,p.permission),publicationIds:p.permission.publicationIds});
        // Retain every authorized observation in the policy repository scope.
        // A failure/different commit for the same numeric run/attempt must reach
        // the source conflict reducer, even when only success could grant Honor.
        const observations=fact?.usable&&this.ciV2?await this.ciV2.proofsForWithin(db,actor,{subjectId,caseId:fact.caseId,resultRef:fact.resultRef,evidenceRefs:fact.evidenceRefs,policy}):[];
        const proofs=observations.filter(proof=>proof.conclusion==='success');
        const related=policy.relatedPartyGroups.some(g=>g.includes(subjectId)&&g.includes(task.requester_id));
        items.push({id:digest(JSON.stringify([this.access.endpoint,subjectId,policy.id,policy.version,candidate.id])),
          _caseId:fact?.caseId??task.case_id,_eligible:!!fact?.usable,_synthetic:fact?.synthetic!==false,
          subjectId,eligible:!!fact?.usable&&fact.synthetic===false,sourceStatus:problem??fact?.reason??(fact?.synthetic?'synthetic-excluded':'current'),
          projections,proofs,observations,independence:related?'issuer-declared-related-party':'relationship-not-independently-verified',
          contributionMeaning:'accepted scoped work; not necessarily a successful Case or independent capability verification'});
      }
      if(candidates.length<100)break;after=candidates.at(-1).id;
    }
    return items.sort((a,b)=>a.id.localeCompare(b.id));
  }
  async projectWithin(db,actor,input,{selected=null,sources=null}={}){
    selected??=await this.select(db,input.ruleId,input.ruleVersion);const policy=selected.rule,now=this.access.now();
    rule(policy.members.includes(input.subjectId),'honor_subject_outside_scope',404);
    sources??=await this.sources(db,actor,input.subjectId,policy);
    const valid=sources.filter(s=>s.eligible),cases=new Set(valid.map(s=>s._caseId)),proofs=contributionProofs(valid);
    const active=selected.configured&&!policy.revoked&&policy.notBefore<=now&&policy.notAfter>now;
    const status=!active?'inactive-rule':cases.size>=policy.minAcceptedCases&&proofs.length>=policy.minProofs?'active':'insufficient-evidence';
    const publicItems=sources.map(({_caseId,_eligible,_synthetic,...s})=>s),definitionHash=honorDefinition(policy).definitionHash;
    const fingerprint=sourceFingerprint({publicItems,definitionHash,status});
    if(input.expectedFingerprint)rule(input.expectedFingerprint===fingerprint,'honor_sources_changed_retry');
    const start=input.after?publicItems.findIndex(s=>s.id===input.after)+1:0;rule(!input.after||start>0,'invalid_honor_cursor');
    const items=publicItems.slice(start,start+input.limit);
    const result={schemaVersion:2,card:{id:digest(JSON.stringify([this.access.endpoint,input.subjectId,policy.id,policy.version,'facts-v2'])),subjectId:input.subjectId,
      issuer:this.access.endpoint,rule:this.publicRule(policy),definitionHash,status,checkedAt:now,cacheable:false,
      acceptedCases:cases.size,proofs,capabilityVerified:false,qualificationGranted:false,
      statusUrl:`${this.access.endpoint}/v2/honor/${input.subjectId}/${policy.id}/${policy.version}`,
      ...(selected.registry?{registry:selected.registry}:{}),sharing:'Selected contribution projections only; this card grants no original-text access.'},
      items,nextAfter:start+items.length<publicItems.length?items.at(-1).id:null,sourceFingerprint:fingerprint,
      counts:{realDistinctAcceptedCases:cases.size,policyMatchedCiSources:proofs.length},complete:true,
      ...(policy.kind==='ci-backed-contributor'?{ciEvidenceSupport:{state:this.ciV2?'native-v2-current-proof-binding':'awaiting-v2-verified-proof-link-adapter',reportedCiLabelCountsAsVerified:false}}:{}),
      coverage:'all currently permitted matching participation sources in the selected rule/window; not global history',globalScore:null};
    if(input.includeSimulation)result.simulation={only:true,grantsHonor:false,distinctCases:new Set(sources.filter(s=>s._eligible).map(s=>s._caseId)).size};
    return result;
  }
  query(actor,input){const parsed=honorQueryV2Schema.safeParse(input);rule(parsed.success,'invalid_honor_query',400);
    const run=db=>this.projectWithin(db,actor,parsed.data);
    return this.legacy.retrySnapshot(()=>actor?this.access.runAuthorized(actor,'history',run,{isolation:'repeatable read'}):transaction(this.access.db,run,{isolation:'repeatable read'}));}
  ranking(input){const parsed=honorRankingSchema.safeParse(input);rule(parsed.success,'invalid_honor_ranking',400);
    return this.legacy.retrySnapshot(()=>transaction(this.access.db,async db=>{
      const registry=this.legacy.registryEnabled?await currentHonorRegistry(db,this.access.endpoint):undefined,selected=await this.select(db,parsed.data.ruleId,parsed.data.ruleVersion,registry),p=selected.rule,now=this.access.now();
      const base={schemaVersion:2,issuer:this.access.endpoint,rule:this.publicRule(p),checkedAt:now,qualificationGranted:false,capabilityVerified:false,globalScore:null};
      if(!p.rankingEnabled||p.privacyReview!=='approved')return{...base,status:'suppressed',reason:'ranking-not-approved',items:[]};
      if(!selected.configured||p.revoked||now<p.notBefore||now>=p.notAfter||now<p.windowUntil)return{...base,status:'suppressed',reason:'rule-inactive-or-window-open',items:[]};
      const rows=[];
      for(const subjectId of p.members){const view=await this.projectWithin(db,null,{...parsed.data,subjectId,limit:1},{selected});
        if(view.card.status==='active'&&view.card.acceptedCases>=p.minimumCasesPerMember)rows.push({subjectId,acceptedCases:view.card.acceptedCases,statusUrl:view.card.statusUrl});}
      if(rows.length<p.minimumCohort)return{...base,status:'suppressed',reason:'insufficient-public-cohort',items:[]};
      rows.sort((a,b)=>b.acceptedCases-a.acceptedCases||a.subjectId.localeCompare(b.subjectId));let rank=0;
      return{...base,status:'published',items:rows.map((r,i)=>{if(!i||r.acceptedCases!==rows[i-1].acceptedCases)rank=i+1;return{...r,rank};}),
        method:'real public distinct accepted Cases within this rule; ties share rank; not skill or industry ranking'};
    },{isolation:'repeatable read'}));}
}
