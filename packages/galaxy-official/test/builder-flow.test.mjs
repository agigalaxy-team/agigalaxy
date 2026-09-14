import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/http.mjs';
import { serviceFixture } from './service-fixture.mjs';
import { builderDeclaration } from './builders-workflow.mjs';
import { createBuilderFlow } from '../src/builder-flow.mjs';
import { createBuilderClient } from '../src/builder-client.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createHostConnectionController } from '../src/host-connection-controller.mjs';
test('builder host flow signs one reviewed payload, derives private report recipients and refuses stale edits',async()=>{
  const scopes=['binding','consent','builders'],f=await serviceFixture(scopes),a=await serviceFixture(scopes,f.db);
  f.builders.assessorIds.add(a.actor.subjectId);
  const api=createApi({...f,rateLimit:200});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`,endpoint=f.bindings.endpoint,memories=[];
  const send=async(url,input)=>{const response=await fetch(origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.credential}`},body:input.bodyJson,signal:input.signal});
    const result=await response.json();if(response.status!==200)throw new Error(JSON.stringify(result));return result;};
  function host(who){const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});memories.push(sessions);
    sessions.adopt({endpoint,subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>who.credential});
    const flow=createBuilderFlow({endpoint,sessions,signIntent:async(payload,typ)=>{assert.equal(flow.isSigningIntent(payload),true);return who.signForTest(payload,typ);},builderSend:send,consentSend:send,now:()=>f.now});
    return createHostConnectionController({endpoint,sessions,builderClient:createBuilderClient({endpoint,sessions,send}),builderFlow:flow});
  }
  const owner=host(f),assessor=host(a);
  const execute=async(host,input)=>{const p=await host.prepareBuilder(input);return {preview:p,receipt:await host.executeBuilder(p,p.confirmation)};};
  try{
    const input={kind:'declare',declaration:builderDeclaration('worker',f.actor.subjectId),viewers:[a.actor.subjectId]};
    const canceled=await owner.prepareBuilder(input);
    assert.equal((await f.db.query('SELECT * FROM consents')).rows.length,0);
    await assert.rejects(owner.queryBuilders({}),/unavailable/);owner.cancel();await assert.rejects(owner.executeBuilder(canceled,canceled.confirmation));
    const created=await execute(owner,input),builderId=created.receipt.builderId;
    const current=await owner.getBuilder({builderId});assert.equal(current.disclosure.visibility,'Private');
    const report={kind:'compatibility',builderId,baseDeclarationId:current.declarationId,suite:{name:'Synthetic',version:'1',sha256:'a'.repeat(64),source:'https://fixture.example/suite'},
      observedAt:f.now,expiresAt:f.now+600,checks:['ids','schema','signatures','import','privacy','revocation'].map(id=>({id,status:'pass',detail:'Synthetic result'})),limitations:'Assessor-reported fixture'};
    await assert.rejects(owner.prepareBuilder(report),/assessor required/);
    const submitted=await execute(assessor,report),intent=JSON.parse(submitted.preview.intentJson);
    assert.deepEqual(intent.viewers,[f.actor.subjectId]);assert.equal(intent.visibility,'Private');
    assert.equal((await owner.getBuilder({builderId})).compatibility.state,'reported-pass');
    await execute(owner,{...input,builderId,baseDeclarationId:current.declarationId,declaration:{...input.declaration,name:'Revised worker'}});
    await assert.rejects(owner.prepareBuilder({...input,builderId,baseDeclarationId:current.declarationId}),/declaration changed/);
    await assert.rejects(assessor.prepareBuilder(report),/declaration changed/);
    const updated=await owner.getBuilder({builderId});assert.equal(updated.compatibility.state,'unverified');
    await execute(owner,{kind:'maintenance',builderId,baseDeclarationId:updated.declarationId,action:'delist',summary:'Fixture delist'});
    assert.equal((await owner.getBuilder({builderId})).registration.state,'delisted');
    await execute(owner,{kind:'maintenance',builderId,action:'relist',summary:'Fixture relist'});
    const target={protocol:'a2a/1.0',transport:'JSONRPC',endpoint:'https://worker.example/a2a',cardUrl:'https://worker.example/.well-known/agent-card.json',tenant:''};
    await execute(owner,{...input,builderId,declaration:{...input.declaration,a2a:target}});
    await execute(owner,{kind:'node-control',builderId});
    await assert.rejects(assessor.prepareBuilder({kind:'probe-request',builderId}),/required/);
    const probe=await owner.prepareBuilder({kind:'probe-request',builderId});
    assert.deepEqual(JSON.parse(probe.payloadJson).target,target);assert.equal(JSON.parse(probe.intentJson).visibility,'Private');
    owner.cancel();await assert.rejects(owner.executeBuilder(probe,probe.confirmation));
    await execute(owner,{kind:'probe-request',builderId});assert.equal((await owner.getBuilder({builderId})).reachability.state,'pending');
    const pending=await owner.prepareBuilder({kind:'heartbeat',builderId});owner.disconnect();await assert.rejects(owner.executeBuilder(pending,pending.confirmation));
  }finally{owner.cancel();assessor.cancel();memories.forEach(m=>m.close());api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}
});
