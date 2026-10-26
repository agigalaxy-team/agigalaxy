import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {RequesterHistoryV2Service} from "../src/records/requester-history-v2.mjs";
import {digest} from '../src/shared/digest.mjs';

const orderedId=value=>`00000000-0000-4000-8000-${String(value).padStart(12,'0')}`;
// Observes the actual SQL and actual returned rows, never supplies replacement
// query results or treats fixture elapsed time as a production CPU budget.
function measuredService(f){
  let stats;
  const wrap=db=>({query:async(sql,args)=>{
    const result=await db.query(sql,args),text=sql.replace(/\s+/g,' ').trim();
    stats.queries++;stats.returnedRows+=result.rows.length;
    if(/^SELECT \* FROM task_requests /i.test(text))stats.fullTaskReads++;
    if(/^SELECT snapshot FROM task_requests /i.test(text))stats.taskSnapshotReads++;
    if(/^SELECT \* FROM task_events WHERE id=/i.test(text))stats.rootEventReads++;
    if(/^SELECT \* FROM task_events WHERE task_id=/i.test(text))stats.eventCollectionReads++;
    for(const row of result.rows){if(typeof row.payload_text==='string')stats.loadedBodyBytes+=Buffer.byteLength(row.payload_text);
      if(row.snapshot)stats.loadedBodyBytes+=Buffer.byteLength(JSON.stringify(row.snapshot));}
    return result;
  }});
  const access={endpoint:f.access.endpoint,now:f.access.now,
    db:{transaction:operation=>f.db.transaction(tx=>operation(wrap(tx)))},
    runAuthorized:(actor,scope,operation)=>f.access.runAuthorized(actor,scope,(db,authorization)=>operation(wrap(db),authorization))};
  const service=new RequesterHistoryV2Service(access,f.assistance,f.contributionSharing);
  return {query:async(actor,input)=>{stats={queries:0,returnedRows:0,fullTaskReads:0,taskSnapshotReads:0,rootEventReads:0,eventCollectionReads:0,loadedBodyBytes:0};
    const start=performance.now(),result=await service.query(actor,input);return{result,stats:{...stats,elapsedMs:Math.round(performance.now()-start)}};}};
}
async function fixture(){
  const scopes=['binding','consent','assistance','history'],f=await serviceFixture(scopes,null,{syntheticCommunityQuota:false});
  try{const other=await serviceFixture(scopes,f.db,{migrateDatabase:false,syntheticCommunityQuota:false});
    const create=async(index,{viewer=false,published=false,purposes=['requester-history'],publicationExpiry=f.now+1000}={})=>{
      const task={operationId:orderedId(index),taskId:randomUUID(),caseId:null,intent:'proactive-review',title:`Synthetic scoped work ${index}`,
        summary:'Private retained work for SQL-cost evidence '.repeat(30),workContext:{goal:'Preserve visible pagination',currentSituation:'Synthetic private input',attemptRefs:[]},
        visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+1000};
      const request=await f.authorize(task,'assistance.publish',{objectId:task.operationId,viewers:viewer?[other.actor.subjectId]:[]});
      await f.assistance.createTask(f.actor,request);let publication;
      if(published){publication={id:randomUUID(),kind:'publish',purpose:'public-contribution-projections-only',purposes,
        sourceRefs:[{kind:'task-event',id:task.operationId,eventVersion:1,payloadHash:digest(request.payloadJson),fields:['eventType','actorId','title','taskId','time']}],
        expiresAt:new Date(publicationExpiry*1000).toISOString(),redactionConfirmed:true,
        publicationScope:'selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged'};
        await f.contributionSharing.submit(f.actor,await f.authorize(publication,'contribution.publish',{objectId:publication.id,visibility:'Public',purpose:'public-profile'}));}
      return {task,request,publication};
    };
    return{...f,other,create,measured:measuredService(f),close:()=>f.db.close()};
  }catch(error){await f.db.close();throw error;}
}

test('metadata eligibility avoids loading every private Task and fact body in an entirely hidden history',async t=>{
  const f=await fixture();try{
    for(let i=1;i<=205;i++)await f.create(i);
    const q={subjectId:f.actor.subjectId,limit:2};
    for(const [label,actor] of [['foreign',f.other.actor],['public',null]]){
      const observed=await f.measured.query(actor,q);t.diagnostic(JSON.stringify({viewer:label,hiddenRoots:205,...observed.stats}));
      assert.deepEqual(observed.result.items,[]);assert.equal(observed.result.nextAfter,null);
      assert.equal(observed.stats.fullTaskReads,0,'hidden roots must be rejected before SELECT * Task projection');
      assert.equal(observed.stats.rootEventReads,0);assert.equal(observed.stats.eventCollectionReads,0);
      assert.equal(observed.stats.taskSnapshotReads,0);assert.equal(observed.stats.loadedBodyBytes,0);
      assert.ok(observed.stats.queries<=2,'eligibility is one database selection, not a round trip per hidden root');
    }
  }finally{await f.close();}
});

test('metadata prefilter preserves exact current direct and published permissions across visible pages and revoked cursors',async t=>{
  const f=await fixture();try{
    for(let i=1;i<=105;i++)await f.create(i);
    const shared=await f.create(106,{viewer:true}),published=await f.create(108,{published:true});
    await f.create(107);await f.create(109);const q={subjectId:f.actor.subjectId,limit:1};
    const foreign=await f.measured.query(f.other.actor,q),anonymous=await f.measured.query(null,q);
    t.diagnostic(JSON.stringify({viewer:'foreign',hiddenRoots:107,...foreign.stats}));
    assert.deepEqual(foreign.result.items.map(i=>i.source.id),[shared.task.operationId]);assert.equal(foreign.result.nextAfter,shared.task.operationId);
    assert.deepEqual(anonymous.result.items.map(i=>i.source.id),[published.task.operationId]);assert.equal(anonymous.result.nextAfter,null);
    assert.equal(foreign.stats.fullTaskReads,2,'only the returned root and visible lookahead load complete Task projections');
    assert.equal(anonymous.stats.fullTaskReads,1);
    const second=await f.measured.query(f.other.actor,{...q,after:foreign.result.nextAfter});
    assert.deepEqual(second.result.items.map(i=>i.source.id),[published.task.operationId]);assert.equal(second.result.nextAfter,null);
    const owner=await f.measured.query(f.actor,q);assert.equal(owner.result.items[0].source.id,orderedId(1));
    await assert.rejects(f.measured.query(f.other.actor,{...q,after:owner.result.nextAfter}),error=>error.code==='requester_history_cursor_unavailable');
    await f.consents.revoke(f.actor,shared.request.consentId);
    await assert.rejects(f.measured.query(f.other.actor,{...q,after:shared.task.operationId}),error=>error.code==='requester_history_cursor_unavailable');
    const revoke={id:randomUUID(),kind:'revoke',publicationId:published.publication.id,reason:'Withdraw scoped publication'};
    await f.contributionSharing.submit(f.actor,await f.authorize(revoke,'contribution.publish',{objectId:revoke.id}));
    const hiddenAgain=await f.measured.query(null,q);assert.deepEqual(hiddenAgain.result.items,[]);assert.equal(hiddenAgain.result.nextAfter,null);
    assert.equal(hiddenAgain.stats.fullTaskReads,0);
  }finally{await f.close();}
});

test('publication metadata is only a prefilter and cannot grant the wrong purpose or extend business expiry',async()=>{
  const f=await fixture();try{
    await f.create(1,{published:true,purposes:['honor']});
    await f.create(2,{published:true,publicationExpiry:f.now+5});
    const current=await f.create(3,{published:true}),q={subjectId:f.actor.subjectId,limit:2};
    // Explicit fixture clock changes; credentials remain within their real
    // 600-second signed lifetime. No wall-clock/CPU assertion is inferred.
    f.access.now=()=>f.now+10;
    const observed=await f.measured.query(null,q);
    assert.deepEqual(observed.result.items.map(i=>i.source.id),[current.task.operationId]);assert.equal(observed.result.nextAfter,null);
    assert.equal(observed.stats.fullTaskReads,3,'potential metadata candidates still undergo the canonical purpose and expiry checks');
    await f.consents.revoke(f.actor,current.request.consentId);
    const after=await f.measured.query(null,q);assert.deepEqual(after.result.items,[]);assert.equal(after.result.nextAfter,null);
    assert.equal(after.stats.fullTaskReads,2,'revoked original source is excluded before full Task loading');
  }finally{await f.close();}
});
