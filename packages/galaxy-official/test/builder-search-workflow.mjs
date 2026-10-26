import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { builderDeclaration } from './builders-workflow.mjs';
import { createApi } from '../src/http.mjs';
import { createSearchClient } from "../src/clients/search.mjs";
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { SearchIndex } from "../src/discovery/search-index.mjs";
import { workerReads } from '../src/infrastructure/worker-reads.mjs';

export async function verifyBuilderSearch(database=null,options={}){
  const scopes=['binding','consent','builders'],f=await serviceFixture(scopes,database,options),publicGrant={visibility:'Public',purpose:'public-profile'};
  const endpoint=f.access.endpoint,workerDb=options.workerDb??f.db,index=new SearchIndex({db:workerDb,endpoint,now:()=>f.now,readGrant:options.workerDb?workerReads.readGrant:undefined});
  let api,sessions;
  const publish=async(type,fields={},visibility=publicGrant)=>{
    const event={id:randomUUID(),builderId:randomUUID(),expectedRevision:0,kind:'declare',declaration:{...builderDeclaration(type,f.actor.subjectId),...fields}};
    const grant=await f.authorize(event,'builder.publish',visibility);await f.builders.publish(f.actor,grant);return {...event,grant};
  };
  const event=async(source,kind,fields)=>{
    const current=await f.builders.get(f.actor,{builderId:source.builderId});
    const payload={id:randomUUID(),builderId:source.builderId,expectedRevision:current.revision,kind,declarationId:current.declarationId,...fields};
    const grant=await f.authorize(payload,'builder.publish',publicGrant);await f.builders.publish(f.actor,grant);return {payload,grant};
  };
  const query=(type,query={},actor=null)=>f.search.query(actor,{type,query:{ownerId:f.actor.subjectId,...query}});
  const drain=async()=>{for(let i=0;i<300;i++)if(!(await index.processNext()).processed)return;throw new Error('Builder index queue did not drain');};
  try{
    const privateWorker=await publish('worker',{name:'PRIVATE WORKER'},{});
    const workers=[await publish('worker',{name:'Public compiler one'}),await publish('worker',{name:'Public compiler two'})].sort((a,b)=>a.builderId.localeCompare(b.builderId));
    const hub=await publish('hub',{name:'Kulai hub declaration',region:'Kulai Malaysia'});
    await publish('bridge');
    const first=await query('worker',{query:'compiler coding',limit:1});
    assert.deepEqual(first.items.map(row=>row.id),[workers[0].builderId]);assert.equal(first.nextCursor,workers[0].builderId);
    assert.equal(first.items[0].source.kind,'worker');assert.equal(first.items[0].source.declarationId,workers[0].id);
    assert.equal(first.items[0].record.reachability.endpointReachable,null);assert.equal(first.capabilityVerified,false);
    assert.ok(first.items[0].matchReasons.some(reason=>reason.includes('taskTypes')));
    const second=await query('worker',{query:'compiler coding',limit:1,after:first.nextCursor});
    assert.deepEqual(second.items.map(row=>row.id),[workers[1].builderId]);assert.equal(second.nextCursor,null);
    const publicOwner=await query('worker',{},f.actor);assert.equal(publicOwner.items.length,2);assert.ok(!JSON.stringify(publicOwner).includes('PRIVATE WORKER'));
    assert.ok((await f.builders.query(f.actor,{ownerId:f.actor.subjectId,type:'worker'})).items.some(row=>row.builderId===privateWorker.builderId));
    assert.equal((await query('hub',{query:'Malaysia operator'})).items[0].id,hub.builderId);
    assert.equal((await query('hub',{query:'unknown region'})).items.length,0);
    await assert.rejects(query('worker',{type:'hub'}),/invalid_search_query/);
    api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${api.address().port}`;
    const request=(input,credential)=>fetch(origin+'/v1/search/query',{method:'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(input)});
    sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});sessions.adopt({endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,scopes,expiresAt:f.now+600,bindingExpiresAt:f.now+900,takeCredential:()=>f.credential});
    const client=createSearchClient({endpoint,sessions,send:async(_url,input)=>{const response=await request(JSON.parse(input.bodyJson),input.credential);assert.equal(response.status,200);return response.json();}});
    assert.equal((await client.query({type:'worker',query:{ownerId:f.actor.subjectId}})).items.length,2);
    assert.equal((await (await request({type:'hub',query:{query:'Malaysia',ownerId:f.actor.subjectId}})).json()).items[0].id,hub.builderId);
    const outsider=await serviceFixture(['binding','history'],f.db,{...options,migrateDatabase:false});
    assert.equal((await request({type:'worker',query:{}},outsider.credential)).status,401);

    await index.configure({enabled:true,rebuild:true});for(let i=0;i<100;i++)if((await index.seedBatch(100)).complete)break;await drain();
    assert.equal((await index.candidates('worker',{subjectId:f.actor.subjectId,query:'compiler coding'})).items.length,2);
    const indexed=await query('hub',{query:'Malaysia'});assert.equal(indexed.index.mode,'public-candidate-index');assert.equal(indexed.items[0].source.declarationId,hub.id);
    const docs=(await f.db.query('SELECT * FROM search_documents WHERE subject_id=$1',[f.actor.subjectId])).rows;
    assert.equal(docs.filter(row=>row.source_type==='worker').length,2);assert.ok(!JSON.stringify(docs).includes('PRIVATE WORKER'));
    const warning=await event(workers[0],'maintenance',{action:'security-issue',summary:'Synthetic public maintenance notice'});
    assert.equal((await index.candidates('worker',{subjectId:f.actor.subjectId})).items.some(row=>row.id===workers[0].builderId),false);
    await drain();assert.equal((await query('worker')).items.find(row=>row.id===workers[0].builderId).record.securityIssue,true);
    // The source service rereads current state rather than trusting index metadata.
    await workerDb.query("UPDATE search_documents SET metadata=metadata||'{\"capabilityVerified\":true}'::jsonb WHERE source_id=$1",[workers[0].builderId]);
    assert.equal((await query('worker')).items.find(row=>row.id===workers[0].builderId).record.compatibility.capabilityVerified,false);
    await event(workers[0],'maintenance',{action:'delist',summary:'Owner delists'});await drain();
    assert.equal((await query('worker')).items.some(row=>row.id===workers[0].builderId),false);
    await event(workers[0],'maintenance',{action:'relist',summary:'Owner restores listing'});await drain();
    assert.equal((await query('worker')).items.some(row=>row.id===workers[0].builderId),true);
    const replaced={id:randomUUID(),builderId:workers[1].builderId,kind:'declare',expectedRevision:1,declaration:{...workers[1].declaration,name:'PRIVATE REPLACEMENT'}};
    await f.builders.publish(f.actor,await f.authorize(replaced,'builder.publish',{}));await drain();
    assert.equal((await query('worker')).items.some(row=>row.id===workers[1].builderId),false);
    assert.equal((await query('worker',{},f.actor)).items.some(row=>row.id===workers[1].builderId),false);
    await f.consents.revoke(f.actor,hub.grant.consentId);
    assert.equal((await index.candidates('hub',{subjectId:f.actor.subjectId})).items.length,0);await drain();
    assert.equal((await query('hub')).items.length,0);
    await f.bindings.revoke(f.actor.bindingId,f.actor.subjectId,randomUUID(),null,f.actor);await drain();
    assert.equal((await index.candidates('worker',{subjectId:f.actor.subjectId})).items.length,0);
    assert.ok(warning.payload.id);
    await index.configure({enabled:false});
  }finally{sessions?.close();if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}if(!database)await f.db.close();}
}
