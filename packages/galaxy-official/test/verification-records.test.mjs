import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {VerificationRecordService} from "../src/evidence/verification-records.mjs";
import {evidenceVerificationV2MigrationSql} from '../src/infrastructure/evidence-verification-v2-migration.mjs';
import {factToolDefinitions} from '../src/adapters/mcp/personal/tools/facts-v2.mjs';
import {PGlite} from '@electric-sql/pglite';
import {verifyRecordWorkflow} from './verification-records-workflow.mjs';

const scopes=['binding','consent','case-teaser','evidence','proof','assistance'];
async function fixture(){const f=await serviceFixture(scopes,null,{syntheticCommunityQuota:false});
  if(!(await f.db.query("SELECT to_regclass('verification_objects') AS name")).rows[0].name)await f.db.exec(evidenceVerificationV2MigrationSql);
  f.verificationRecords=new VerificationRecordService(f.access,f.consents,{cases:f.cases,tasks:f.assistance,proofs:f.proofs});
  f.evidence.records=f.verificationRecords;f.cases.sources=f.verificationRecords;f.cases.verifications=f.verificationRecords;return f;}
const grant=(f,e,viewers=[])=>f.authorize(e,'case.teaser.publish',{objectId:e.eventId,viewers});
const authorize=(f,e,viewers=[])=>f.authorize(e,'evidence.submit',{objectId:e.operationId,viewers});
const put=async(f,e)=>f.verificationRecords.submit(f.actor,await authorize(f,e));
function base(f,r,more={}){return{id:randomUUID(),operationId:randomUUID(),expectedVersion:0,caseId:r.caseId,reportedBy:f.actor.subjectId,synthetic:true,...more};}
const time=f=>new Date(f.now*1000).toISOString();
test('real HTTP and separately signed Task participants can report, correct after exit and revoke limited verification',async()=>{
  const db=new PGlite();try{await verifyRecordWorkflow(db);}finally{await db.close();}
});
function evidence(f,r,more={}){return{...base(f,r),kind:'evidence',evidenceType:'test-result',source:{originSystem:'synthetic-user-test',externalStableId:'run:1',
  contentVersion:'commit:1',contentHash:'a'.repeat(64),originalAt:time(f),issuer:f.actor.subjectId},observedAt:time(f),reportedSourceState:'available',
  summary:'合成本地检查日志引用，服务端未执行这些检查',...more};}
function verify(f,r,target,refs=[],more={}){return{...base(f,r),kind:'verification',target:{type:'result',id:target.eventId,version:1},scopeVersion:1,
  method:'local-test',scope:'仅幂等重复请求场景',conditions:{environment:'synthetic',repositoryVersion:'commit:1'},observation:'passed',
  evidenceRefs:refs,relationship:'same-controller',observedAt:time(f),summary:'用户侧报告此范围通过',...more};}
async function caseResult(f){const id=randomUUID(),r={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,actorId:f.actor.subjectId,
  localRef:randomUUID(),title:'合成有限验证',summary:'不是实际试点',source:{kind:'local',reference:randomUUID()},synthetic:true};
  await f.cases.submitV2(f.actor,await grant(f,r));
  const d={schemaVersion:2,kind:'intervention',eventId:randomUUID(),caseId:id,expectedVersion:1,actorId:f.actor.subjectId,types:['diagnosis'],
    affectsAttemptIds:[],description:'真实记录的合成诊断',sourceRefs:[],observedEffect:'部分定位'};
  await f.cases.submitV2(f.actor,await grant(f,d));
  const result={schemaVersion:2,kind:'result-recorded',eventId:randomUUID(),caseId:id,expectedVersion:2,actorId:f.actor.subjectId,
    origin:{kind:'intervention',id:d.eventId,version:1},scopeVersion:1,deliverableRefs:[],reportedOutcome:'partial',summary:'诊断结果',limitations:'尚未修复'};
  await f.cases.submitV2(f.actor,await grant(f,result));return{r,d,result};}

test('general evidence and verification retain exact versions, source groups and bounded report semantics through MCP',async()=>{
  const f=await fixture();try{
    const {r,result}=await caseResult(f),e=evidence(f,r),request=await authorize(f,e);
    const tools=factToolDefinitions(f,f.actor),submitted=await tools.galaxy_evidence_v2_submit.run(request);
    assert.deepEqual(await tools.galaxy_evidence_v2_submit.run(request),submitted);
    const copy=evidence(f,r,{id:randomUUID(),operationId:randomUUID()});await put(f,copy);
    const v=verify(f,r,result,[{id:e.id,version:1}]);await put(f,v);
    const feedback=verify(f,r,result,[],{method:'requester-acceptance',observation:'partially-accepted',summary:'接受诊断但尚需修复'});await put(f,feedback);
    const view=await f.verificationRecords.get(f.actor,{type:'verification',id:v.id});
    assert.equal(view.sourceStrength,'user-side-test-report');assert.equal(view.provenance.recordedRelationship,'self');
    assert.equal(view.independentExecutionVerified,false);assert.equal(view.taskOutcomeVerified,false);assert.equal(view.capabilityVerified,false);
    assert.equal(view.provenance.declaredRelationship,'same-controller');
    const status=await tools.galaxy_evidence_status.run({refs:[{type:'evidence',id:e.id},{type:'evidence',id:copy.id},{type:'verification',id:v.id},{type:'verification',id:feedback.id}]});
    assert.equal(status.sourceSummary.evidenceRecordCount,2);assert.equal(status.sourceSummary.declaredSourceGroupCount,1);
    assert.equal(status.sourceSummary.independentlyVerifiedSourceCount,0);assert.ok(status.items.every(x=>x.synthetic));
    assert.equal(status.items[0].availability.upstream,'not-checked');assert.equal(status.items[0].record.reportedSourceState,'available');
    assert.equal((await f.cases.getV2(f.actor,r.caseId)).resolution.status,'unrecorded');
    assert.equal((await f.db.query('SELECT count(*) FROM verification_events')).rows[0].count,4);
    assert.equal((await f.db.query("SELECT count(*) FROM jobs")).rows[0].count,0,'metadata reports do not spawn model/test jobs');
    await assert.rejects(put(f,verify(f,r,result,[])),/supporting_evidence_required/);
    await assert.rejects(put(f,verify(f,r,result,[],{method:'participant-feedback'})),/observation_method_mismatch/);
    await assert.rejects(put(f,verify(f,r,result,[{id:e.id,version:99}])),/evidence_version_changed/);
    await assert.rejects(put(f,verify(f,r,result,[{id:e.id,version:1}],{target:{type:'result',id:result.eventId,version:2}})),/target_version_changed/);
    await assert.rejects(put(f,evidence(f,r,{synthetic:false})),/synthetic_mismatch/);
    await assert.rejects(put(f,evidence(f,r,{reportedBy:'GUID'+'A'.repeat(28)})),/reporter_mismatch/);
  }finally{await f.db.close();}
});

test('source correction/revocation propagates to dependent Case facts and Resolution without rewriting history',async()=>{
  const f=await fixture();try{
    const {r,d,result}=await caseResult(f),e=evidence(f,r);await put(f,e);
    const v=verify(f,r,result,[{id:e.id,version:1}]);await put(f,v);
    const resolution={schemaVersion:2,kind:'resolution-recorded',eventId:randomUUID(),caseId:r.caseId,expectedVersion:3,actorId:f.actor.subjectId,
      taskScopeVersion:1,status:'partially-resolved',summary:'有限检查支持诊断',satisfiedGoals:['诊断'],remainingGoals:['修复'],
      resultRefs:[{id:result.eventId,version:1}],verificationRefs:[{id:v.id,version:1}],supersedesResolutionId:null};
    await f.cases.submitV2(f.actor,await grant(f,resolution));
    assert.equal((await f.cases.getV2(f.actor,r.caseId)).resolution.status,'partially-resolved');
    const next={...e,operationId:randomUUID(),expectedVersion:1,source:{...e.source,contentVersion:'commit:2'},reason:'补充新的观察范围',summary:'新日志'};
    await put(f,next);
    const historical=await f.verificationRecords.get(f.actor,{type:'evidence',id:e.id,version:1});
    assert.equal(historical.referenceStatus,'superseded');assert.equal(historical.record.source.contentVersion,'commit:1');
    let view=await f.cases.getV2(f.actor,r.caseId);
    assert.equal(view.resolution.status,'unrecorded');assert.equal(view.coverage.complete,false);assert.ok(view.coverage.unavailableReasons.includes('evidence_version_changed'));
    const invalidated=await f.verificationRecords.get(f.actor,{type:'verification',id:v.id});assert.equal(invalidated.record,null);assert.equal(invalidated.referenceStatus,'dependency-unavailable');
    const newv={...v,operationId:randomUUID(),expectedVersion:1,evidenceRefs:[{id:e.id,version:2}],reason:'重新核对新日志'};await put(f,newv);
    const nextresolution={...resolution,eventId:randomUUID(),expectedVersion:4,verificationRefs:[{id:v.id,version:2}],supersedesResolutionId:resolution.eventId};
    await f.cases.submitV2(f.actor,await grant(f,nextresolution));
    const dependent={...d,eventId:randomUUID(),expectedVersion:5,sourceRefs:[{kind:'evidence',id:e.id,version:2}],description:'依赖受控证据的私有观察'};
    await f.cases.submitV2(f.actor,await grant(f,dependent));
    const revoke={...base(f,r),id:e.id,kind:'revoke',objectType:'evidence',expectedVersion:2,reason:'主动撤回来源'};
    await put(f,revoke);view=await f.cases.getV2(f.actor,r.caseId);
    assert.equal(view.resolution.status,'unrecorded');assert.ok(!JSON.stringify(view).includes(dependent.description));
    assert.equal((await f.db.query('SELECT count(*) FROM case_events WHERE case_id=$1',[r.caseId])).rows[0].count,6);
    assert.equal((await f.verificationRecords.get(f.actor,{type:'evidence',id:e.id,version:2})).referenceStatus,'revoked');
    await assert.rejects(put(f,{...next,expectedVersion:3,operationId:randomUUID()}),/record_revoked/);
  }finally{await f.db.close();}
});

test('current Consent and target authorization are rechecked; Result corrections cannot leave a current validation green',async()=>{
  const f=await fixture();try{
    const {r,result}=await caseResult(f),e=evidence(f,r),eg=await authorize(f,e);await f.verificationRecords.submit(f.actor,eg);
    const v=verify(f,r,result,[{id:e.id,version:1}]);await put(f,v);
    const other=await serviceFixture(scopes,f.db,{migrateDatabase:false,syntheticCommunityQuota:false});
    await assert.rejects(f.verificationRecords.get(other.actor,{type:'evidence',id:e.id}),/record_not_authorized/);
    const otherCase=await caseResult(f);
    await assert.rejects(put(f,verify(f,otherCase.r,otherCase.result,[{id:e.id,version:1}])),/evidence_case_mismatch/);
    await f.cases.submitV2(f.actor,await grant(f,{...result,eventId:randomUUID(),expectedVersion:3,supersedes:{id:result.eventId,version:1},summary:'修正结果限制'}));
    assert.equal((await f.verificationRecords.get(f.actor,{type:'verification',id:v.id})).referenceStatus,'target-version-changed');
    await f.consents.revoke(f.actor,eg.consentId);
    const invalid=await f.verificationRecords.get(f.actor,{type:'verification',id:v.id});assert.equal(invalid.record,null);
    const status=await f.verificationRecords.status(f.actor,{refs:[{type:'evidence',id:e.id},{type:'verification',id:v.id}]});
    assert.equal(status.items[0].referenceStatus,'unavailable');assert.equal(status.items[0].currentRevocation,'unknown');
    assert.equal(status.items[1].referenceStatus,'dependency-unavailable');
  }finally{await f.db.close();}
});
