import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {ExperienceReviewService} from '../src/experience-review.mjs';
import {QualificationService} from '../src/qualification.mjs';
import {QualificationV2Service} from '../src/qualification-v2.mjs';
import {experienceReviewMigrationSql} from '../src/infrastructure/experience-review-schema.mjs';
import {QualificationCalculationService} from '../src/qualification-calculation.mjs';
import {createApi} from '../src/http.mjs';
import {qualificationToolDefinitions} from '../src/adapters/mcp/personal/tools/qualification-v2.mjs';
export const scopes=['binding','consent','case-teaser','assistance','evidence','proof','capsules'];
export const capabilityId='software-debugging';
export async function fixture(database=null,options={}){const requestedScopes=[...new Set([...scopes,...(options.extraScopes??[])])];const f=await serviceFixture(requestedScopes,database,{syntheticCommunityQuota:false,...options});
  if(!(await f.db.query("SELECT to_regclass('experience_objects') AS name")).rows[0].name)await f.db.exec(experienceReviewMigrationSql);
  const p=await serviceFixture(requestedScopes,f.db,{...options,migrateDatabase:false,syntheticCommunityQuota:false});
  const policy={id:'test-related-work',version:'1',capabilityId,title:'合成场景策略',collaboration:'basic-bounty',notBefore:f.now-1,notAfter:f.now+1000,
    minProofs:0,minAcceptedCollaborations:1,historyWindowSeconds:31536000,requireCiSuccess:false,repositories:[]};
  const reviewers=[{subjectId:p.actor.subjectId,capabilityIds:[capabilityId],kinds:['external-work','challenge'],scope:'合成范围核对',notBefore:f.now-1,notAfter:f.now+1000,authorityReference:'synthetic-reviewer-registration',synthetic:true}];
  f.experienceReviews=new ExperienceReviewService(f.access,f.consents,{reviewers});
  f.qualification=new QualificationService(f.access,f.proofs,f.assistance,[policy]);f.assistance.qualification=f.qualification;
  f.qualificationCalculations=new QualificationCalculationService(f.access,f.consents,f.assistance);
  f.qualification.v2=new QualificationV2Service(f.qualification,{cases:f.cases,assistance:f.assistance,experienceReviews:f.experienceReviews,capsules:f.capsules,calculations:f.qualificationCalculations});
  return{f,p,policy};
}
export const ag=(who,e,viewers=[])=>who.authorize(e,'assistance.publish',{objectId:e.operationId??e.event?.eventId??e.eventId,viewers});
export const cg=(who,e,viewers=[])=>who.authorize(e,'case.teaser.publish',{objectId:e.eventId,viewers});
export const xg=(who,e,viewers=[])=>who.authorize(e,'experience.submit',{objectId:e.operationId,viewers});
export function task(f,paid=false){return{operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',title:'合成资格任务',summary:'无真实报酬或真实任务',
  workContext:{goal:'有限诊断',currentSituation:'合成',attemptRefs:[]},visibility:'Private',collaboration:paid?'basic-bounty':'open-assistance',capabilityId,enrollmentExpiresAt:f.now+500,
  ...(paid?{budget:{mode:'fixed',amount:'1',unit:'SYNTHETIC'},qualification:{policyId:'test-related-work',policyVersion:'1',profile:'facts-v2'}}:{})};}
export async function target(f,p){const t=task(f,true);await f.assistance.createTask(f.actor,await ag(f,t,[p.actor.subjectId]));return t;}
export function experience(f){return{id:randomUUID(),operationId:randomUUID(),kind:'challenge',expectedVersion:0,reportedBy:f.actor.subjectId,subjectId:f.actor.subjectId,synthetic:true,capabilityId,
  source:{system:'synthetic-work',stableRecord:randomUUID(),originalAt:new Date(f.now*1000).toISOString(),originalAuthor:'测试作者',links:['https://example.org/test'],contentVersion:'1'},
  actualIntervention:'实际合成算法挑战',resultReference:'test-run:1',outcome:'partial',scope:'有限合成挑战',limitations:['不是生产案例'],ownershipStatement:'合成声明不证明外部所有权'};}
export function review(p,e){return{id:randomUUID(),operationId:randomUUID(),kind:'review',expectedVersion:0,reportedBy:p.actor.subjectId,synthetic:true,experienceRef:{id:e.id,version:1},capabilityId,
  state:'verified-in-scope',scope:'算法挑战范围',observedAt:new Date(p.now*1000).toISOString(),checked:{source:true,attribution:true,actualIntervention:true,result:true,acceptanceOrIndependentCheck:true},
  method:'合成核对过程',observations:'仅核对这个范围',limitations:['不代表生产能力'],sourceReferences:['synthetic-check:1'],relationship:'non-party'};}

export async function nativeWork(f,p,{viewers=[]}={}){
  const peers=[p.actor.subjectId,...viewers];
  const open=task(f);open.title='不应向新请求者披露的旧项目标题';await f.assistance.createTask(f.actor,await ag(f,open,peers));
  const cid=randomUUID(),r={schemaVersion:2,kind:'case-created',eventId:cid,caseId:cid,expectedVersion:0,actorId:f.actor.subjectId,taskId:open.taskId,
    localRef:randomUUID(),title:open.title,summary:'只用于验收服务',source:{kind:'active-task',reference:open.taskId},synthetic:true};
  const first={schemaVersion:2,kind:'intervention',eventId:randomUUID(),caseId:cid,expectedVersion:1,actorId:f.actor.subjectId,taskId:open.taskId,
    types:['diagnosis'],affectsAttemptIds:[],description:'有限诊断',sourceRefs:[],observedEffect:'已确定范围'};
  await f.cases.createAndLinkTask(f.actor,{operationId:randomUUID(),taskId:open.taskId,expectedTaskVersion:1,case:await cg(f,r,peers),initialFact:await cg(f,first,peers)});
  const proposal={eventId:randomUUID(),kind:'propose',expectedTaskVersion:1,participationId:randomUUID(),subjectId:p.actor.subjectId,role:'diagnosis',scopeVersion:1,agreedScope:'有限诊断'};
  await f.assistance.proposeParticipation(f.actor,open.taskId,await ag(f,proposal,[p.actor.subjectId]));
  const confirm={eventId:randomUUID(),kind:'confirm',expectedParticipationVersion:1,scopeVersion:1};
  await f.assistance.submitParticipationEvent(p.actor,proposal.participationId,await ag(p,confirm,[f.actor.subjectId]));
  const intervention={...first,eventId:randomUUID(),actorId:p.actor.subjectId,expectedVersion:2,participationId:proposal.participationId};await f.cases.submitV2(p.actor,await cg(p,intervention,[f.actor.subjectId]));
  const result={schemaVersion:2,kind:'result-recorded',eventId:randomUUID(),caseId:cid,expectedVersion:3,actorId:p.actor.subjectId,taskId:open.taskId,participationId:proposal.participationId,
    scopeVersion:1,origin:{kind:'intervention',id:intervention.eventId,version:1},deliverableRefs:[],reportedOutcome:'partial',summary:'诊断完成，修复未完成',limitations:'仅诊断'};
  await f.cases.submitV2(p.actor,await cg(p,result,[f.actor.subjectId]));
  const delivery={eventId:randomUUID(),kind:'deliver',expectedParticipationVersion:2,resultRef:{id:result.eventId,version:1},interventionRefs:[{id:intervention.eventId,version:1}],evidenceRefs:[],summary:'诊断交付'};
  await f.assistance.submitParticipationEvent(p.actor,proposal.participationId,await ag(p,delivery,[f.actor.subjectId]));
  const acceptance={eventId:randomUUID(),kind:'accept',expectedParticipationVersion:3,deliveryId:delivery.eventId,summary:'接受有限诊断'};
  await f.assistance.submitParticipationEvent(f.actor,proposal.participationId,await ag(f,acceptance,[p.actor.subjectId]));
  return{open,cid,r,proposal,confirm,intervention,result,delivery,acceptance};
}
const grantFor=(who,data)=>who.authorize(data,data.kind==='compute'?'qualification.compute':'qualification.source-permission',{
  objectId:data.id,viewers:[data.candidateId,data.recipientId].filter(id=>id!==who.actor.subjectId)});
export async function verifyScopedCalculationWorkflow(database=null,{testHttp=false,...options}={}){
  const{f,p}=await fixture(database,options);try{
    const n=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false,syntheticCommunityQuota:false}),work=await nativeWork(f,p),t=task(f,true);
    t.title='新请求者的独立任务';await f.assistance.createTask(n.actor,await ag(n,t,[p.actor.subjectId]));
    const evidence={participationIds:[work.proposal.participationId]},input={taskId:t.taskId,subjectId:p.actor.subjectId,evidence,includeSimulation:true};
    assert.equal((await f.qualification.v2.evaluate(n.actor,input)).simulation.state,'insufficient-evidence');
    await assert.rejects(f.assistance.getTask(n.actor,work.open.taskId),/not_found/);
    const sourceRefs=[];
    for(const{kind,table,ids}of[{kind:'task-event',table:'task_events',ids:[work.open.operationId,work.proposal.eventId,work.confirm.eventId,work.delivery.eventId,work.acceptance.eventId]},
      {kind:'case-event',table:'case_events',ids:[work.r.eventId,work.intervention.eventId,work.result.eventId]}]){
      for(const id of ids){const row=(await f.db.query(`SELECT subject_id,payload_hash FROM ${table} WHERE id=$1`,[id])).rows[0];assert.ok(row);
        sourceRefs.push({kind,id,eventVersion:1,payloadHash:row.payload_hash,owner:row.subject_id});}}
    const common={id:randomUUID(),taskId:t.taskId,candidateId:p.actor.subjectId,recipientId:n.actor.subjectId,
      purpose:'this-task-eligibility-computation-only',expiresAt:new Date((f.now+300)*1000).toISOString(),
      disclosure:'public-conditions-and-bounded-satisfaction-only; no-source-text-or-other-party-identity'};
    const plain=refs=>refs.map(({owner:_owner,...ref})=>ref),ownForeign=sourceRefs.filter(s=>s.owner===f.actor.subjectId);
    const compute={...common,kind:'compute',sourceRefs:plain(sourceRefs),permissionIds:[],evidence};
    await assert.rejects(f.qualificationCalculations.submit(p.actor,await grantFor(p,compute)),/qualification_source_permission_required/);
    const permission={...common,id:randomUUID(),kind:'source-permission',sourceRefs:plain(ownForeign)};
    await assert.rejects(f.qualificationCalculations.submit(p.actor,await grantFor(p,permission)),/qualification_source_author_required/);
    const partialPermission={...permission,id:randomUUID(),sourceRefs:permission.sourceRefs.slice(0,1)};
    await f.qualificationCalculations.submit(f.actor,await grantFor(f,partialPermission));
    const partialCompute={...compute,id:randomUUID(),permissionIds:[partialPermission.id]};
    await assert.rejects(f.qualificationCalculations.submit(p.actor,await grantFor(p,partialCompute)),/qualification_source_permission_required/);
    await f.qualificationCalculations.submit(f.actor,await grantFor(f,permission));
    compute.permissionIds=[permission.id];const signed=await grantFor(p,compute);await f.qualificationCalculations.submit(p.actor,signed);
    await f.qualificationCalculations.submit(p.actor,signed); // exact retry
    const selected={...input,evidence:{...evidence,calculationGrantId:compute.id}};
    let q=await f.qualification.v2.evaluate(n.actor,selected);assert.equal(q.state,'insufficient-evidence');assert.equal(q.simulation.state,'satisfied',JSON.stringify(q));
    assert.equal(q.simulation.grantsParticipation,false);assert.equal(q.calculation.recipientId,n.actor.subjectId);
    for(const privateValue of [work.open.title,work.open.taskId,work.cid,work.result.eventId,f.actor.subjectId])assert.equal(JSON.stringify(q).includes(privateValue),false);
    q=await f.qualification.v2.evaluate(p.actor,selected);assert.equal(q.simulation.state,'satisfied');assert.equal(q.calculation.recipientId,n.actor.subjectId);
    const application={taskId:t.taskId,event:{eventId:randomUUID(),kind:'apply',expectedTaskVersion:1,proposal:'合成申请',scope:'有限诊断',qualificationEvidence:selected.evidence}};
    await f.assistance.submitTaskEvent(p.actor,t.taskId,await ag(p,application,[n.actor.subjectId]));
    const propose={eventId:randomUUID(),kind:'propose',expectedTaskVersion:2,participationId:randomUUID(),subjectId:p.actor.subjectId,role:'diagnosis',scopeVersion:1,agreedScope:'有限诊断',applicationId:application.event.eventId};
    await assert.rejects(f.assistance.proposeParticipation(n.actor,t.taskId,await ag(n,propose,[p.actor.subjectId])),/qualification_required/);
    await assert.rejects(f.assistance.getTask(n.actor,work.open.taskId),/not_found/);
    await assert.rejects(f.qualification.v2.evaluate(n.actor,{...selected,evidence:{...selected.evidence,participationIds:[]}}),/qualification_calculation_evidence_mismatch/);
    const wrongHash={...compute,id:randomUUID(),sourceRefs:compute.sourceRefs.map((r,i)=>i? r:{...r,payloadHash:'0'.repeat(64)})};
    await assert.rejects(f.qualificationCalculations.submit(p.actor,await grantFor(p,wrongHash)),/qualification_source_unavailable/);
    const unsupported={...compute,id:randomUUID(),evidence:{...evidence,externalReviewRefs:[{id:randomUUID(),version:1}]}};
    await assert.rejects(f.qualificationCalculations.submit(p.actor,await grantFor(p,unsupported)),/qualification_calculation_source_kind_unsupported/);
    const normalNow=f.access.now;f.access.now=()=>f.now+301;
    try{await assert.rejects(f.qualification.v2.evaluate(n.actor,selected),/qualification_calculation_unavailable/);}finally{f.access.now=normalNow;}
    const tools=qualificationToolDefinitions(f,n.actor);assert.equal((await tools.galaxy_qualification_v2_evaluate.run(selected)).simulation.state,'satisfied');
    if(testHttp){const api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));try{
      const request=async(path,who,input)=>{const response=await fetch(`http://127.0.0.1:${api.address().port}${path}`,{method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${who.credential}`},body:JSON.stringify(input)});const body=await response.json();
        assert.equal(response.status,200,JSON.stringify(body));return body;};
      assert.equal((await request('/v2/qualification/evaluate',n,selected)).simulation.state,'satisfied');
      assert.equal((await request('/v2/qualification/calculation-permissions',p,signed)).grantId,compute.id);
      const e=experience(f);await request('/v2/experience/submit',f,await xg(f,e,[p.actor.subjectId]));
      assert.equal((await request('/v2/experience/read',p,{id:e.id})).verification,'not-reviewed-by-this-statement');
      const r=review(p,e);await request('/v2/experience/submit',p,await xg(p,r,[f.actor.subjectId]));
      assert.equal((await request('/v2/experience/read',f,{id:r.id})).experienceKind,'challenge');
      assert.equal((await qualificationToolDefinitions(f,f.actor).galaxy_experience_read.run({id:r.id})).capabilityVerified,false);
    }finally{await new Promise((resolve,reject)=>api.close(e=>e?reject(e):resolve()));}}
    // Source-author revocation invalidates the computation without changing
    // the old participants' original Task permissions.
    const revoke={kind:'revoke',id:randomUUID(),grantId:permission.id,reason:'撤销本次派生披露'};
    await f.qualificationCalculations.submit(f.actor,await f.authorize(revoke,'qualification.source-permission',{objectId:revoke.id}));
    await assert.rejects(f.qualification.v2.evaluate(n.actor,selected),/qualification_calculation_unavailable/);
    assert.equal((await f.assistance.getTask(p.actor,work.open.taskId)).taskId,work.open.taskId);
    return{f,p,n,t,work};
  }finally{if(!database)await f.db.close();}
}

