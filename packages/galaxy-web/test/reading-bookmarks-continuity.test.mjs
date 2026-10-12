import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from '../../galaxy-official/test/community-forum-fixture.mjs';
import {createReadingBookmarksClient} from '../src/reading-bookmarks-client.mjs';

function localStorageDouble(){
  const values=new Map();let queue=Promise.resolve();
  return{values,getLocal:async(key,owner)=>structuredClone(values.get(owner+':'+key)),updateLocal(key,update,owner){
    const next=queue.then(()=>{const name=owner+':'+key,value=update(structuredClone(values.get(name)));values.set(name,structuredClone(value));return structuredClone(value);});
    queue=next.then(()=>{},()=>{});return next;
  }};
}
function runtimeDouble(f,storage,{before=async()=>{},after=async()=>{}}={}){
  const who={...f.owner},snapshot={subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,generation:1,endpoint:f.owner.access.endpoint};
  const trace=[];
  return{trace,snapshot,api:{endpoint:snapshot.endpoint,snapshot:()=>({...snapshot}),async call(path,input){
    trace.push({path,input:structuredClone(input)});await before(path,input);
    const out=await f.request(path,{who,input});if(out.status!==200)throw Object.assign(Error(out.body.error),{code:out.body.error,status:out.status,outcome:'rejected'});
    await after(path,input,out.body);return out.body;
  }},receiptStatus:{captureLease(){const captured={...snapshot};return{...captured,assertCurrent(){
    if(JSON.stringify(snapshot)!==JSON.stringify(captured))throw Object.assign(Error('test lease changed'),{code:'test_lease_changed'});
  }};}},getLocal:storage.getLocal,updateLocal:storage.updateLocal};
}
async function setup(run){
  const f=await communityForumFixture();try{
    await f.login(f.owner,'bookmark-client-author');const p=await f.post({title:'[合成] 原收藏内容',body:'不进入本机收藏journal的正文。'});
    assert.equal((await f.write(f.owner,'create-post',p)).status,200);await run(f,{kind:'forum-post',postId:p.postId});
  }finally{await f.close();}
}

test('client over real signed HTTP: lost caller ACK is resolved by exact receipt without a second save or a body cache',{timeout:60000},()=>setup(async(f,reference)=>{
  const storage=localStorageDouble();let lost=true;
  const runtime=runtimeDouble(f,storage,{after:async path=>{if(lost&&path.endsWith('/command')){lost=false;throw Error('explicit isolated lost caller response');}}});
  const client=createReadingBookmarksClient(runtime,{locks:null});
  await assert.rejects(client.setSaved(reference,true),/lost caller response/);
  const pending=await client.pending();assert.equal(pending.length,1);const original=structuredClone(pending[0]);
  assert.ok(!JSON.stringify([...storage.values.values()]).includes('不进入本机'));
  const recovered=await client.resumePending();assert.equal(recovered.items[0].state,'acknowledged');assert.equal((await client.pending()).length,0);
  assert.equal(runtime.trace.filter(row=>row.path.endsWith('/command')).length,1);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM reading_bookmark_operations_v1')).rows[0].n,1);
  await client.setSaved(reference,false);
  await f.ok('/v2/reading-bookmarks/command',{input:original.command});
  assert.equal((await client.status(reference)).saved,false);assert.equal((await client.query()).items.length,0);
}));

test('definite real CAS rejection stops automatic POST; only explicit retry can prepare the current revision',{timeout:60000},()=>setup(async(f,reference)=>{
  const storage=localStorageDouble();let intervened=false;
  const runtime=runtimeDouble(f,storage,{before:async path=>{
    if(path.endsWith('/command')&&!intervened){intervened=true;
      for(const [saved,expectedRevision]of [[true,0],[false,1]])await f.ok('/v2/reading-bookmarks/command',{input:{operationId:randomUUID(),reference,saved,expectedRevision}});
    }
  }});
  const client=createReadingBookmarksClient(runtime,{locks:null}),result=await client.setSaved(reference,true);
  assert.equal(result.state,'pending');assert.equal(result.reason,'reading_bookmark_changed');
  const pending=structuredClone(await client.pending());await client.resumePending();await client.resumePending();
  assert.equal(runtime.trace.filter(row=>row.path.endsWith('/command')).length,1);assert.deepEqual(await client.pending(),pending);
  assert.equal((await client.retry(reference)).state,'absent');assert.equal((await client.pending()).length,0);
  const retried=await client.setSaved(reference,true);assert.equal(retried.state,'acknowledged');assert.equal(retried.bookmark.revision,3);
  assert.equal(runtime.trace.filter(row=>row.path.endsWith('/command')).length,2);
}));

test('two clients preserve the first original journal and one accepted intent; identity changes fence a late status before local or HTTP writes',{timeout:60000},()=>setup(async(f,reference)=>{
  const storage=localStorageDouble(),release=Promise.withResolvers();let reads=0;
  const before=async path=>{if(path.endsWith('/status')){reads++;if(reads===2)release.resolve();await release.promise;}};
  const a=runtimeDouble(f,storage,{before}),b=runtimeDouble(f,storage,{before}),ca=createReadingBookmarksClient(a,{locks:null}),cb=createReadingBookmarksClient(b,{locks:null});
  const results=await Promise.allSettled([ca.setSaved(reference,true),cb.setSaved(reference,true)]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.filter(row=>row.status==='rejected').length,1);
  assert.equal([...a.trace,...b.trace].filter(row=>row.path.endsWith('/command')).length,1);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM reading_bookmark_operations_v1')).rows[0].n,1);
  const late=Promise.withResolvers(),started=Promise.withResolvers(),otherStorage=localStorageDouble();
  const stale=runtimeDouble(f,otherStorage,{before:async path=>{if(path.endsWith('/status')){started.resolve();await late.promise;}}}),client=createReadingBookmarksClient(stale,{locks:null});
  const action=client.setSaved(reference,false);await started.promise;stale.snapshot.subjectId=f.responder.actor.subjectId;stale.snapshot.generation++;late.resolve();
  await assert.rejects(action,{code:'test_lease_changed'});assert.equal(otherStorage.values.size,0);assert.equal(stale.trace.filter(row=>row.path.endsWith('/command')).length,0);
}));
