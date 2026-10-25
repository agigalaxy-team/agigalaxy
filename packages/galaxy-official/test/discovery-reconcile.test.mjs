import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {DiscoveryStore} from '../src/discovery-runtime/store.mjs';
import {DiscoveryRuntime,DiscoveryWorker} from '../src/discovery-runtime/runtime.mjs';
import {discoveryRuntimeMigrationSql} from '../src/discovery-runtime/schema.mjs';

test('periodic index scans preserve active work and backoff while still reconciling current eligibility',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE TABLE community_accounts(id uuid PRIMARY KEY,endpoint text);
 CREATE TABLE forum_posts_v1(id uuid PRIMARY KEY);CREATE TABLE forum_versions_v1(id uuid PRIMARY KEY,post_id uuid);CREATE TABLE forum_replies_v1(id uuid PRIMARY KEY,post_id uuid);
 CREATE TABLE forum_permissions_v1(id uuid);CREATE TABLE forum_sections_v2(id uuid);CREATE TABLE forum_governance_events_v1(id uuid);CREATE TABLE operations_content_visibility_v1(id uuid);CREATE TABLE operations_forum_curation_v1(id uuid);CREATE TABLE operations_forum_tags_v1(id uuid);CREATE TABLE bindings(id uuid);CREATE TABLE consents(id uuid);CREATE TABLE deletion_requests(id uuid);`);
 await db.exec(discoveryRuntimeMigrationSql);
 let clock=Math.floor(Date.now()/1000)+2;
 const endpoint='https://galaxy.example.invalid',store=new DiscoveryStore({db,endpoint,now:()=>clock});await store.initialize();
 const rowFor=async id=>(await db.query('SELECT * FROM discovery_index_outbox_v1 WHERE endpoint=$1 AND source_id=$2',[endpoint,id])).rows[0];
 const references=[];
 for(const state of ['pending','failed','leased']){
  const reference={kind:'post',id:randomUUID()};references.push(reference);
  assert.equal(await store.reconcile(reference),true);
  const lease=state==='leased'?randomUUID():null;
  await db.query("UPDATE discovery_index_outbox_v1 SET state=$3,generation=7,attempts=4,last_error='prior-failure',lease_id=$4,lease_until=$5,next_attempt_at=$5 WHERE endpoint=$1 AND source_id=$2",[endpoint,reference.id,state,lease,new Date((clock+240)*1000).toISOString()]);
  const before=await rowFor(reference.id);clock+=1;
  assert.equal(await store.reconcile(reference),false);
  assert.deepEqual(await rowFor(reference.id),before,`${state} reconciliation must not erase queue position, retry delay or the active lease`);
 }
 assert.equal(await store.claim('discovery_index_outbox_v1'),null,'reconciliation must not make failed/leased work immediately due');
 const mutation=references.find((_value,index)=>index===2),beforeMutation=await rowFor(mutation.id);
 await store.enqueue(mutation);
 const afterMutation=await rowFor(mutation.id);
 assert.equal(Number(afterMutation.generation),Number(beforeMutation.generation)+1);
 assert.equal(afterMutation.state,'pending');assert.equal(afterMutation.lease_id,beforeMutation.lease_id);
 await store.completeIndex(beforeMutation,{version:'old-lease-version'});
 assert.equal((await rowFor(mutation.id)).state,'pending','a real mutation during an existing lease must remain pending');
 await db.query('DELETE FROM discovery_index_outbox_v1 WHERE endpoint=$1',[endpoint]);

 const reference={kind:'post',id:randomUUID()},key='post_'+reference.id;
 let allowed=true;
 const calls=[];
 // The source and engine transports below are explicit fixtures. Queue,
 // transactions, migration and worker orchestration are their actual code.
 const source={candidates:async()=>[reference],load:async()=>allowed?{
  id:key,kind:'post',sourceId:reference.id,version:'source-v1',indexVersion:'qualified-v1',
  title:'Current public source',body:'Current text',topic:'technology',tags:[],publishedAt:clock-60,publishedUntil:clock+3600
 }:null};
 const meili={upsert:async value=>calls.push(['meili-upsert',value.id]),remove:async id=>calls.push(['meili-remove',id])};
 const gorse={upsert:async value=>calls.push(['gorse-upsert',value.id]),remove:async id=>calls.push(['gorse-remove',id])};
 const worker=new DiscoveryWorker(new DiscoveryRuntime({db,endpoint,store,source,meili,gorse}));
 assert.deepEqual(await worker.seedBatch(),{queued:1,scanned:1,complete:true});
 assert.equal((await worker.indexOne()).state,'indexed');
 assert.equal((await rowFor(reference.id)).state,'applied');
 allowed=false;clock+=60;
 assert.equal((await worker.seedBatch()).queued,1);
 assert.equal((await worker.indexOne()).state,'removed');
 assert.ok(calls.some(([kind,id])=>kind==='meili-remove'&&id===key));
 assert.ok(calls.some(([kind,id])=>kind==='gorse-remove'&&id===key));
 allowed=true;clock+=60;
 await worker.seedBatch();assert.equal((await worker.indexOne()).state,'indexed');
 assert.equal((await rowFor(reference.id)).state,'applied');
 const preExpiry=await rowFor(reference.id);clock=Math.ceil(new Date(preExpiry.source_expires_at).getTime()/1000)+1;
 await store.queueExpired();assert.equal((await rowFor(reference.id)).state,'pending','the existing source-expiry queue still runs');
});
