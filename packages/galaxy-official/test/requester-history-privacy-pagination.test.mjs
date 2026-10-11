import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {digest} from '../src/shared/digest.mjs';

const orderedId=value=>`00000000-0000-4000-8000-${String(value).padStart(12,'0')}`;
async function fixture(){
  const f=await serviceFixture(['binding','consent','assistance','history'],null,{syntheticCommunityQuota:false});
  let api;
  try{
    const other=await serviceFixture(['binding','consent','assistance','history'],f.db,{migrateDatabase:false,syntheticCommunityQuota:false});
    api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${api.address().port}`;
    const http=async input=>{
      const response=await fetch(origin+'/v2/requester-history/query',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${other.credential}`},body:JSON.stringify(input)});
      return{status:response.status,body:await response.json()};
    };
    const create=async(index,visible=false)=>{
      const task={operationId:orderedId(index),taskId:randomUUID(),caseId:null,intent:'proactive-review',title:`隔离请求 ${index}`,
        summary:'分页权限测试，没有真实工作或认证',workContext:{goal:'验证可见分页',currentSituation:'隔离测试',attemptRefs:[]},
        visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+1000};
      const request=await f.authorize(task,'assistance.publish',{objectId:task.operationId,viewers:visible?[other.actor.subjectId]:[]});
      await f.assistance.createTask(f.actor,request);
      let publication;
      if(visible){
        publication={id:randomUUID(),kind:'publish',purpose:'public-contribution-projections-only',purposes:['requester-history'],
          sourceRefs:[{kind:'task-event',id:task.operationId,eventVersion:1,payloadHash:digest(request.payloadJson),fields:['eventType','actorId','title','taskId','time']}],
          expiresAt:new Date((f.now+1000)*1000).toISOString(),redactionConfirmed:true,
          publicationScope:'selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged'};
        await f.contributionSharing.submit(f.actor,await f.authorize(publication,'contribution.publish',{objectId:publication.id,visibility:'Public',purpose:'public-profile'}));
      }
      return{task,request,publication};
    };
    return{...f,other,create,http,close:async()=>{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}};
  }catch(error){if(api?.listening){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}await f.db.close();throw error;}
}

test('hidden requests at the beginning, middle and end do not change another identity or public visible pagination',async()=>{
  const f=await fixture();try{
    for(const id of [2,4,6,8,10])await f.create(id,true);
    const query={subjectId:f.actor.subjectId,limit:2},before=(await f.http(query)).body;
    const publicBefore=await f.requesterHistoryV2.query(null,query);
    const pages=async(publicView=false)=>{
      const result=[];let after;
      for(let page=0;page<10;page++){
        const input={...query,...(after?{after}:{})};
        const view=publicView?await f.requesterHistoryV2.query(null,input):(await f.http(input)).body;
        result.push(view);
        if(!view.nextAfter)return result;
        assert.equal(view.nextAfter,view.items.at(-1).source.id);assert.notEqual(view.nextAfter,after);
        after=view.nextAfter;
      }
      assert.fail('pagination must finish without looping');
    };
    const originalPages=await pages(),originalPublicPages=await pages(true);
    for(const id of [1,3,5,7,9,11])await f.create(id,false);
    const after=await f.http(query);assert.equal(after.status,200);
    assert.deepEqual(after.body,before,'private records must not alter visible items, counts or nextAfter');
    assert.deepEqual(await f.requesterHistoryV2.query(null,query),publicBefore);
    assert.deepEqual(await pages(),originalPages);assert.deepEqual(await pages(true),originalPublicPages);
    assert.deepEqual((await pages()).flatMap(page=>page.items.map(item=>item.source.id)),[2,4,6,8,10].map(orderedId));
    assert.deepEqual((await pages()).map(page=>page.counts.requests),[2,2,1]);
  }finally{await f.close();}
});

test('a completely hidden requester history has no outward page cursor',async()=>{
  const f=await fixture();try{
    for(let id=1;id<=105;id++)await f.create(id,false);
    const query={subjectId:f.actor.subjectId,limit:2},response=await f.http(query);assert.equal(response.status,200);
    assert.deepEqual(response.body.items,[]);assert.equal(response.body.nextAfter,null,'private candidate boundaries cannot escape as public cursors');
    assert.deepEqual(response.body.counts,{requests:0,acceptances:0,cancellations:0,disputes:0});
    assert.equal((await f.requesterHistoryV2.query(null,query)).nextAfter,null);
    await f.create(106,true);
    const lastVisible=await f.http(query);assert.deepEqual(lastVisible.body.items.map(item=>item.source.id),[orderedId(106)]);
    assert.equal(lastVisible.body.nextAfter,null,'a visible request beyond an internal hidden batch must not be lost');
  }finally{await f.close();}
});

test('a cursor never restores revoked source access, another requester or a private audience',async()=>{
  const f=await fixture();try{
    const first=await f.create(2,true);await f.create(4,true);await f.create(6,true);
    const query={subjectId:f.actor.subjectId,limit:1},initial=await f.http(query);assert.equal(initial.status,200);
    const cursor=initial.body.nextAfter;assert.equal(cursor,first.task.operationId);
    const publishedCursor=(await f.requesterHistoryV2.query(null,query)).nextAfter;assert.equal(publishedCursor,cursor);
    const retract={id:randomUUID(),kind:'revoke',publicationId:first.publication.id,reason:'关闭准确公开投影'};
    await f.contributionSharing.submit(f.actor,await f.authorize(retract,'contribution.publish',{objectId:retract.id}));
    await assert.rejects(f.requesterHistoryV2.query(null,{...query,after:publishedCursor}),error=>error.code==='requester_history_cursor_unavailable');
    const stillPrivate=await f.http({...query,after:cursor});assert.equal(stillPrivate.status,200);
    assert.equal(stillPrivate.body.items[0].source.id,orderedId(4),'publication withdrawal does not erase another viewer’s still-valid original permission');
    await f.consents.revoke(f.actor,first.request.consentId);
    const invalidated=await f.http({...query,after:cursor});assert.equal(invalidated.status,409);assert.equal(invalidated.body.error,'requester_history_cursor_unavailable');
    await assert.rejects(f.requesterHistoryV2.query(null,{...query,after:cursor}),error=>error.code==='requester_history_cursor_unavailable');
    const fresh=await f.http(query);assert.deepEqual(fresh.body.items.map(item=>item.source.id),[orderedId(4)]);
    assert.equal((await f.http({...query,subjectId:f.other.actor.subjectId,after:fresh.body.nextAfter})).status,409);
    const privateTask=await f.create(1,false);
    // The owner's legitimate private page cannot be reused by another viewer.
    const ownerPage=await f.requesterHistoryV2.query(f.actor,query);assert.equal(ownerPage.nextAfter,privateTask.task.operationId);
    const foreign=await f.http({...query,after:ownerPage.nextAfter});assert.equal(foreign.status,409);
    assert.equal(foreign.body.error,'requester_history_cursor_unavailable');
    assert.equal(JSON.stringify(foreign.body).includes(privateTask.task.title),false);
  }finally{await f.close();}
});
