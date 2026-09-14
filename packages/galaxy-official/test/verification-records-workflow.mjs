import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';

export async function verifyRecordWorkflow(db,{migrateDatabase=true,repositories}={}){
  const scopes=['binding','consent','case-teaser','assistance','evidence','proof'];
  const f=await serviceFixture(scopes,db,{migrateDatabase,repositories,syntheticCommunityQuota:false});
  const p=await serviceFixture(scopes,db,{migrateDatabase:false,repositories,syntheticCommunityQuota:false});
  const caseGrant=(who,payload,viewers=[])=>who.authorize(payload,'case.teaser.publish',{objectId:payload.eventId,viewers});
  const ag=(who,payload,viewers=[])=>who.authorize(payload,'assistance.publish',{objectId:payload.operationId??payload.eventId,viewers});
  const eg=(who,payload,viewers=[])=>who.authorize(payload,'evidence.submit',{objectId:payload.operationId,viewers});
  const api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`;
  const call=async(who,path,body)=>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${who.credential}`},body:JSON.stringify(body)});
    const output=await response.json();return{status:response.status,output};};
  try{
    const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',title:'合成三种结果对照',summary:'没有历史失败的主动复核',
      workContext:{goal:'复核诊断范围',currentSituation:'准备协作',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+1000};
    await f.assistance.createTask(f.actor,await ag(f,task,[p.actor.subjectId]));
    const caseId=randomUUID(),r={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:f.actor.subjectId,taskId:task.taskId,
      localRef:randomUUID(),title:'合成主动复核',summary:'合成流程',source:{kind:'active-task',reference:task.taskId},synthetic:true};
    const initial={schemaVersion:2,kind:'intervention',eventId:randomUUID(),caseId,expectedVersion:1,actorId:f.actor.subjectId,taskId:task.taskId,
      types:['scope-clarification'],affectsAttemptIds:[],description:'已确定有限检查范围',sourceRefs:[],observedEffect:'尚未修复'};
    await f.cases.createAndLinkTask(f.actor,{operationId:randomUUID(),taskId:task.taskId,expectedTaskVersion:1,
      case:await caseGrant(f,r,[p.actor.subjectId]),initialFact:await caseGrant(f,initial,[p.actor.subjectId])});
    const result={schemaVersion:2,kind:'result-recorded',eventId:randomUUID(),caseId,expectedVersion:2,actorId:f.actor.subjectId,taskId:task.taskId,
      origin:{kind:'intervention',id:initial.eventId,version:1},scopeVersion:1,deliverableRefs:[],reportedOutcome:'partial',summary:'诊断已提供',limitations:'线上未实测'};
    await f.cases.submitV2(f.actor,await caseGrant(f,result,[p.actor.subjectId]));
    const proposal={eventId:randomUUID(),kind:'propose',expectedTaskVersion:1,participationId:randomUUID(),subjectId:p.actor.subjectId,
      role:'verification',scopeVersion:1,agreedScope:'只复核诊断的幂等范围'};
    await f.assistance.proposeParticipation(f.actor,task.taskId,await ag(f,proposal,[p.actor.subjectId]));
    const base={caseId,reportedBy:p.actor.subjectId,taskId:task.taskId,participationId:proposal.participationId,participationScopeVersion:1,
      expectedVersion:0,synthetic:true,observedAt:new Date(f.now*1000).toISOString()};
    const evidence={...base,id:randomUUID(),operationId:randomUUID(),kind:'evidence',evidenceType:'test-result',
      source:{originSystem:'synthetic-local-run',externalStableId:randomUUID(),contentVersion:'1',issuer:p.actor.subjectId,originalAt:base.observedAt},
      reportedSourceState:'available',summary:'范围有限的合成检查输出'};
    const before=await call(p,'/v2/verification-records/submit',await eg(p,evidence,[f.actor.subjectId]));assert.equal(before.status,403);
    const confirm={eventId:randomUUID(),kind:'confirm',expectedParticipationVersion:1,scopeVersion:1};
    await f.assistance.submitParticipationEvent(p.actor,proposal.participationId,await ag(p,confirm,[f.actor.subjectId]));
    const evidenceGrant=await eg(p,evidence,[f.actor.subjectId]);
    const imported=await call(p,'/v2/verification-records/submit',evidenceGrant);assert.ok(imported.status>=200&&imported.status<300,JSON.stringify(imported));
    const verification={...base,id:randomUUID(),operationId:randomUUID(),kind:'verification',target:{type:'result',id:result.eventId,version:1},scopeVersion:1,
      method:'local-test',scope:'幂等性',conditions:{environment:'synthetic'},observation:'passed',summary:'报告范围通过，不代表生产可用',
      evidenceRefs:[{id:evidence.id,version:1}],relationship:'independent'};
    assert.ok((await call(p,'/v2/verification-records/submit',await eg(p,verification,[f.actor.subjectId]))).status<300);
    const view=await call(f,'/v2/verification-records/read',{type:'verification',id:verification.id,version:1});assert.equal(view.status,200);
    assert.equal(view.output.provenance.recordedRelationship,'task-participant');assert.equal(view.output.provenance.declaredRelationship,'independent');
    assert.equal(view.output.provenance.relationshipIndependentlyVerified,false);assert.equal(view.output.independentExecutionVerified,false);
    const forged={...verification,id:randomUUID(),operationId:randomUUID()};
    const denied=await call(f,'/v2/verification-records/submit',await eg(f,forged));assert.equal(denied.status,403);
    const resolution={schemaVersion:2,kind:'resolution-recorded',eventId:randomUUID(),caseId,expectedVersion:3,actorId:f.actor.subjectId,taskId:task.taskId,
      taskScopeVersion:1,status:'partially-resolved',summary:'有本地复核，生产条件未知',satisfiedGoals:['诊断'],remainingGoals:['线上实测'],
      resultRefs:[{id:result.eventId,version:1}],verificationRefs:[{id:verification.id,version:1}],supersedesResolutionId:null};
    await f.cases.submitV2(f.actor,await caseGrant(f,resolution));
    assert.equal((await f.cases.getV2(f.actor,caseId,{taskId:task.taskId})).resolution.status,'partially-resolved');
    const withdraw={eventId:randomUUID(),kind:'withdraw',expectedParticipationVersion:2,reason:'结束本次参与'};
    await f.assistance.submitParticipationEvent(p.actor,proposal.participationId,await ag(p,withdraw,[f.actor.subjectId]));
    const correction={...verification,operationId:randomUUID(),expectedVersion:1,reason:'退出后补充限制',summary:'部分输入缺失，结果不确定',observation:'inconclusive'};
    assert.ok((await call(p,'/v2/verification-records/submit',await eg(p,correction,[f.actor.subjectId]))).status<300);
    assert.equal((await f.cases.getV2(f.actor,caseId,{taskId:task.taskId})).resolution.status,'unrecorded');
    const revoke={id:verification.id,operationId:randomUUID(),expectedVersion:2,caseId,reportedBy:p.actor.subjectId,synthetic:true,
      kind:'revoke',objectType:'verification',reason:'本人撤回有限意见'};
    assert.ok((await call(p,'/v2/verification-records/submit',await eg(p,revoke))).status<300);
    await f.consents.revoke(p.actor,evidenceGrant.consentId);
    const refreshed=await call(f,'/v2/verification-records/status',{refs:[{type:'evidence',id:evidence.id},{type:'verification',id:verification.id,version:1}]});
    assert.equal(refreshed.status,200);assert.equal(refreshed.output.items[0].referenceStatus,'unavailable');
    assert.equal(Number((await f.db.query("SELECT count(*) FROM case_events WHERE case_id=$1 AND kind IN ('attempt','attempt-start')",[caseId])).rows[0].count),0);
    return{caseId,multiParticipant:true,forgedReporterRejected:true,independenceNotInferred:true,withdrawnReviewerCorrection:true,revocationPropagated:true};
  }finally{await new Promise(resolve=>api.close(resolve));}
}
