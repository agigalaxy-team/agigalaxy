import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {digest} from '../src/shared/digest.mjs';

// All identities and observations are isolated test data. The false Case flag
// deliberately exercises a mixed-source Case, not a claim of real-world work.
async function fixture(){
  const f=await serviceFixture(['binding','consent','case-teaser','evidence','history','capsule']);
  let api;
  try{
    const caseId=randomUUID(),created={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,
      actorId:f.actor.subjectId,localRef:randomUUID(),title:'隔离测试的混合来源',summary:'非合成标记的父对象与合成子证据',
      source:{kind:'local',reference:randomUUID()},synthetic:false};
    const write=payload=>f.authorize(payload,'case.teaser.publish',{objectId:payload.eventId})
      .then(request=>f.cases.submitV2(f.actor,request));
    await write(created);
    const intervention={schemaVersion:2,kind:'intervention',eventId:randomUUID(),caseId,expectedVersion:1,
      actorId:f.actor.subjectId,types:['diagnosis'],affectsAttemptIds:[],description:'测试目标',sourceRefs:[],observedEffect:'范围内报告'};
    await write(intervention);
    const result={schemaVersion:2,kind:'result-recorded',eventId:randomUUID(),caseId,expectedVersion:2,actorId:f.actor.subjectId,
      origin:{kind:'intervention',id:intervention.eventId,version:1},scopeVersion:1,deliverableRefs:[],
      reportedOutcome:'partial',summary:'测试目标结果',limitations:'没有真实业务执行'};
    await write(result);
    api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${api.address().port}`;
    const call=async(path,body)=>{
      const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${f.credential}`},body:JSON.stringify(body)});
      return{status:response.status,body:await response.json()};
    };
    const common=()=>({id:randomUUID(),operationId:randomUUID(),expectedVersion:0,caseId,reportedBy:f.actor.subjectId,
      synthetic:false,observedAt:new Date(f.now*1000).toISOString()});
    const evidence=(synthetic)=>({...common(),kind:'evidence',synthetic,evidenceType:'test-result',
      source:{originSystem:'isolated-fixture',externalStableId:randomUUID(),contentVersion:'1',issuer:f.actor.subjectId,
        originalAt:new Date(f.now*1000).toISOString()},reportedSourceState:'available',summary:'隔离测试证据'});
    const verification=refs=>({...common(),kind:'verification',target:{type:'result',id:result.eventId,version:1},scopeVersion:1,
      method:'local-test',scope:'测试标记传播',conditions:{environment:'isolated-fixture'},observation:'passed',
      summary:'有限测试报告，不是能力认证',evidenceRefs:refs,relationship:'same-controller'});
    const submit=async payload=>{
      const request=await f.authorize(payload,'evidence.submit',{objectId:payload.operationId});
      const response=await call('/v2/verification-records/submit',request);
      assert.equal(response.status,200,JSON.stringify(response));return{...response,request};
    };
    return{...f,caseId,result,evidence,verification,submit,call,
      close:async()=>{await new Promise(resolve=>api.close(resolve));await f.db.close();}};
  }catch(error){if(api?.listening)await new Promise(resolve=>api.close(resolve));await f.db.close();throw error;}
}

test('synthetic Evidence propagates to its Verification without changing unrelated Case facts',async()=>{
  const f=await fixture();try{
    const evidence=f.evidence(true);await f.submit(evidence);
    const verification=f.verification([{id:evidence.id,version:1}]);
    const submitted=await f.submit(verification);
    assert.equal(submitted.body.synthetic,true,'dependent Verification cannot erase the source marker');
    const view=await f.call('/v2/verification-records/read',{type:'verification',id:verification.id,version:1});
    assert.equal(view.status,200);assert.equal(view.body.synthetic,true);assert.equal(view.body.provenance.synthetic,true);
    assert.equal(view.body.record.synthetic,false,'original declaration remains distinct from effective provenance');
    assert.deepEqual((await f.db.query('SELECT payload_text,payload_hash FROM verification_events WHERE operation_id=$1',
      [verification.operationId])).rows[0],{payload_text:submitted.request.payloadJson,payload_hash:digest(submitted.request.payloadJson)});
    assert.equal((await f.cases.getV2(f.actor,f.caseId)).synthetic,false);
    const unrelatedEvidence=f.evidence(false);await f.submit(unrelatedEvidence);
    const unrelated=await f.submit(f.verification([{id:unrelatedEvidence.id,version:1}]));
    assert.equal(unrelated.body.synthetic,false);
    const correction={...verification,operationId:randomUUID(),expectedVersion:1,reason:'更换测试引用',
      evidenceRefs:[{id:unrelatedEvidence.id,version:1}]};
    const refused=await f.call('/v2/verification-records/submit',await f.authorize(correction,'evidence.submit',{objectId:correction.operationId}));
    assert.equal(refused.status,422);assert.equal(refused.body.error,'synthetic_mismatch');
    assert.equal((await f.submit({...correction,synthetic:true})).body.synthetic,true,'corrections cannot erase an established derived marker');
  }finally{await f.close();}
});

test('legacy false derived marker is rebuilt for reads, references and exact replay; withdrawn sources remain unavailable',async()=>{
  const f=await fixture();try{
    const evidence=f.evidence(true),source=await f.submit(evidence);
    const verification=f.verification([{id:evidence.id,version:1}]),submitted=await f.submit(verification);
    // This privileged fixture reproduces the old derived projection only. It
    // does not edit signed bytes, hashes, author IDs, Consent or dependencies.
    await f.db.query("UPDATE verification_events SET context=jsonb_set(context,'{synthetic}','false'::jsonb) WHERE operation_id=$1",
      [verification.operationId]);
    const view=await f.call('/v2/verification-records/read',{type:'verification',id:verification.id,version:1});
    assert.equal(view.status,200);assert.equal(view.body.synthetic,true);assert.equal(view.body.provenance.synthetic,true);
    const status=await f.call('/v2/verification-records/status',{refs:[{type:'verification',id:verification.id,version:1}]});
    assert.equal(status.body.items[0].synthetic,true);
    const ref=await f.access.runAuthorized(f.actor,'evidence',db=>f.verificationRecords.requireReferenceWithin(db,f.actor,
      {kind:'verification',id:verification.id,version:1},{caseId:f.caseId}));
    assert.equal(ref.synthetic,true);
    const capsuleSource=await f.access.runAuthorized(f.actor,'capsule',db=>f.capsules.v2.sourceWithin(db,f.actor,
      {kind:'verification',id:verification.id,version:1,caseId:f.caseId}));
    assert.equal(capsuleSource.synthetic,true,'formal Capsule source validation receives the effective source marker');
    const history=await f.history.v2.query(f.actor,{subjectId:f.actor.subjectId});
    const historyCase=history.items.find(item=>item.caseId===f.caseId);
    assert.equal(historyCase.synthetic,false,'one synthetic source does not mark the whole Case');
    assert.equal(historyCase.verificationRecords.find(item=>item.id===verification.id).synthetic,true);
    assert.equal((await f.db.query('SELECT context FROM verification_events WHERE operation_id=$1',[verification.operationId])).rows[0].context.synthetic,false,
      'source projections are rebuilt without rewriting old stored metadata');
    const replay=await f.call('/v2/verification-records/submit',submitted.request);
    assert.equal(replay.status,200);assert.equal(replay.body.synthetic,true);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM verification_events WHERE object_id=$1',[verification.id])).rows[0].count),1);
    await f.consents.revoke(f.actor,source.request.consentId);
    const withdrawn=await f.call('/v2/verification-records/read',{type:'verification',id:verification.id,version:1});
    assert.equal(withdrawn.status,200);assert.equal(withdrawn.body.record,null);
    assert.equal(withdrawn.body.referenceStatus,'dependency-unavailable');assert.equal(withdrawn.body.synthetic,undefined);
    await assert.rejects(f.access.runAuthorized(f.actor,'evidence',db=>f.verificationRecords.requireReferenceWithin(db,f.actor,
      {kind:'verification',id:verification.id,version:1},{caseId:f.caseId})),error=>error.code==='consent_required');
    const deniedReplay=await f.call('/v2/verification-records/submit',submitted.request);
    assert.equal(deniedReplay.status,409);assert.equal(deniedReplay.body.error,'consent_required');
    assert.equal(Number((await f.db.query('SELECT count(*) FROM verification_events WHERE object_id=$1',[verification.id])).rows[0].count),1);
    assert.equal((await f.cases.getV2(f.actor,f.caseId)).synthetic,false);
  }finally{await f.close();}
});

test('a legacy effective synthetic Verification cannot be corrected into a false marker by replacing its Evidence',async()=>{
  const f=await fixture();try{
    const evidence=f.evidence(true),source=await f.submit(evidence);
    const verification=f.verification([{id:evidence.id,version:1}]);await f.submit(verification);
    await f.db.query("UPDATE verification_events SET context=jsonb_set(context,'{synthetic}','false'::jsonb) WHERE operation_id=$1",[verification.operationId]);
    const unrelated=f.evidence(false);await f.submit(unrelated);
    const correction={...verification,operationId:randomUUID(),expectedVersion:1,reason:'只更换证据不能洗去原标记',
      evidenceRefs:[{id:unrelated.id,version:1}]};
    const denied=await f.call('/v2/verification-records/submit',await f.authorize(correction,'evidence.submit',{objectId:correction.operationId}));
    assert.equal(denied.status,422,'effective legacy provenance must remain monotonic');assert.equal(denied.body.error,'synthetic_mismatch');
    await f.consents.revoke(f.actor,source.request.consentId);
    const unknown=await f.call('/v2/verification-records/submit',await f.authorize(correction,'evidence.submit',{objectId:correction.operationId}));
    assert.equal(unknown.status,409);assert.equal(unknown.body.error,'consent_required');
    const explicit=await f.submit({...correction,synthetic:true});assert.equal(explicit.body.synthetic,true);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM verification_events WHERE object_id=$1',[verification.id])).rows[0].count),2);
    assert.equal((await f.cases.getV2(f.actor,f.caseId)).synthetic,false);
  }finally{await f.close();}
});
