import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {CapsuleServiceV2} from '../src/capsules-v2.mjs';
import {capsuleToolDefinitions} from '../src/personal-mcp-capsules-v2.mjs';
import {createApi} from '../src/http.mjs';
import {checkChoiceSource} from './choice-source-check.mjs';
const scopes=['binding','consent','case-teaser','assistance','evidence','proof','capsules','history','data-delete','data-export'];
const publicView={visibility:'Public',purpose:'public-profile'};
const cg=(f,e,viewers=[])=>f.authorize(e,'case.teaser.publish',{objectId:e.eventId,viewers});
const ag=(f,e,viewers=[])=>f.authorize(e,'assistance.publish',{objectId:e.eventId??e.operationId,viewers});
const eg=(f,e)=>f.authorize(e,'evidence.submit',{objectId:e.operationId});
const put=async(f,e,viewers=[])=>f.cases.submitV2(f.actor,await cg(f,e,viewers));
function root(f){const id=randomUUID();return {schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,actorId:f.actor.subjectId,
  localRef:randomUUID(),title:'合成Capsule源',summary:'仅验证代码，不是真实试点',source:{kind:'local',reference:randomUUID()},synthetic:true};}
function event(f,r,kind,version,extra={}){return {schemaVersion:2,kind,eventId:randomUUID(),caseId:r.caseId,expectedVersion:version,actorId:f.actor.subjectId,...extra};}
async function actual(f,outcome='succeeded'){
  const r=root(f);await put(f,r);
  const a=event(f,r,'attempt-start',1,{role:'implementation',strategy:'实际执行合成场景',inputScopeSummary:'已选合成资料',permissionScope:['selected-context'],environment:{name:'Node',version:'24'}});await put(f,a);
  const result=event(f,r,'result-recorded',2,{origin:{kind:'attempt',id:a.eventId,version:1},scopeVersion:1,deliverableRefs:[],reportedOutcome:outcome,summary:'合成执行结果',limitations:'非真实试点'});await put(f,result);
  return {r,a,result};
}
function version(f,s,more={}){return {schemaVersion:2,id:randomUUID(),capsuleId:randomUUID(),kind:'version',expectedRevision:0,version:1,
  publicationClass:'formal-source-success',synthetic:true,title:'依赖排查方法',problemPattern:'依赖版本差异',environment:{name:'Node',version:'24'},
  solutionStrategy:'核对依赖并复测已选范围',tools:['compiler'],skills:[],mcpRefs:[],verificationMethod:'引用具体结果与独立的范围验证记录',limitations:['合成流程'],
  capabilityId:'software-debugging',applicableScope:'依赖版本排查',license:'MIT',contributors:[],sourceResolution:{caseId:s.r.caseId,resultId:s.result.eventId,resultVersion:1,proofIds:[],verificationRefs:[]},
  sourceRefs:[],permissionRefs:[],attributionRefs:[],externalReferences:[],redactionConfirmed:true,...more};}
function apply(f,v,s,more={}){return {schemaVersion:2,id:randomUUID(),kind:'apply',capsuleId:v.capsuleId,versionId:v.id,caseId:s.r.caseId,
  attribution:v.authorId,note:'实际采用已发布方法',attemptRef:{id:s.a.eventId,version:1},resultRef:{id:s.result.eventId,version:1},environment:{name:'Node',version:'24'},
  environmentDifference:'不同依赖图',adoptedParts:['先核对版本'],outcome:s.result.reportedOutcome,...more};}
async function fixture(db,options={}){const f=await serviceFixture(scopes,db,{syntheticCommunityQuota:false,...options});
  f.capsules.v2??=new CapsuleServiceV2(f.capsules,{cases:f.cases,verificationRecords:f.verificationRecords});return f;}

export async function verifyCapsuleV2Workflow(db,{testHttp=false,...options}={}){
  const f=await fixture(db,options),p=await fixture(f.db,{...options,migrateDatabase:false});
  try{
    const source=await actual(f),target=await actual(p,'failed'),v=version(f,source),tools=capsuleToolDefinitions(f,f.actor);
    assert.equal((await tools.galaxy_capsule_v2_preview.run({payload:v})).readyForPublicPublication,true);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM capsules WHERE id=$1',[v.capsuleId])).rows[0].count),0);
    const signed=await f.authorize(v,'capsule.publish',publicView);await tools.galaxy_capsule_v2_publish.run(signed);
    const found=await f.search.v2.query(null,{type:'capsule',query:{query:v.title}});
    assert.equal(found.items[0].source.versionId,v.id);assert.equal(found.items[0].source.version,v.version);
    assert.equal(found.items[0].record.authorId,f.actor.subjectId);assert.equal(found.items[0].applied,false);
    await checkChoiceSource(f,p.actor,{type:'capsule',query:{query:v.title}},v.capsuleId);
    assert.equal((await f.capsules.getV2(p.actor,{capsuleId:v.capsuleId})).readingIsReuse,false);
    assert.equal((await f.capsules.usesV2(p.actor,{capsuleId:v.capsuleId})).counts.applications,0);
    await assert.rejects(f.capsules.get(f.actor,{capsuleId:v.capsuleId}),/unsupported_semantics/);
    const reference={schemaVersion:2,id:randomUUID(),kind:'reference',capsuleId:v.capsuleId,versionId:v.id,caseId:target.r.caseId,attribution:f.actor.subjectId,note:'仅作参考'};
    await f.capsules.recordUseV2(p.actor,await p.authorize(reference,'capsule.use'));
    const use=apply(p,{...v,authorId:f.actor.subjectId},target);await f.capsules.recordUseV2(p.actor,await p.authorize(use,'capsule.use'));
    let uses=await f.capsules.usesV2(p.actor,{capsuleId:v.capsuleId});assert.equal(uses.counts.references,1);assert.equal(uses.counts.applications,1);
    assert.equal(uses.items.find(i=>i.kind==='apply').reportedOutcome,'failed');assert.equal(uses.counts.reportedSuccessfulTargetCases,0);assert.equal(uses.counts.syntheticApplications,1);
    const history=await f.history.queryV2(p.actor,{subjectId:p.actor.subjectId});
    assert.equal(history.items.find(i=>i.caseId===target.r.caseId).capsuleReuse.items.find(i=>i.kind==='apply').reportedOutcome,'failed');
    await assert.rejects(f.capsules.recordUseV2(p.actor,await p.authorize({...use,id:randomUUID(),outcome:'succeeded'},'capsule.use')),/capsule_result_mismatch/);
    const base={id:randomUUID(),operationId:randomUUID(),expectedVersion:0,caseId:target.r.caseId,reportedBy:p.actor.subjectId,synthetic:true,observedAt:new Date(p.now*1000).toISOString()};
    const e={...base,kind:'evidence',evidenceType:'test-result',source:{originSystem:'synthetic-fixture',externalStableId:randomUUID(),contentVersion:'1',issuer:p.actor.subjectId,originalAt:base.observedAt},reportedSourceState:'available',summary:'失败检查记录'};
    await f.verificationRecords.submit(p.actor,await eg(p,e));
    const verification={...base,id:randomUUID(),operationId:randomUUID(),kind:'verification',target:{type:'result',id:target.result.eventId,version:1},scopeVersion:1,
      method:'local-test',scope:'只有依赖加载',conditions:{environment:'synthetic'},observation:'failed',evidenceRefs:[{id:e.id,version:1}],relationship:'same-controller',summary:'有限范围仍失败'};
    await f.verificationRecords.submit(p.actor,await eg(p,verification));
    const reverify={...use,id:randomUUID(),kind:'reverify',priorUseId:use.id,verificationRefs:[{id:verification.id,version:1}]};
    await f.capsules.recordUseV2(p.actor,await p.authorize(reverify,'capsule.use'));
    uses=await f.capsules.usesV2(p.actor,{capsuleId:v.capsuleId});assert.equal(uses.items.find(i=>i.kind==='reverify').verifications[0].referenceStatus,'current');
    assert.equal(uses.counts.independentlyVerifiedReuseCases,0);
    const {observedAt,...revokeBase}=base;
    await f.verificationRecords.submit(p.actor,await eg(p,{...revokeBase,id:e.id,operationId:randomUUID(),kind:'revoke',objectType:'evidence',expectedVersion:1,reason:'撤回测试记录'}));
    uses=await f.capsules.usesV2(p.actor,{capsuleId:v.capsuleId});assert.equal(uses.items.find(i=>i.kind==='reverify').verifications[0].referenceStatus,'dependency-unavailable');
    const notice={schemaVersion:2,id:randomUUID(),kind:'deprecate',capsuleId:v.capsuleId,versionId:v.id,expectedRevision:1,summary:'方法不再推荐'};
    await f.capsules.publishV2(f.actor,await f.authorize(notice,'capsule.publish',publicView));assert.equal((await f.capsules.getV2(f.actor,{capsuleId:v.capsuleId})).revision,2);
    const nextTarget=await actual(p);await assert.rejects(f.capsules.recordUseV2(p.actor,await p.authorize(apply(p,{...v,authorId:f.actor.subjectId},nextTarget),'capsule.use')),/capsule_not_applicable/);
    if(testHttp){const api=createApi(f);await new Promise(r=>api.listen(0,'127.0.0.1',r));try{
      const response=await fetch(`http://127.0.0.1:${api.address().port}/v2/capsules/read`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${p.credential}`},body:JSON.stringify({capsuleId:v.capsuleId})});
      assert.equal(response.status,200);assert.equal((await response.json()).deprecated,true);
    }finally{await new Promise(r=>api.close(r));}}
    return {syntheticOnly:true,realSignedConsent:true,referenceIsNotReuse:true,exactFailedApply:true,revocationPropagated:true};
  }finally{if(!db)await f.db.close();}
}

export async function verifyCapsuleV2MultiParty(){
  const f=await fixture(),p=await fixture(f.db,{migrateDatabase:false});try{
    const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',title:'多人许可',summary:'实际协作许可流程',workContext:{goal:'修复',currentSituation:'合成',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+1000};
    await f.assistance.createTask(f.actor,await ag(f,task,[p.actor.subjectId]));
    const r={...root(f),taskId:task.taskId,source:{kind:'active-task',reference:task.taskId}},first=event(f,r,'intervention',1,{taskId:task.taskId,types:['diagnosis'],affectsAttemptIds:[],description:'已诊断',sourceRefs:[],observedEffect:'确定范围'});
    await f.cases.createAndLinkTask(f.actor,{operationId:randomUUID(),taskId:task.taskId,expectedTaskVersion:1,case:await cg(f,r,[p.actor.subjectId]),initialFact:await cg(f,first,[p.actor.subjectId])});
    const proposal={eventId:randomUUID(),kind:'propose',expectedTaskVersion:1,participationId:randomUUID(),subjectId:p.actor.subjectId,role:'patch',scopeVersion:1,agreedScope:'修复并报告'};
    await f.assistance.proposeParticipation(f.actor,task.taskId,await ag(f,proposal,[p.actor.subjectId]));
    await f.assistance.submitParticipationEvent(p.actor,proposal.participationId,await ag(p,{eventId:randomUUID(),kind:'confirm',expectedParticipationVersion:1,scopeVersion:1},[f.actor.subjectId]));
    const d=event(p,r,'intervention',2,{taskId:task.taskId,participationId:proposal.participationId,types:['patch'],affectsAttemptIds:[],description:'实际补丁',sourceRefs:[],observedEffect:'局部修复'});await put(p,d,[f.actor.subjectId]);
    const result=event(p,r,'result-recorded',3,{taskId:task.taskId,participationId:proposal.participationId,origin:{kind:'intervention',id:d.eventId,version:1},scopeVersion:1,deliverableRefs:[],reportedOutcome:'succeeded',summary:'报告范围内成功',limitations:'没有独立验证'});await put(p,result,[f.actor.subjectId]);
    const v=version(p,{r,result},{contributors:[f.actor.subjectId],attributionRefs:[{subjectId:f.actor.subjectId,source:{kind:'case-root',id:r.eventId,version:1,caseId:r.caseId}}]});
    await assert.rejects(f.capsules.publishV2(p.actor,await p.authorize(v,'capsule.publish',publicView)),/capsule_source_permission_required/);
    const permission={schemaVersion:2,id:randomUUID(),kind:'grant',sources:[{kind:'case-root',id:r.eventId,version:1,caseId:r.caseId}],grantees:[p.actor.subjectId],license:'MIT',scope:'仅选定Case背景用于这类Capsule',basis:'authored-content',attribution:'请求者背景贡献',allowPublic:true};
    await assert.rejects(f.capsules.permissionV2(p.actor,await p.authorize(permission,'capsule.permission')),/capsule_source_author_required/);
    await f.capsules.permissionV2(f.actor,await f.authorize(permission,'capsule.permission',{viewers:[p.actor.subjectId]}));
    v.permissionRefs=[permission.id];await f.capsules.publishV2(p.actor,await p.authorize(v,'capsule.publish',publicView));
    const read=await f.capsules.getV2(null,{capsuleId:v.capsuleId});assert.equal(read.attributions[0].subjectId,f.actor.subjectId);assert.equal(read.coauthorApproval,false);
    const second={...v,id:randomUUID(),expectedRevision:1,version:2,title:'同许可新版本'};await f.capsules.publishV2(p.actor,await p.authorize(second,'capsule.publish',publicView));
    assert.equal(Number((await f.db.query('SELECT count(*) FROM capsule_permissions')).rows[0].count),1);
    await f.capsules.permissionV2(f.actor,await f.authorize({schemaVersion:2,id:randomUUID(),kind:'revoke',permissionId:permission.id,reason:'来源许可撤回'},'capsule.permission'));
    assert.equal((await f.capsules.getV2(null,{capsuleId:v.capsuleId})).version,null);
    assert.equal((await f.capsules.queryV2(null,{query:'同许可'})).items.length,0);
    assert.equal((await f.search.v2.query(null,{type:'capsule',query:{query:'同许可'}})).pageCount,0);
    assert.equal((await f.db.query('SELECT payload_text FROM capsule_events WHERE id=$1',[v.id])).rows[0].payload_text.includes('依赖排查'),true);
  }finally{await f.db.close();}
}

export async function verifyCapsuleV2Redaction(){
  const f=await fixture(),p=await fixture(f.db,{migrateDatabase:false});try{
    const source=await actual(f),target=await actual(p),v=version(f,source);await f.capsules.publishV2(f.actor,await f.authorize(v,'capsule.publish',publicView));
    const use=apply(p,{...v,authorId:f.actor.subjectId},target);await f.capsules.recordUseV2(p.actor,await p.authorize(use,'capsule.use'));
    // Precisely simulate M19's retained-FK tombstone contract; this test is not
    // evidence that a deletion worker ran or that a remote database was erased.
    await f.db.query("UPDATE case_events SET payload_text='',payload='{}'::jsonb WHERE id=$1",[source.result.eventId]);
    const view=await f.capsules.getV2(null,{capsuleId:v.capsuleId});assert.equal(view.version,null);
    assert.equal((await f.capsules.usesV2(p.actor,{capsuleId:v.capsuleId})).items[0].record,null);
    await f.db.query("UPDATE capsule_events SET payload_text='' WHERE id=$1",[v.id]);
    const uses=await f.capsules.usesV2(p.actor,{capsuleId:v.capsuleId});assert.equal(uses.items[0].sourceStatus,'capsule-unavailable');assert.equal(uses.items[0].record,null);
    assert.equal((await f.db.query('SELECT payload_text FROM capsule_uses_v2 WHERE id=$1',[use.id])).rows[0].payload_text,JSON.stringify(use));
    assert.equal((await f.capsules.query(f.actor,{})).items.length,0);
  }finally{await f.db.close();}
}

export async function verifyCapsuleV2VersionBoundaries(){
  const f=await fixture(),p=await fixture(f.db,{migrateDatabase:false});try{
    const source=await actual(f),target=await actual(p),v=version(f,source);await f.capsules.publishV2(f.actor,await f.authorize(v,'capsule.publish',publicView));
    const use=apply(p,{...v,authorId:f.actor.subjectId},target);await f.capsules.recordUseV2(p.actor,await p.authorize(use,'capsule.use'));
    await put(p,{...target.result,eventId:randomUUID(),expectedVersion:3,supersedes:{id:target.result.eventId,version:1},reportedOutcome:'partial',summary:'后续纠正为部分完成'});
    const uses=await f.capsules.usesV2(p.actor,{capsuleId:v.capsuleId});assert.equal(uses.items[0].sourceStatus,'application-result-superseded');assert.equal(uses.items[0].record.resultRef.version,1);
    const newer={...v,id:randomUUID(),expectedRevision:1,version:2,title:'仅作者可见的新版'};
    await f.capsules.publishV2(f.actor,await f.authorize(newer,'capsule.publish'));
    await assert.rejects(f.capsules.getV2(null,{capsuleId:v.capsuleId}),/capsule_unavailable/);
    assert.equal((await f.capsules.getV2(null,{capsuleId:v.capsuleId,versionId:v.id})).version.title,v.title);
    assert.equal((await f.capsules.queryV2(null,{query:v.title})).items.length,0);
    await put(f,{...source.result,eventId:randomUUID(),expectedVersion:3,supersedes:{id:source.result.eventId,version:1},reportedOutcome:'failed',summary:'原结果被纠正'});
    const historical=await f.capsules.getV2(null,{capsuleId:v.capsuleId,versionId:v.id});assert.equal(historical.sourceStatus,'source-result-superseded');assert.equal(historical.newApplicationAllowed,false);
    await assert.rejects(f.capsules.publishV2(f.actor,await f.authorize({...newer,id:randomUUID(),version:3,expectedRevision:2},'capsule.publish')),/fact_version_conflict/);
    assert.equal((await f.db.query('SELECT payload_text FROM capsule_uses_v2 WHERE id=$1',[use.id])).rows[0].payload_text,JSON.stringify(use));
  }finally{await f.db.close();}
}
