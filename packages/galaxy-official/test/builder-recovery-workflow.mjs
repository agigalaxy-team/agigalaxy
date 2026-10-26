import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { builderDeclaration } from './builders-workflow.mjs';
import { createApi } from '../src/http.mjs';
import { createBuilderClient } from "../src/clients/builder.mjs";
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { digest } from '../src/shared/digest.mjs';

export async function verifyBuilderRecovery(database=null,options={}){
  const scopes=['binding','consent','builders'],f=await serviceFixture(scopes,database,options),other=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false});
  const pub={visibility:'Public',purpose:'public-profile'},builderId=randomUUID();let api,sessions;
  const sendEvent=async payload=>{const grant=await f.authorize(payload,'builder.publish',pub);return {...await f.builders.publish(f.actor,grant),grant,payload};};
  try{
    const root={id:randomUUID(),builderId,kind:'declare',expectedRevision:0,declaration:builderDeclaration('worker',f.actor.subjectId)};
    const original=await sendEvent(root);await f.consents.revoke(f.actor,original.grant.consentId);
    api=createApi({...f,rateLimit:200});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${api.address().port}`,request=(path,input,credential)=>fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(input)});
    sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});sessions.adopt({endpoint:f.access.endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,scopes,expiresAt:f.now+600,bindingExpiresAt:f.now+900,takeCredential:()=>f.credential});
    const client=createBuilderClient({endpoint:f.access.endpoint,sessions,send:async(url,input)=>{const response=await request(new URL(url).pathname,JSON.parse(input.bodyJson),input.credential);assert.equal(response.status,200);return response.json();}});
    await assert.rejects(f.builders.get(f.actor,{builderId}));
    const management=await client.manage({builderId});assert.equal(management.declaration,null);assert.equal(management.declarationId,root.id);assert.equal(management.declarationState,'unavailable');
    assert.equal(management.allowedActions.includes('relist'),false);assert.equal((await client.owned()).items.find(row=>row.builderId===builderId).name,null);
    assert.equal((await request('/v1/builders/manage/read',{builderId})).status,401);
    assert.equal((await request('/v1/builders/manage/read',{builderId},other.credential)).status,404);
    const delist=await sendEvent({id:randomUUID(),builderId,kind:'maintenance',expectedRevision:1,declarationId:root.id,action:'delist',summary:'Owner withdrew the unavailable registration'});
    const privateCorrection={id:randomUUID(),builderId,kind:'maintenance',expectedRevision:2,declarationId:root.id,action:'correction',summary:'PRIVATE OWNER NOTE'};
    await f.builders.publish(f.actor,await f.authorize(privateCorrection,'builder.publish'));
    const warning=await sendEvent({id:randomUUID(),builderId,kind:'maintenance',expectedRevision:3,declarationId:root.id,action:'security-issue',summary:'Independent public maintenance notice'});
    const notices=await (await request('/v1/builders/notices/query',{builderId,limit:1})).json();
    assert.equal(notices.items[0].eventId,delist.eventId);assert.equal(notices.nextAfter,2);assert.equal(notices.declarationIncluded,false);
    const last=await (await request('/v1/builders/notices/query',{builderId,after:2,limit:1})).json();
    assert.equal(last.items[0].eventId,warning.eventId);assert.equal(last.nextAfter,null);assert.ok(!JSON.stringify([notices,last]).includes('PRIVATE OWNER NOTE'));
    assert.equal((await client.notices({builderId})).items.length,3);
    await assert.rejects(sendEvent({id:randomUUID(),builderId,kind:'maintenance',expectedRevision:4,declarationId:root.id,action:'relist',summary:'Cannot revive old authorization'}));
    assert.equal((await f.search.query(null,{type:'worker',query:{ownerId:f.actor.subjectId}})).items.length,0);
    const fresh=await sendEvent({...root,id:randomUUID(),expectedRevision:4,declaration:{...root.declaration,name:'Reviewed replacement declaration'}});
    assert.equal((await client.manage({builderId})).delisted,true);
    await sendEvent({id:randomUUID(),builderId,kind:'maintenance',expectedRevision:5,declarationId:fresh.eventId,action:'relist',summary:'Owner relists the newly reviewed declaration'});
    assert.equal((await f.builders.get(null,{builderId})).declaration.name,'Reviewed replacement declaration');
    await f.consents.revoke(f.actor,delist.grant.consentId);
    const query={builderId,eventId:delist.eventId,payloadHash:digest(JSON.stringify(delist.payload))};
    const receipt=await client.receipt(query);assert.equal(receipt.state,'acknowledged');assert.equal(receipt.consentId,delist.grant.consentId);assert.equal(receipt.revision,2);
    assert.equal((await client.receipt({...query,payloadHash:'a'.repeat(64)})).state,'conflict');
    assert.equal((await client.receipt({...query,eventId:randomUUID()})).state,'absent');
    assert.equal((await request('/v1/builders/events/receipt',query,other.credential)).status,404);
    const rows=(await f.db.query('SELECT payload_text FROM builder_events WHERE builder_id=$1 ORDER BY revision',[builderId])).rows;
    assert.equal(rows.length,6);assert.deepEqual(JSON.parse(rows[0].payload_text),root);
  }finally{sessions?.close();if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}if(!database)await f.db.close();}
}
