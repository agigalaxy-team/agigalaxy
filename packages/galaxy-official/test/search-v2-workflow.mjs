import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {searchToolDefinitions} from '../src/personal-mcp-search-v2.mjs';
import {checkChoiceSource} from './choice-source-check.mjs';
const scopes=['binding','consent','case-teaser','assistance','history','capsules','proof','evidence','builders','notifications'];
export async function verifySearchV2(database=null,options={}) {
  const f=await serviceFixture(scopes,database,{now:Math.floor(Date.now()/1000),...options});
  const other=await serviceFixture(scopes,f.db,{now:f.now,...options,migrateDatabase:false});
  const api=createApi({...f,rateLimit:1000});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`;
  const post=async(path,body,fixture=null,status=200)=>{const r=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(fixture?{Authorization:`Bearer ${fixture.credential}`}:{})},body:JSON.stringify(body)});
    const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;};
  const publish=async(fixture,event,visibility='Public')=>{const signed=await fixture.authorize(event,'case.teaser.publish',
    {objectId:event.eventId,visibility,purpose:visibility==='Public'?'public-profile':'operational'});await f.cases.submitV2(fixture.actor,signed);return signed;};
  async function actual(fixture,title,visibility='Public'){
    const id=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,actorId:fixture.actor.subjectId,
      localRef:randomUUID(),title,summary:'Synthetic source, not a real customer case',synthetic:true,source:{kind:'local',reference:randomUUID()}};
    await publish(fixture,root,visibility);
    const start={schemaVersion:2,kind:'attempt-start',eventId:randomUUID(),caseId:id,expectedVersion:1,actorId:fixture.actor.subjectId,
      role:'diagnosis',strategy:'Retry diagnosis',environment:{name:'Node',version:'24'},inputScopeSummary:'Selected synthetic input',permissionScope:['selected-context']};
    await publish(fixture,start,visibility);
    const end={schemaVersion:2,kind:'attempt-end',eventId:randomUUID(),caseId:id,expectedVersion:2,actorId:fixture.actor.subjectId,
      attemptRef:{id:start.eventId,version:1},status:'completed',reportedOutcome:'failed',summary:'Not resolved',failureReason:'Repeated input not diagnosed'};
    const grant=await publish(fixture,end,visibility);return{root,start,end,grant};
  }
  try {
    const one=await actual(f,'search-visible first'),_two=await actual(other,'search-visible second');
    const query={type:'history',query:{query:'search-visible',limit:1}};
    const first=await post('/v2/search/query',query);assert.equal(first.items.length,1);assert.ok(first.nextCursor);
    assert.equal(first.items[0].record.attempts.at(-1).reportedOutcome,'failed');assert.equal(first.items[0].capabilityVerified,false);
    assert.equal(first.helpPaths.length,4);assert.equal(first.globalCountProvided,false);
    const hidden=await actual(other,'PRIVATE-ONLY-NEEDLE','Private');
    const unchanged=await post('/v2/search/query',query);assert.equal(first.nextCursor,unchanged.nextCursor);
    const empty=await post('/v2/search/query',{type:'history',query:{query:'PRIVATE-ONLY-NEEDLE'}});
    assert.equal(empty.pageCount,0);assert.equal(empty.nextCursor,null);assert.equal(JSON.stringify(empty).includes(hidden.root.caseId),false);
    assert.equal((await post('/v2/search/query',{type:'history',query:{query:'PRIVATE-ONLY-NEEDLE'}},other)).pageCount,1);
    assert.equal((await post('/v2/search/query',{type:'history',query:{query:'PRIVATE-ONLY-NEEDLE'}},f)).pageCount,0);
    const second=await post('/v2/search/query',{...query,query:{...query.query,after:first.nextCursor}});assert.equal(second.pageCount,1);assert.equal(second.nextCursor,null);
    const before=await post('/v2/search/query',{type:'history',query:{subjectId:f.actor.subjectId,query:'Not resolved'}});
    assert.equal(before.pageCount,1);
    await f.consents.revoke(f.actor,one.grant.consentId);
    const reference=await post('/v2/search/reference',{search:{type:'history',query:{subjectId:f.actor.subjectId}},ref:before.items[0].ref});
    assert.equal(reference.state,'changed');assert.equal(JSON.stringify(reference.item).includes(one.end.summary),false);
    assert.equal((await post('/v2/search/query',{type:'history',query:{query:'Not resolved',subjectId:f.actor.subjectId}})).pageCount,0);
    const task=async(id,visibility)=>{const value={operationId:randomUUID(),taskId:id,caseId:null,intent:'proactive-review',title:'task-needle',summary:'Active work without invented failures',
      visibility,collaboration:'open-assistance',workContext:{goal:'Review current work',currentSituation:'Ready for review',attemptRefs:[]},enrollmentExpiresAt:f.now+1200};
      await f.assistance.createTask(f.actor,await f.authorize(value,'assistance.publish',{objectId:value.operationId,visibility,purpose:visibility==='Public'?'public-profile':'operational'}));return value;};
    const privateTasks=[];for(let i=1;i<=3;i++)privateTasks.push(await task(`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,'Private'));
    const publicTask=await task('ffffffff-ffff-4fff-8fff-ffffffffffff','Public');
    const tasks=await post('/v2/search/query',{type:'task',query:{query:'task-needle',limit:1}});
    assert.equal(tasks.pageCount,1);assert.equal(tasks.items[0].id,publicTask.taskId);assert.equal(tasks.items[0].record.caseId,null);assert.equal(tasks.nextCursor,null);
    await checkChoiceSource(f,other.actor,{type:'task',query:{query:'task-needle'}},publicTask.taskId);
    for(const t of privateTasks)assert.equal(JSON.stringify(tasks).includes(t.taskId),false);
    const declaration={id:randomUUID(),expectedRevision:0,selfDeclared:{projects:[{id:randomUUID(),kind:'module',title:'No-history document module',summary:'Willing to discuss table extraction',functions:['table-extraction'],technologies:['Rust'],discoverable:true}]}};
    await other.profiles.publish(other.actor,await other.authorize(declaration,'profile.publish',{visibility:'Public',purpose:'public-profile'}));
    await other.discovery.save(other.actor,{expectedRevision:0,preferences:{enabled:true}});
    const opportunity=await post('/v2/search/query',{type:'opportunity',query:{context:{kind:'ephemeral',title:'Extract tables',functions:['table-extraction'],technologies:['Python']},purposes:['conversation']}});
    assert.equal(opportunity.pageCount,1);assert.equal(opportunity.items[0].record.capabilityVerified,false);assert.equal(opportunity.items[0].record.roomJoined,false);
    await checkChoiceSource(f,f.actor,{type:'opportunity',query:{context:{kind:'ephemeral',title:'Choice context remains local',functions:['table-extraction'],technologies:['Python']},purposes:['conversation']}},opportunity.items[0].id);
    for(const type of ['capsule','proof'])assert.equal((await post('/v2/search/query',{type,query:{}})).pageCount,0);
    const tools=searchToolDefinitions(f,f.actor);assert.equal((await tools.galaxy_search_v2_query.run({type:'history',query:{}})).schemaVersion,2);
    await post('/v2/search/query',{type:'task',query:{}},{credential:'invalid'},401);
    await post('/v1/search/query',{type:'task',query:{}},null,400);
    assert.equal((await post('/v1/search/query',{type:'history',query:{query:'search-visible'}})).version,1);
  } finally {await new Promise(resolve=>api.close(resolve));if(!database)await f.db.close();}
}
