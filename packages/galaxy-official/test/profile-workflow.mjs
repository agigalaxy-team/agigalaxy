import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createHistoryClient } from "../src/clients/history.mjs";
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";

export async function verifyProfileWorkflow(database=null,options={}){
  const scopes=['binding','consent','history','case-teaser','data-export'];
  const f=await serviceFixture(scopes,database,options),other=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false});
  const api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`,endpoint=f.access.endpoint;
  const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});
  sessions.adopt({endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>f.credential});
  const client=createHistoryClient({endpoint,sessions,send:async(url,input)=>{
    const response=await fetch(origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.credential}`},body:input.bodyJson,signal:input.signal});
    const data=await response.json();if(response.status!==200)throw new Error(data.error);return data;
  }});
  const publicView=async()=>{const response=await fetch(origin+'/v1/profiles/'+f.actor.subjectId);assert.equal(response.status,200);return response.json();};
  try{
    const empty=await client.profile(f.actor.subjectId);
    assert.deepEqual(empty.selfDeclared,{});assert.deepEqual(empty.items,[]);assert.equal(empty.selfDeclaredRevision,0);
    const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'Actual facts',summary:'Reported failure',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(root,'case.teaser.publish',{visibility:'Public',purpose:'public-profile'}));
    const factBefore=(await client.profile(f.actor.subjectId)).items[0].rebuild.contentHash;
    const statement={id:randomUUID(),expectedRevision:0,selfDeclared:{displayName:'Fixture person',about:'Self description',claimedCapabilities:['Expert compiler debugging']}};
    const grant=await f.authorize(statement,'profile.publish',{visibility:'Public',purpose:'public-profile'});
    const receipt=await client.publishProfile(grant);assert.equal(receipt.revision,1);
    assert.deepEqual(await client.publishProfile(grant),receipt);
    const published=await publicView();assert.deepEqual(published.selfDeclared,statement.selfDeclared);
    assert.equal(published.selfDeclaredSource.classification,'self-declared');assert.equal(published.capabilityVerified,false);
    assert.equal(published.selfDeclaredRevision,undefined);
    assert.equal((await client.profile(f.actor.subjectId)).items[0].rebuild.contentHash,factBefore);
    const injected={id:randomUUID(),expectedRevision:1,selfDeclared:{honor:'certified',capabilityVerified:true}};
    const injectedGrant=await f.authorize(injected,'profile.publish');
    await assert.rejects(f.profiles.publish(f.actor,injectedGrant),/invalid_profile_statement/);
    await assert.rejects(f.profiles.publish(other.actor,grant),/consent_required/);
    const stale={...statement,id:randomUUID()};
    await assert.rejects(f.profiles.publish(f.actor,await f.authorize(stale,'profile.publish')),/profile_revision_conflict/);
    const privateStatement={id:randomUUID(),expectedRevision:1,selfDeclared:{about:'Private replacement'}};
    const privateGrant=await f.authorize(privateStatement,'profile.publish',{viewers:[other.actor.subjectId]});
    await client.publishProfile(privateGrant);
    assert.deepEqual((await publicView()).selfDeclared,{});
    assert.deepEqual((await f.history.query(other.actor,{subjectId:f.actor.subjectId})).selfDeclared,privateStatement.selfDeclared);
    await f.consents.revoke(f.actor,privateGrant.consentId);
    assert.deepEqual((await client.profile(f.actor.subjectId)).selfDeclared,{});
    assert.equal((await client.profile(f.actor.subjectId)).selfDeclaredRevision,2);
    assert.deepEqual((await publicView()).selfDeclared,{},'revocation never resurrects old public statements');
    const cleared={id:randomUUID(),expectedRevision:2,selfDeclared:{}};
    await client.publishProfile(await f.authorize(cleared,'profile.publish'));
    assert.equal((await client.profile(f.actor.subjectId)).selfDeclaredRevision,3);
    const exported=await f.dataExport.create(f.actor,{id:randomUUID(),datasets:['profile-statements']});
    const page=await f.dataExport.page(f.actor,{id:exported.id,dataset:'profile-statements'});
    assert.equal(page.items.length,3);assert.ok(page.items.every(item=>item.subject_id===f.actor.subjectId));
    const foreign=await f.dataExport.create(other.actor,{id:randomUUID(),datasets:['profile-statements']});
    assert.equal((await f.dataExport.page(other.actor,{id:foreign.id,dataset:'profile-statements'})).items.length,0);
    const audit=(await f.db.query("SELECT * FROM audit_events WHERE actor=$1 AND action='profile.publish' ORDER BY sequence",[f.actor.subjectId])).rows;
    assert.equal(audit.length,3,'exact Profile replay does not add an audit event');
    assert.ok(audit.every(row=>row.context_version===1&&row.scope==='history'&&row.consent_id&&row.binding_id===f.actor.bindingId
      &&row.caller_binding_id===f.actor.bindingId&&row.client_id&&row.audience===endpoint&&row.http_request_id&&row.idempotency_key===row.object_id));
    assert.ok(audit.every(row=>JSON.stringify(row.credential_scopes)===JSON.stringify(scopes)));
    for(const value of ['Private replacement','Expert compiler debugging',f.credential,f.actor.credentialHash])assert.ok(!JSON.stringify(audit).includes(value));
  }finally{sessions.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!database)await f.db.close();}
}
