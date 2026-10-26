import assert from 'node:assert/strict';
import { randomUUID,verify } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { builderDeclaration } from './builders-workflow.mjs';
import { createApi } from '../src/http.mjs';
import { createBuilderClient,verifyNodeControlSnapshot,verifyNodeControlProof } from "../src/clients/builder.mjs";
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { createNodeControlProofFlow } from "../src/clients/flows/node-control-proof.mjs";

export async function verifyNodeControlProofWorkflow(database=null,options={}){
  const scopes=['binding','consent','builders'],f=await serviceFixture(scopes,database,options),node=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false}),other=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false});
  const api=createApi({...f,rateLimit:300});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const endpoint=f.access.endpoint,origin=`http://127.0.0.1:${api.address().port}`,memories=[];
  const request=(input,credential)=>fetch(origin+'/v1/builders/node-control/export',{method:'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(input)});
  let signs=0;
  function host(who){
    const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});memories.push(sessions);
    sessions.adopt({endpoint,subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>who.credential});
    const builders=createBuilderClient({endpoint,sessions,trustedKeys:f.bindings.trustedKeys,now:()=>f.now,send:async(url,input)=>{
      const response=await fetch(origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.credential}`},body:input.bodyJson,signal:input.signal});
      const result=await response.json();if(!response.ok)throw new Error(result.error??'Fixture HTTP failed');return result;
    }});
    return {builders,flow:createNodeControlProofFlow({endpoint,sessions,builders,trustedKeys:f.bindings.trustedKeys,now:()=>f.now,signProof:async(payload,typ)=>{signs++;return {signed:await who.signForTest(payload,typ),genesisProof:who.genesis.genesisProof};}})};
  }
  const owner=host(f),holder=host(node);
  const send=async(who,event,visibility='Public',viewers=[])=>{const grant=await who.authorize(event,'builder.publish',{visibility,viewers,purpose:visibility==='Public'?'public-profile':'operational'});await f.builders.publish(who.actor,grant);return grant;};
  async function pair(visibility='Public'){
    const root={id:randomUUID(),builderId:randomUUID(),kind:'declare',expectedRevision:0,declaration:builderDeclaration('worker',node.actor.subjectId)};
    const rootGrant=await send(f,root,visibility,visibility==='Private'?[node.actor.subjectId]:[]);
    const current=await f.builders.get(node.actor,{builderId:root.builderId});
    const control={kind:'node-control',id:randomUUID(),builderId:root.builderId,expectedRevision:1,ownerId:f.actor.subjectId,nodeId:node.actor.subjectId,
      declarationId:root.id,declarationHash:current.declarationHash,expiresAt:f.now+600};
    const grant=await send(node,control,visibility,visibility==='Private'?[f.actor.subjectId]:[]);
    return {root,control,rootGrant,grant,input:{builderId:root.builderId,controlId:control.id}};
  }
  try{
    const item=await pair(),snapshot=await owner.builders.exportNodeControl(item.input),verifyOptions={endpoint,trustedKeys:f.bindings.trustedKeys,now:f.now,...item.input};
    assert.equal(snapshot.currentRevocationChecked,true);assert.equal(snapshot.nodeSignatureVerified,false);assert.equal(snapshot.expiresAt,f.now+300);
    assert.equal((await verifyNodeControlSnapshot(snapshot.signed,verifyOptions)).currentRevocationChecked,false);
    assert.equal((await request(item.input)).status,401);
    await assert.rejects(owner.flow.prepare(item.input),/Node key holder/);assert.equal(signs,0);
    const canceled=await holder.flow.prepare(item.input);holder.flow.cancel(canceled);await assert.rejects(holder.flow.execute(canceled,canceled.confirmation));assert.equal(signs,0);
    const preview=await holder.flow.prepare(item.input);assert.equal(signs,0);
    const result=await holder.flow.execute(preview,preview.confirmation),checked=await verifyNodeControlProof(result.proof,verifyOptions);
    assert.equal(signs,1);assert.equal(checked.nodeSignatureVerified,true);assert.equal(checked.data.nodeId,node.actor.subjectId);assert.equal(checked.data.ownerId,f.actor.subjectId);
    const [header,payload,signature]=result.proof.nodeSigned.split('.');
    assert.equal(verify(null,Buffer.from(header+'.'+payload),node.genesis.genesisProof.publicKeyPem,Buffer.from(signature,'base64url')),true);
    await assert.rejects(verifyNodeControlProof({...result.proof,genesisProof:other.genesis.genesisProof},verifyOptions));
    await assert.rejects(verifyNodeControlProof(result.proof,{...verifyOptions,controlId:randomUUID()}));
    await assert.rejects(verifyNodeControlProof(result.proof,{...verifyOptions,endpoint:'https://other.example.org'}));
    await assert.rejects(verifyNodeControlProof(result.proof,{...verifyOptions,now:f.now+301}));
    const altered={...JSON.parse(Buffer.from(payload,'base64url')),ownerId:other.actor.subjectId};
    await assert.rejects(verifyNodeControlProof({...result.proof,nodeSigned:[header,Buffer.from(JSON.stringify(altered)).toString('base64url'),signature].join('.')},verifyOptions));
    await assert.rejects(f.consents.create(node.actor,result.proof.nodeSigned),/invalid_consent/);
    const audit=(await f.db.query("SELECT actor,binding_id,caller_binding_id FROM audit_events WHERE action='builder.node-control.export' AND object_id=$1 ORDER BY sequence",[item.control.id])).rows;
    assert.equal(audit[0].actor,f.actor.subjectId);assert.equal(audit[0].binding_id,node.actor.bindingId);assert.equal(audit[0].caller_binding_id,f.actor.bindingId);
    const stale=await holder.flow.prepare(item.input);
    await send(f,{id:randomUUID(),builderId:item.root.builderId,expectedRevision:2,kind:'node-control-revoke',declarationId:item.root.id,controlId:item.control.id,reason:'Owner revoked'});
    await assert.rejects(owner.builders.exportNodeControl(item.input));await assert.rejects(holder.flow.execute(stale,stale.confirmation));assert.equal(signs,1);
    // Previously issued offline signatures remain historical snapshots until expiry.
    assert.equal((await verifyNodeControlProof(result.proof,verifyOptions)).currentRevocationChecked,false);
    const privateItem=await pair('Private');assert.equal((await request(privateItem.input,other.credential)).status,404);
    assert.equal((await owner.builders.exportNodeControl(privateItem.input)).data.id,privateItem.control.id);
    await f.consents.revoke(node.actor,privateItem.grant.consentId);await assert.rejects(owner.builders.exportNodeControl(privateItem.input));
    const replacement=await pair();await send(f,{...replacement.root,id:randomUUID(),expectedRevision:2,declaration:{...replacement.root.declaration,name:'Changed release'}});
    await assert.rejects(owner.builders.exportNodeControl(replacement.input));
    const expiring=await pair();await (options.adminDatabase??f.db).query('UPDATE bindings SET expires_at=$2 WHERE id=$1',[node.actor.bindingId,new Date((f.now+50)*1000).toISOString()]);
    assert.equal((await owner.builders.exportNodeControl(expiring.input)).expiresAt,f.now+50);
    await f.bindings.revoke(node.actor.bindingId,node.actor.subjectId,randomUUID(),null,node.actor);await assert.rejects(owner.builders.exportNodeControl(expiring.input));
    return {directNodeSignature:true,registrySnapshot:true,offlineRevocationChecked:false};
  }finally{memories.forEach(memory=>memory.close());api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!database)await f.db.close();}
}
