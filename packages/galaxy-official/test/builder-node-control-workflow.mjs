import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { builderDeclaration } from './builders-workflow.mjs';
import { createApi } from '../src/http.mjs';
import { createBuilderClient } from "../src/clients/builder.mjs";
import { createBuilderFlow } from "../src/clients/flows/builder.mjs";
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";

export async function verifyBuilderNodeControl(db=null,options={}){
  const scopes=['binding','consent','builders'],f=await serviceFixture(scopes,db,options),node=await serviceFixture(scopes,f.db,options),other=await serviceFixture(scopes,f.db,options);
  const api=createApi({...f,rateLimit:200});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const endpoint=f.bindings.endpoint,origin=`http://127.0.0.1:${api.address().port}`,memories=[];
  const send=async(url,input)=>{const response=await fetch(origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.credential}`},body:input.bodyJson,signal:input.signal});
    const value=await response.json();if(response.status!==200)throw new Error(JSON.stringify(value));return value;};
  function host(who){const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});memories.push(sessions);
    sessions.adopt({endpoint,subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>who.credential});
    const client=createBuilderClient({endpoint,sessions,send}),flow=createBuilderFlow({endpoint,sessions,signIntent:who.signForTest,builderSend:send,consentSend:send,now:()=>f.now});
    return {client,flow,async execute(input){const preview=await flow.prepare(input);return {preview,receipt:await flow.execute(preview,preview.confirmation)};}};
  }
  const owner=host(f),holder=host(node);
  try{
    const declaration=builderDeclaration('worker',node.actor.subjectId);
    const created=await owner.execute({kind:'declare',declaration,visibility:'Public'}),builderId=created.receipt.builderId;
    const current=await owner.client.get({builderId});
    assert.equal(current.nodeControl.state,'unverified');assert.equal(current.nodeControlDisclosure,undefined);
    await assert.rejects(owner.flow.prepare({kind:'node-control',builderId}),/required/);
    const forged={id:randomUUID(),builderId,kind:'node-control',expectedRevision:current.revision,declarationId:current.declarationId,
      declarationHash:current.declarationHash,ownerId:f.actor.subjectId,nodeId:node.actor.subjectId,expiresAt:f.now+500};
    await assert.rejects(f.builders.publish(other.actor,await other.authorize(forged,'builder.publish',{visibility:'Public',purpose:'public-profile'})),/node_holder_required/);
    const pending=await holder.flow.prepare({kind:'node-control',builderId});holder.flow.cancel(pending);await assert.rejects(holder.flow.execute(pending,pending.confirmation));
    assert.equal((await owner.client.get({builderId})).nodeControl.state,'unverified');
    const approval=await holder.execute({kind:'node-control',builderId,baseDeclarationId:current.declarationId,expiresAt:f.now+100});
    const proved=await f.builders.get(null,{builderId});assert.equal(proved.nodeControl.state,'node-authorized-owner');
    assert.equal(proved.nodeControl.nodeId,node.actor.subjectId);assert.equal(proved.nodeControl.ownerId,f.actor.subjectId);
    assert.equal(proved.nodeControl.capabilityVerified,false);assert.equal(proved.reachability.endpointReachable,null);
    assert.equal((await f.builders.query(null,{ownerId:f.actor.subjectId})).items[0].nodeControl.state,'node-authorized-owner');
    const publishedAgain=await f.builders.publish(node.actor,{consentId:JSON.parse(approval.preview.intentJson).id,payloadJson:approval.preview.payloadJson});
    assert.deepEqual(publishedAgain,approval.receipt);
    f.access.now=()=>f.now+101;assert.equal((await f.builders.get(null,{builderId})).nodeControl.state,'expired');f.access.now=()=>f.now;
    const revoked=await owner.execute({kind:'node-control-revoke',builderId,reason:'Withdraw owner registration authorization'});
    assert.equal((await holder.client.get({builderId})).nodeControl.state,'revoked');
    await f.consents.revoke(f.actor,JSON.parse(revoked.preview.intentJson).id);assert.equal((await f.builders.get(null,{builderId})).nodeControl.state,'revoked');
    const renewed=await holder.execute({kind:'node-control',builderId});
    await f.consents.revoke(node.actor,JSON.parse(renewed.preview.intentJson).id);assert.equal((await f.builders.get(null,{builderId})).nodeControl.state,'unavailable');
    await holder.execute({kind:'node-control',builderId});
    await owner.execute({kind:'declare',builderId,baseDeclarationId:current.declarationId,declaration:{...declaration,name:'Changed declaration'},visibility:'Public'});
    assert.equal((await f.builders.get(null,{builderId})).nodeControl.state,'unverified');
    await assert.rejects(holder.flow.prepare({kind:'node-control',builderId,baseDeclarationId:current.declarationId}),/declaration changed/);
    await holder.execute({kind:'node-control',builderId});
    await holder.execute({kind:'node-control-revoke',builderId,reason:'Node holder revokes approval'});
    assert.equal((await owner.client.get({builderId})).nodeControl.state,'revoked');
    const privateEntry=await owner.execute({kind:'declare',declaration,viewers:[node.actor.subjectId]});
    const privateApproval=await holder.execute({kind:'node-control',builderId:privateEntry.receipt.builderId});
    assert.deepEqual(JSON.parse(privateApproval.preview.intentJson).viewers,[f.actor.subjectId]);
    await assert.rejects(f.builders.get(null,{builderId:privateEntry.receipt.builderId}),/unavailable/);
    assert.equal((await owner.client.get({builderId:privateEntry.receipt.builderId})).nodeControl.state,'node-authorized-owner');
    await holder.execute({kind:'node-control',builderId});
    await f.bindings.revoke(node.actor.bindingId,node.actor.subjectId,randomUUID(),null,node.actor);
    assert.equal((await f.builders.get(null,{builderId})).nodeControl.state,'unavailable');
    const audit=(await f.db.query("SELECT * FROM audit_events WHERE action='builder.event' AND actor=$1",[node.actor.subjectId])).rows;
    assert.ok(audit.length>=6);assert.ok(audit.every(row=>row.context_version===1&&row.scope==='builders'));
  }finally{f.access.now=()=>f.now;memories.forEach(memory=>memory.close());api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!db)await f.db.close();}
}
