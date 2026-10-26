import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {CaseService,caseEventSchema,caseEventV2Schema} from "../src/cases/index.mjs";
import {caseFactsV2MigrationSql} from '../src/infrastructure/case-facts-v2-migration.mjs';
import {digest} from '../src/shared/digest.mjs';

async function fixture(scopes){
  const f=await serviceFixture(scopes);
  if(!(await f.db.query("SELECT to_regclass('case_task_links') AS name")).rows[0].name)await f.db.exec(caseFactsV2MigrationSql);
  f.cases=new CaseService(f.access,f.consents);
  f.cases.tasks=f.assistance;f.assistance.facts=f.cases;
  return f;
}
function root(f){const id=randomUUID();return{schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,
  actorId:f.actor.subjectId,localRef:randomUUID(),title:'合成事实流程',summary:'仅验证代码行为，不是真实用户案例',
  source:{kind:'local',reference:randomUUID()},synthetic:true};}
function fact(f,r,kind,version,fields={}){return{schemaVersion:2,eventId:randomUUID(),caseId:r.caseId,expectedVersion:version,
  actorId:f.actor.subjectId,kind,...fields};}
const grant=(f,e,overrides={})=>f.authorize(e,'case.teaser.publish',{objectId:e.eventId,...overrides});
const write=async(f,e)=>f.cases.submitV2(f.actor,await grant(f,e));
function intervention(f,r,version,more={}){return fact(f,r,'intervention',version,{types:['diagnosis','tool-introduction'],
  affectsAttemptIds:[],description:'已核对工具版本，建议排查请求重复',sourceRefs:[],observedEffect:'版本差异已排除，根因未定位',...more});}

test('canonical CaseService preserves self-declaration and historical decision after correcting its exact Result',async()=>{
  const f=await fixture();try{
    const r=root(f);await write(f,r);
    const d=intervention(f,r,1);await write(f,d);
    const self=fact(f,r,'intervention-response',2,{interventionRef:{id:d.eventId,version:1},state:'accepted',summary:'本人对自己工作的意见'});
    await write(f,self);
    let view=await f.cases.getV2(f.actor,r.caseId);
    assert.equal(view.interventions[0].responses[0].relationship,'self');
    assert.equal(view.interventions[0].confirmation,'unconfirmed');
    const result=fact(f,r,'result-recorded',3,{origin:{kind:'intervention',id:d.eventId,version:1},scopeVersion:1,
      deliverableRefs:[],reportedOutcome:'succeeded',summary:'原范围结果声明',limitations:'只是合成测试',supersedes:null});
    await write(f,result);
    const resolution=fact(f,r,'resolution-recorded',4,{taskScopeVersion:1,status:'resolved',summary:'原请求者解决结论',
      satisfiedGoals:['合成目标'],remainingGoals:[],resultRefs:[{id:result.eventId,version:1}],verificationRefs:[],supersedesResolutionId:null});
    const original=await grant(f,resolution);await f.cases.submitV2(f.actor,original);
    await write(f,{...result,eventId:randomUUID(),expectedVersion:5,reportedOutcome:'inconclusive',summary:'纠正旧结果的支持边界',
      supersedes:{id:result.eventId,version:1}});
    view=await f.cases.getV2(f.actor,r.caseId);
    assert.equal(view.resolution.status,'unrecorded');assert.equal(view.resolution.priorResolutionId,resolution.eventId);
    assert.equal(view.resolution.currentDecisionAvailable,false);assert.equal(view.resolution.reconfirmationRequired,true);
    assert.equal(view.resolutions[0].status,'resolved');assert.deepEqual(view.resolutions[0].resultRefs,[{id:result.eventId,version:1}]);
    const row=(await f.db.query('SELECT payload_text,payload_hash FROM case_events WHERE id=$1',[resolution.eventId])).rows[0];
    assert.equal(row.payload_text,original.payloadJson);assert.equal(row.payload_hash,digest(original.payloadJson));
    assert.equal(view.results.length,2);assert.equal(view.results[0].verification,'not-provided');
    assert.equal(view.results[1].acceptance,'not-provided');
  }finally{await f.db.close();}
});

test('v2 diagnosis produces real intervention Result without a fictitious Attempt; decisions stay separate',async()=>{
  const f=await fixture();try{
    const r=root(f);await write(f,r);
    const diagnosis=intervention(f,r,1),request=await grant(f,diagnosis);
    const receipt=await f.cases.submitV2(f.actor,request);
    assert.deepEqual(await f.cases.submitV2(f.actor,request),receipt);
    const result=fact(f,r,'result-recorded',2,{origin:{kind:'intervention',id:diagnosis.eventId,version:1},scopeVersion:1,
      deliverableRefs:[],reportedOutcome:'partial',summary:'范围内诊断完成',limitations:'没有执行修复',supersedes:null});
    await write(f,result);
    let view=await f.cases.getV2(f.actor,r.caseId);
    assert.equal(view.attempts.length,0);assert.equal(view.interventions.length,1);assert.equal(view.results.length,1);
    assert.equal(view.results[0].acceptance,'not-provided');assert.equal(view.results[0].verification,'not-provided');
    assert.equal(view.resolution.status,'unrecorded');assert.equal(view.legacyState,'open');assert.equal(view.synthetic,true);
    assert.equal(view.interventions[0].confirmation,'unconfirmed');
    const resolution=fact(f,r,'resolution-recorded',3,{taskScopeVersion:1,status:'partially-resolved',summary:'诊断完成但实现仍缺失',
      satisfiedGoals:['排除版本差异'],remainingGoals:['完成修复'],resultRefs:[{id:result.eventId,version:1}],verificationRefs:[],supersedesResolutionId:null});
    await write(f,resolution);
    await write(f,fact(f,r,'resolution-recorded',4,{...resolution,eventId:randomUUID(),expectedVersion:4,status:'regressed',
      summary:'新材料显示此前排除范围不充分',supersedesResolutionId:resolution.eventId}));
    view=await f.cases.getV2(f.actor,r.caseId);assert.equal(view.resolutions.length,2);assert.equal(view.resolution.status,'regressed');
    assert.equal(view.results[0].reportedOutcome,'partial');
    await assert.rejects(f.cases.get(f.actor,r.caseId),/unsupported_semantics/);
    assert.equal((await f.db.query("SELECT count(*) FROM case_events WHERE case_id=$1 AND kind='attempt'",[r.caseId])).rows[0].count,0);
  }finally{await f.db.close();}
});

test('v2 exact origins, actor authority, conflicts and append-only correction are enforced by service transactions',async()=>{
  const f=await fixture();try{
    const r=root(f),another=root(f);await write(f,r);await write(f,another);
    const d=intervention(f,r,1);await write(f,d);const foreign=intervention(f,another,1);await write(f,foreign);
    const base=fact(f,r,'result-recorded',2,{origin:{kind:'intervention',id:d.eventId,version:1},scopeVersion:1,
      deliverableRefs:[],reportedOutcome:'inconclusive',summary:'局部观察',limitations:'未知根因',supersedes:null});
    for(const origin of [{kind:'intervention',id:foreign.eventId,version:1},{kind:'intervention',id:d.eventId,version:99},
      {kind:'attempt',id:d.eventId,version:1},{kind:'intervention',id:randomUUID(),version:1}])
      await assert.rejects(write(f,{...base,eventId:randomUUID(),origin}),/invalid_result_origin/);
    assert.equal((await f.cases.getV2(f.actor,r.caseId)).version,2);
    assert.equal(caseEventV2Schema.safeParse({...base,origin:{...base.origin,attemptId:randomUUID()}}).success,false);
    assert.equal(caseEventV2Schema.safeParse({...base,origin:undefined}).success,false);
    const wrongActor={...base,actorId:'GUID'+'A'.repeat(28)};
    await assert.rejects(write(f,wrongActor),/actor_mismatch/);
    await write(f,base);
    const revised={...base,eventId:randomUUID(),expectedVersion:3,summary:'补充诊断限制',supersedes:{id:base.eventId,version:1}};
    await write(f,revised);
    const view=await f.cases.getV2(f.actor,r.caseId);
    assert.equal(view.results.length,2);assert.equal(view.results[0].summary,'局部观察');
    assert.equal(view.results[1].version,2);assert.equal(view.results[1].id,base.eventId);
    await assert.rejects(write(f,{...revised,eventId:randomUUID(),expectedVersion:4}),/fact_version_conflict/);
    const pending1=intervention(f,r,4),pending2=intervention(f,r,4);
    const requests=await Promise.all([grant(f,pending1),grant(f,pending2)]);
    const raced=await Promise.allSettled(requests.map(request=>f.cases.submitV2(f.actor,request)));
    assert.equal(raced.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(raced.find(x=>x.status==='rejected').reason.code,'version_conflict');
  }finally{await f.db.close();}
});

test('attempt lifecycle records cancellation without inventing outcome; corrections retain original terminal event',async()=>{
  const f=await fixture();try{
    const r=root(f);await write(f,r);
    const start=fact(f,r,'attempt-start',1,{role:'diagnosis',strategy:'核对公开片段',inputScopeSummary:'只有已选择片段',
      permissionScope:['read-selected-context']});await write(f,start);
    const end=fact(f,r,'attempt-end',2,{attemptRef:{id:start.eventId,version:1},status:'canceled',summary:'等待资料时取消',failureReason:'unknown'});
    await write(f,end);
    await assert.rejects(write(f,{...end,eventId:randomUUID(),expectedVersion:3,attemptRef:{id:start.eventId,version:2}}),/attempt_transition_denied/);
    await write(f,fact(f,r,'attempt-correct',3,{attemptRef:{id:start.eventId,version:2},status:'abandoned',summary:'主体主动停止',
      failureReason:'所需输入未提供',reason:'纠正取消来源'}));
    const view=await f.cases.getV2(f.actor,r.caseId);
    assert.deepEqual(view.attempts.map(a=>a.status),['running','canceled','abandoned']);
    assert.equal(view.attempts[1].reportedOutcome,'unrecorded');assert.equal(view.results.length,0);
    assert.equal(view.resolution.status,'unrecorded');assert.equal(view.attempts[0].environment,'unknown');
    assert.equal(view.attempts[0].configurationRef,null);
  }finally{await f.db.close();}
});

test('revoking one intervention hides its dependent Result but preserves independently authorized facts',async()=>{
  const f=await fixture();try{
    const r=root(f);await write(f,r);
    const source=intervention(f,r,1),g=await grant(f,source);await f.cases.submitV2(f.actor,g);
    const d=intervention(f,r,2,{sourceRefs:[{kind:'intervention',id:source.eventId,version:1}]});await write(f,d);
    const result=fact(f,r,'result-recorded',3,{origin:{kind:'intervention',id:d.eventId,version:1},scopeVersion:1,
      deliverableRefs:[],reportedOutcome:'partial',summary:'dependent private detail',limitations:'仅诊断',supersedes:null});
    await write(f,result);await write(f,intervention(f,r,4,{description:'另一独立诊断'}));
    await f.consents.revoke(f.actor,g.consentId);
    const view=await f.cases.getV2(f.actor,r.caseId);
    assert.equal(view.results.length,0);assert.equal(view.interventions.length,1);assert.equal(view.coverage.complete,false);
    assert.equal(JSON.stringify(view).includes('dependent private detail'),false);
    await assert.rejects(write(f,{...result,eventId:randomUUID(),expectedVersion:5}),/consent_required/);
  }finally{await f.db.close();}
});

test('v1 unchanged events keep exact bytes and unknown original actor in v2 projection',async()=>{
  const f=await fixture();try{
    const r={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'旧版案例',summary:'旧版合成对象',source:{kind:'local',reference:randomUUID()},
      participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    const request=await f.authorize(r);await f.cases.submit(f.actor,request);
    const attempt={kind:'attempt',id:randomUUID(),caseId:r.id,expectedVersion:1,sequence:1,approach:'旧版尝试',
      configuration:{environment:'test',version:'1',tools:[]}};await f.cases.submit(f.actor,await f.authorize(attempt));
    const result={kind:'result',id:randomUUID(),caseId:r.id,expectedVersion:2,attemptId:attempt.id,outcome:'succeeded',summary:'声明成功',failureReason:'',limitations:[]};
    await f.cases.submit(f.actor,await f.authorize(result));
    assert.equal(caseEventSchema.safeParse({...result,attemptId:undefined}).success,false);
    assert.equal((await f.cases.get(f.actor,r.id)).state,'resolution-proposed');
    const view=await f.cases.getV2(f.actor,r.id);assert.equal(view.attempts[0].actorId,'unknown');
    assert.equal(view.resolution.status,'unrecorded');assert.deepEqual(view.results[0].origin,{kind:'attempt',id:attempt.id,version:1});
    assert.equal((await f.db.query('SELECT payload_text FROM case_events WHERE id=$1',[r.id])).rows[0].payload_text,request.payloadJson);
  }finally{await f.db.close();}
});

test('real Task/Participation services atomically link first work, credit multiple people and accept diagnostic delivery separately',async()=>{
  const scopes=['binding','consent','case-teaser','assistance'];
  const f=await fixture(scopes),p=await serviceFixture(scopes,f.db),q=await serviceFixture(scopes,f.db);
  const ag=(who,payload,viewers=[])=>who.authorize(payload,'assistance.publish',{objectId:payload.operationId??payload.eventId,viewers});
  try{
    const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',title:'主动诊断',summary:'无失败历史的合成任务',
      workContext:{goal:'明确实现范围',currentSituation:'正在评估',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+1000};
    await f.assistance.createTask(f.actor,await ag(f,task,[p.actor.subjectId,q.actor.subjectId]));
    assert.equal((await f.db.query('SELECT count(*) FROM cases')).rows[0].count,0);
    const r={...root(f),taskId:task.taskId,source:{kind:'active-task',reference:task.taskId}};
    const initial=intervention(f,r,1,{taskId:task.taskId,types:['scope-clarification'],description:'已澄清实际工作范围'});
    const link={operationId:randomUUID(),taskId:task.taskId,expectedTaskVersion:1,case:await grant(f,r),initialFact:await grant(f,initial)};
    const linked=await f.cases.createAndLinkTask(f.actor,link);
    assert.equal(linked.caseVersion,2);assert.equal(linked.failedAttemptsCreated,0);
    assert.equal(linked.taskVersion,1);assert.equal(linked.taskCaseLinkVersion,1);
    assert.deepEqual(await f.cases.createAndLinkTask(f.actor,link),linked);
    assert.equal((await f.db.query('SELECT case_id FROM task_requests WHERE id=$1',[task.taskId])).rows[0].case_id,r.caseId);
    const participate=async(who,role)=>{
      const row=(await f.db.query('SELECT version FROM task_requests WHERE id=$1',[task.taskId])).rows[0];
      const proposal={eventId:randomUUID(),expectedTaskVersion:row.version,kind:'propose',participationId:randomUUID(),
        subjectId:who.actor.subjectId,role,scopeVersion:1,agreedScope:role==='diagnosis'?'分析现有信息':'复核诊断依据'};
      await f.assistance.proposeParticipation(f.actor,task.taskId,await ag(f,proposal,[who.actor.subjectId]));
      const confirm={eventId:randomUUID(),expectedParticipationVersion:1,kind:'confirm',scopeVersion:1};
      await f.assistance.submitParticipationEvent(who.actor,proposal.participationId,await ag(who,confirm,[f.actor.subjectId]));
      return proposal.participationId;
    };
    const pp=await participate(p,'diagnosis'),qp=await participate(q,'review');
    const pd=intervention(p,r,2,{taskId:task.taskId,participationId:pp});
    await f.cases.submitV2(p.actor,await grant(p,pd,{viewers:[f.actor.subjectId]}));
    const qd=intervention(q,r,3,{taskId:task.taskId,participationId:qp,types:['review'],description:'复核诊断允许的观察范围'});
    await f.cases.submitV2(q.actor,await grant(q,qd,{viewers:[f.actor.subjectId]}));
    const response1=fact(f,r,'intervention-response',4,{taskId:task.taskId,interventionRef:{id:pd.eventId,version:1},state:'accepted',summary:'诊断实际有用'});
    await assert.rejects(write(f,{...response1,participationId:pp}),/participation_required/,
      'case ownership cannot turn another person participation into the owner own role');
    const response2=fact(f,r,'intervention-response',5,{taskId:task.taskId,interventionRef:{id:qd.eventId,version:1},state:'partial',summary:'复核覆盖部分材料'});
    const batch=await f.cases.respondBatch(f.actor,[await grant(f,response1,{viewers:[p.actor.subjectId]}),await grant(f,response2,{viewers:[q.actor.subjectId]}),
      await grant(f,{...response2,eventId:randomUUID(),expectedVersion:6,interventionRef:{id:randomUUID(),version:1}})]);
    assert.deepEqual(batch.results.map(x=>x.status),['accepted','accepted','rejected']);
    const result=fact(p,r,'result-recorded',6,{taskId:task.taskId,participationId:pp,origin:{kind:'intervention',id:pd.eventId,version:1},
      scopeVersion:1,deliverableRefs:[],reportedOutcome:'partial',summary:'诊断报告已提供',limitations:'没有实施补丁',supersedes:null});
    await f.cases.submitV2(p.actor,await grant(p,result,{viewers:[f.actor.subjectId]}));
    const delivery={kind:'deliver',eventId:randomUUID(),expectedParticipationVersion:2,resultRef:{id:result.eventId,version:1},
      interventionRefs:[{id:pd.eventId,version:1}],evidenceRefs:[],summary:'交付诊断报告'};
    await f.assistance.submitParticipationEvent(p.actor,pp,await ag(p,delivery,[f.actor.subjectId]));
    const accept={kind:'accept',eventId:randomUUID(),expectedParticipationVersion:3,deliveryId:delivery.eventId,summary:'接受已约定的诊断'};
    await f.assistance.submitParticipationEvent(f.actor,pp,await ag(f,accept,[p.actor.subjectId]));
    const state=(await f.db.query('SELECT snapshot FROM task_participations WHERE id=$1',[pp])).rows[0].snapshot;
    assert.equal(state.deliveries[0].acceptance.actorId,f.actor.subjectId);
    assert.equal(state.deliveries[0].verification,'not-provided');assert.equal(state.deliveries[0].resolution,'unresolved');
    let view=await f.cases.getV2(f.actor,r.caseId,{taskId:task.taskId});
    assert.equal(view.attempts.length,0);assert.equal(view.interventions.length,3);assert.equal(view.resolution.status,'unrecorded');
    assert.equal(view.interventions.find(i=>i.actorId===p.actor.subjectId).confirmation,'confirmed');
    assert.equal(view.interventions.find(i=>i.actorId===q.actor.subjectId).confirmation,'partially-confirmed');
    const qview=await f.cases.getV2(q.actor,r.caseId,{taskId:task.taskId});
    assert.equal(qview.interventions.length,1);assert.equal(qview.results.length,0);assert.equal(qview.coverage.complete,false);
    assert.equal(JSON.stringify(qview).includes('诊断报告已提供'),false);
    await assert.rejects(f.cases.submitV2(q.actor,await grant(q,{...result,eventId:randomUUID(),actorId:q.actor.subjectId,expectedVersion:7,participationId:qp})),/origin_not_authorized/);
    const resolution=fact(f,r,'resolution-recorded',7,{taskId:task.taskId,taskScopeVersion:1,status:'partially-resolved',summary:'诊断接受，修复仍待继续',
      satisfiedGoals:['诊断报告'],remainingGoals:['修复'],resultRefs:[{id:result.eventId,version:1}],verificationRefs:[],supersedesResolutionId:null});
    await write(f,resolution);view=await f.cases.getV2(f.actor,r.caseId,{taskId:task.taskId});
    assert.equal(view.resolution.status,'partially-resolved');
    const scopeChange={kind:'propose-scope',eventId:randomUUID(),expectedParticipationVersion:4,scopeVersion:2,
      agreedScope:'补充验证诊断的新材料',reason:'更新该参与者的约定'};
    await f.assistance.submitParticipationEvent(f.actor,pp,await ag(f,scopeChange,[p.actor.subjectId]));
    const confirmedScope={kind:'confirm-scope',eventId:randomUUID(),expectedParticipationVersion:5,proposalId:scopeChange.eventId};
    await f.assistance.submitParticipationEvent(p.actor,pp,await ag(p,confirmedScope,[f.actor.subjectId]));
    const extra=intervention(p,r,8,{taskId:task.taskId,participationId:pp,participationScopeVersion:2,description:'实际核对追加材料'});
    await f.cases.submitV2(p.actor,await grant(p,extra,{viewers:[f.actor.subjectId]}));
    const extraResult={...result,eventId:randomUUID(),expectedVersion:9,participationScopeVersion:2,
      origin:{kind:'intervention',id:extra.eventId,version:1},summary:'补充材料观察'};
    await f.cases.submitV2(p.actor,await grant(p,extraResult,{viewers:[f.actor.subjectId]}));
    const extraDelivery={...delivery,eventId:randomUUID(),expectedParticipationVersion:6,
      resultRef:{id:extraResult.eventId,version:1},interventionRefs:[{id:extra.eventId,version:1}]};
    await f.assistance.submitParticipationEvent(p.actor,pp,await ag(p,extraDelivery,[f.actor.subjectId]));
    view=await f.cases.getV2(f.actor,r.caseId,{taskId:task.taskId});
    assert.equal(view.scopeVersion,1,'a participant agreement revision does not revise the whole task');
    assert.equal(view.results.at(-1).participationScopeVersion,2);
    assert.equal(view.resolution.status,'partially-resolved');
    assert.equal((await f.db.query("SELECT count(*) FROM case_events WHERE kind IN ('attempt','attempt-start')")).rows[0].count,0);
  }finally{await f.db.close();}
});

test('failed first actual fact rolls back Case root and Task link in the real transaction',async()=>{
  const f=await fixture(['binding','consent','case-teaser','assistance']);try{
    const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'diagnosis',title:'原子关联',summary:'合成事务测试',
      workContext:{goal:'排查',currentSituation:'无历史',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+1000};
    await f.assistance.createTask(f.actor,await f.authorize(task,'assistance.publish',{objectId:task.operationId}));
    const r={...root(f),taskId:task.taskId,source:{kind:'active-task',reference:task.taskId}};
    const initial=intervention(f,r,1,{taskId:task.taskId,affectsAttemptIds:[randomUUID()]});
    await assert.rejects(f.cases.createAndLinkTask(f.actor,{operationId:randomUUID(),taskId:task.taskId,expectedTaskVersion:1,
      case:await grant(f,r),initialFact:await grant(f,initial)}),/invalid_case_reference/);
    assert.equal((await f.db.query('SELECT count(*) FROM cases')).rows[0].count,0);
    const row=(await f.db.query('SELECT case_id,version FROM task_requests WHERE id=$1',[task.taskId])).rows[0];
    assert.equal(row.case_id,null);assert.equal(row.version,1);
    assert.equal((await f.db.query('SELECT count(*) FROM case_task_links')).rows[0].count,0);
  }finally{await f.db.close();}
});
