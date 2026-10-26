import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { digest } from '../src/shared/digest.mjs';
import { transaction } from "../src/infrastructure/database.mjs";
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { createBindingManagementClient } from "../src/clients/binding-status.mjs";
import { createIncidentController } from '../src/operations/incident.mjs';
import { createRetirementController } from "../src/privacy/retirement.mjs";
import { retirementFixturePolicy } from './retirement-workflow.mjs';

export async function verifyBindingManagement(database=null,options={}){
  const scopes=['binding','consent','case-teaser'],f=await serviceFixture(scopes,database,options),endpoint=f.bindings.endpoint;
  let api;
  try{
    const bind=async installationId=>{
      const challenge=await f.bindings.challenge({subjectId:f.genesis.id,genesisProof:f.genesis.genesisProof,installationId,scopes});
      const input={...challenge,signature:await f.signForTest(challenge.challenge,'galaxy-binding-response+jws')};delete input.challengeId;
      const [a,b]=await Promise.all([f.bindings.bind(input),f.bindings.bind(input)]);assert.deepEqual(a,b);
      const token=randomBytes(32).toString('base64url'),session=await f.access.challenge({bindingId:a.bindingId,credentialHash:digest(token)});
      await f.access.activate({...session,signature:await f.signForTest(session.challenge,'galaxy-session-response+jws')});
      return {bindingId:a.bindingId,token,actor:await f.access.authenticate(token)};
    };
    const installation=randomUUID(),[lost,another]=await Promise.all([bind(installation),bind(installation)]);
    assert.notEqual(lost.bindingId,another.bindingId);
    const owned=await f.bindings.query(f.actor);assert.equal(owned.items.length,3);
    assert.equal(owned.items.filter(row=>row.installationId===installation).length,2);
    assert.equal((await f.bindings.query(f.actor,{installationId:installation})).items.length,2);
    const first=await f.bindings.query(f.actor,{limit:1}),second=await f.bindings.query(f.actor,{limit:1,after:first.nextAfter});
    const third=await f.bindings.query(f.actor,{limit:1,after:second.nextAfter});
    assert.deepEqual([first,second,third].map(p=>p.items[0].bindingId),owned.items.map(row=>row.bindingId));assert.equal(third.nextAfter,null);
    const foreign=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false});
    assert.equal((await f.bindings.query(f.actor,{bindingId:foreign.actor.bindingId})).items.length,0);
    await assert.rejects(f.bindings.revoke(foreign.actor.bindingId,f.actor.subjectId,randomUUID(),null,f.actor),/not_found/);
    await assert.rejects(f.bindings.query({...f.actor,credentialHash:'0'.repeat(64)}),/access_denied/);
    await assert.rejects(f.bindings.query(f.actor,{subjectId:foreign.actor.subjectId}),/invalid_binding_query/);

    const payloadJson=JSON.stringify({title:'Lost-installation dependent grant'}),objectId=randomUUID();
    const intent={version:1,id:randomUUID(),subjectId:f.actor.subjectId,bindingId:lost.bindingId,endpoint,objectId,
      action:'case.teaser.publish',purpose:'operational',recipient:endpoint,fields:['title'],visibility:'Private',viewers:[],
      payloadHash:digest(payloadJson),policyVersion:'0.1',issuedAt:f.now,expiresAt:f.now+3600};
    await f.consents.create(lost.actor,await f.signForTest(JSON.stringify(intent),'galaxy-consent+jws'));
    const usage={id:intent.id,subjectId:f.actor.subjectId,objectId,action:intent.action,recipient:endpoint,payloadJson};
    await transaction(f.db,db=>f.consents.require(db,usage));
    const sessions=createSessionMemory({isCurrent:async()=>true,now:()=>f.now});
    sessions.adopt({endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,scopes,expiresAt:f.now+600,bindingExpiresAt:f.now+86400,takeCredential:()=>f.credential});
    const incident=createIncidentController({version:1,id:'binding-containment',revision:1,endpoint,state:'contained',updatedAt:f.now,publicMessage:'Synthetic incident'}, {endpoint,now:()=>f.now});
    const retirement=createRetirementController(retirementFixturePolicy(f.now),{endpoint,now:()=>f.now+30});
    api=createApi({...f,incident,retirement});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${api.address().port}`;
    let writes=0;
    const send=async(url,input)=>{
      const path=new URL(url).pathname;if(path.endsWith('/revoke'))writes++;
      const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.credential}`},body:input.bodyJson,signal:input.signal});
      const result=await response.json();if(response.status!==200){const error=new Error(result.error);if(response.status===401)error.code='GALAXY_REMOTE_REJECTED';throw error;}return result;
    };
    const client=createBindingManagementClient({endpoint,sessions,send});
    const page=await client.query({installationId:installation});assert.equal(page.items.length,2);
    const preview=await client.prepareRevoke(lost.bindingId);assert.equal(writes,0);assert.ok(preview.previewJson.includes(installation));
    assert.ok(!preview.previewJson.includes(f.credential));assert.equal(preview.currentSession,false);
    await assert.rejects(client.executeRevoke(preview,'incorrect'),/Exact binding revocation/);assert.equal(writes,0);
    const result=await client.executeRevoke(preview,preview.confirmation);assert.equal(result.currentSessionEnded,false);
    await assert.rejects(client.executeRevoke(preview,preview.confirmation),/Exact binding revocation/);
    await assert.rejects(f.access.authenticate(lost.token),/access_denied/);
    await assert.rejects(transaction(f.db,db=>f.consents.require(db,usage)),/consent_required/);
    assert.equal((await f.access.authenticate(another.token)).bindingId,another.bindingId);
    assert.equal((await client.query({bindingId:lost.bindingId})).items[0].state,'revoked');
    assert.equal((await sessions.status(endpoint)).state,'session-local');
    const audit=(await f.db.query("SELECT caller_binding_id,caller_client_id,client_id FROM audit_events WHERE action='binding.revoke' AND object_id=$1",[lost.bindingId])).rows;
    assert.equal(audit.length,1);assert.equal(audit[0].caller_binding_id,f.actor.bindingId);assert.equal(audit[0].client_id,installation);
    assert.notEqual(audit[0].caller_client_id,installation);
    const own=await client.prepareRevoke(f.actor.bindingId);assert.equal(own.currentSession,true);
    assert.equal((await client.executeRevoke(own,own.confirmation)).currentSessionEnded,true);
    assert.equal((await sessions.status(endpoint)).state,'disconnected');
    await assert.rejects(f.bindings.query(f.actor),/access_denied/);
    assert.equal((await f.bindings.query(another.actor)).items.length,3);
    return {installationFiltering:true,pagination:true,crossUserIsolation:true,concurrentIdempotentBinding:true,
      crossBindingRevocation:true,dependentGrantRevoked:true,unrelatedBindingPreserved:true,selfSessionClosed:true,incidentAndTakeoutSupported:true};
  }finally{if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}if(!database)await f.db.close();}
}
