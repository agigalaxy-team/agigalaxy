import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { builderDeclaration } from './builders-workflow.mjs';
import { createApi } from '../src/http.mjs';
import { createBuilderClient, verifyConformance } from '../src/builder-client.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { digest } from '../src/shared/digest.mjs';

export async function verifyConformanceWorkflow(db=null,options={}) {
  const scopes=['binding','consent','builders'];
  const f=await serviceFixture(scopes,db,options),a=await serviceFixture(scopes,f.db,options),other=await serviceFixture(scopes,f.db,options);
  f.builders.assessorIds.add(a.actor.subjectId);
  const suite={name:'A2A fixture suite',version:'1.0',sha256:'a'.repeat(64),source:'https://suite.example.org/v1'};
  const pin={...suite,notBefore:f.now-1,notAfter:f.now+7200,revoked:false};
  f.builders.suitePins=[pin];
  let serviceError;
  const exportReport=f.builders.exportReport.bind(f.builders);
  f.builders.exportReport=async(...args)=>{try{return await exportReport(...args);}catch(error){serviceError=error;throw error;}};
  const api=createApi({...f,rateLimit:200}); await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`,endpoint=f.bindings.endpoint;
  const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});
  sessions.adopt({endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>f.credential});
  const send=async(url,input)=>{const response=await fetch(origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.credential}`},body:input.bodyJson,signal:input.signal});
    const result=await response.json(); if(response.status===500&&serviceError)throw serviceError;
    if(response.status!==200)throw new Error(JSON.stringify(result)); return result;};
  const client=createBuilderClient({endpoint,sessions,send,trustedKeys:f.bindings.trustedKeys,now:()=>f.now});
  async function publish(who,payload,visibility='Public',viewers=[]) {
    const consent=await who.authorize(payload,'builder.publish',{visibility,viewers,purpose:visibility==='Public'?'public-profile':'operational'});
    await f.builders.publish(who.actor,consent); return consent;
  }
  async function declare(visibility='Public') {
    const payload={kind:'declare',id:randomUUID(),builderId:randomUUID(),expectedRevision:0,declaration:builderDeclaration('bridge',f.actor.subjectId)};
    await publish(f,payload,visibility,visibility==='Private'?[a.actor.subjectId]:[]);return payload;
  }
  async function report(root,visibility='Public',failed=false,v2=false) {
    const current=await f.builders.get(a.actor,{builderId:root.builderId});
    const payload={kind:'compatibility',id:randomUUID(),builderId:root.builderId,expectedRevision:current.revision,
      declarationId:current.declarationId,declarationHash:current.declarationHash,suite,observedAt:f.now,expiresAt:f.now+3600,
      ...(v2?{profile:'galaxy-conformance/2'}:{}),
      checks:(v2?['ids','evidence','signatures','schema','import','privacy','revocation']:['ids','schema','signatures','import','privacy','revocation']).map(id=>({id,status:failed&&id==='import'?'fail':'pass',detail:`Synthetic fixture ${id}`})),
      limitations:'Assessor report for fixture only; no independent capability verification.'};
    const consent=await publish(a,payload,visibility,visibility==='Private'?[f.actor.subjectId]:[]);
    return {payload,consent};
  }
  try {
    const root=await declare(),first=await report(root),input={builderId:root.builderId,reportId:first.payload.id};
    const snapshot=await client.exportReport(input);
    assert.equal(snapshot.currentRevocationChecked,true); assert.equal(snapshot.data.reportHash,digest(JSON.stringify(snapshot.data.report)));
    assert.equal(snapshot.data.sourceEventHash,digest(JSON.stringify(first.payload)));
    assert.deepEqual(snapshot.coverage.missing,['evidence']);
    assert.equal((await client.get({builderId:root.builderId})).compatibility.fullScopeState,'incomplete');
    assert.equal(snapshot.data.release.buildHash,root.declaration.release.buildHash);
    assert.equal(snapshot.data.capabilityVerified,false);assert.equal(snapshot.data.independentExecutionVerified,false);
    const offline=await verifyConformance(snapshot.signed,{endpoint,trustedKeys:f.bindings.trustedKeys,now:f.now,...input});
    assert.equal(offline.currentRevocationChecked,false);
    await assert.rejects(verifyConformance(snapshot.signed,{endpoint,trustedKeys:f.bindings.trustedKeys,now:f.now+301,...input}));
    await assert.rejects(verifyConformance(snapshot.signed,{endpoint,trustedKeys:f.bindings.trustedKeys,now:f.now,...input,reportId:randomUUID()}));
    const parts=snapshot.signed.split('.');parts[1]=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(parts[1],'base64url')),data:{}})).toString('base64url');
    await assert.rejects(verifyConformance(parts.join('.'),{endpoint,trustedKeys:f.bindings.trustedKeys,now:f.now,...input}));
    const audits=(await f.db.query("SELECT * FROM audit_events WHERE action='builder.export' AND object_id=$1 ORDER BY sequence",[first.payload.id])).rows;
    assert.equal(audits.length,1);assert.equal(audits[0].actor,f.actor.subjectId);assert.equal(audits[0].binding_id,a.actor.bindingId);
    assert.equal(audits[0].caller_binding_id,f.actor.bindingId);assert.ok(audits[0].http_request_id);
    const anonymous=await fetch(origin+'/v1/builders/reports/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    assert.equal(anonymous.status,401);
    pin.sha256='b'.repeat(64);assert.equal((await client.get({builderId:root.builderId})).compatibility.state,'unverified');
    await assert.rejects(client.exportReport(input),/unavailable/);pin.sha256=suite.sha256;
    pin.revoked=true;await assert.rejects(client.exportReport(input),/unavailable/);pin.revoked=false;
    pin.notAfter=f.now;await assert.rejects(client.exportReport(input),/unavailable/);pin.notAfter=f.now+7200;
    f.builders.suitePins=[];await assert.rejects(client.exportReport(input),/unavailable/);f.builders.suitePins=[pin];
    f.bindings.trustedKeys.get('fixture').revoked=true;
    await assert.rejects(verifyConformance(snapshot.signed,{endpoint,trustedKeys:f.bindings.trustedKeys,now:f.now,...input}));
    await assert.rejects(client.exportReport(input),/signing_unavailable/);
    f.bindings.trustedKeys.get('fixture').revoked=false;
    const failed=await report(root,'Public',true),failedInput={builderId:root.builderId,reportId:failed.payload.id};
    await assert.rejects(client.exportReport(input),/unavailable/);
    assert.equal((await client.exportReport(failedInput)).data.report.checks.find(c=>c.id==='import').status,'fail');
    await f.consents.revoke(a.actor,failed.consent.consentId);await assert.rejects(client.exportReport(failedInput),/unavailable/);
    assert.equal((await client.get({builderId:root.builderId})).compatibility.state,'unverified');
    const fresh=await report(root),freshInput={builderId:root.builderId,reportId:fresh.payload.id};
    const current=await client.get({builderId:root.builderId});
    await publish(f,{...root,id:randomUUID(),expectedRevision:current.revision,declaration:{...root.declaration,name:'Changed source'}});
    await assert.rejects(client.exportReport(freshInput),/unavailable/);
    const privateRoot=await declare('Private'),privateReport=await report(privateRoot,'Private');
    const privateInput={builderId:privateRoot.builderId,reportId:privateReport.payload.id};
    await assert.rejects(f.builders.exportReport(other.actor,privateInput),/unavailable/);
    assert.equal((await client.exportReport(privateInput)).data.report.id,privateReport.payload.id);
    const complete=await report(privateRoot,'Private',false,true);
    const full=await client.exportReport({builderId:privateRoot.builderId,reportId:complete.payload.id});
    assert.equal(full.coverage.complete,true);assert.equal(full.data.version,2);assert.equal(full.data.report.profile,'galaxy-conformance/2');
    assert.equal((await client.get({builderId:privateRoot.builderId})).compatibility.fullScopeState,'reported-pass');
    await f.db.query('UPDATE bindings SET revoked_at=to_timestamp($2) WHERE id=$1',[a.actor.bindingId,f.now]);
    await assert.rejects(client.exportReport({builderId:privateRoot.builderId,reportId:complete.payload.id}),/unavailable/);
  } finally { await new Promise(resolve=>api.close(resolve)); if(!db)await f.db.close(); }
}
