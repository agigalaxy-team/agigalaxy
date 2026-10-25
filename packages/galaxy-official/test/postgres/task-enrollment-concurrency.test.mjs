import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from '../service-fixture.mjs';

const raw=process.env.GALAXY_TASK_CONVERGENCE_TEST_DATABASE_URL;
if(!raw)throw Error('Explicit isolated Task test database URL required; no runtime fallback.');
const url=new URL(raw);
if(url.protocol!=='postgresql:'||url.hostname!=='127.0.0.1'||!url.port||!/^\/galaxy_task_test_[a-z0-9_]+$/.test(url.pathname)||!/^galaxy_task_test_[a-z0-9_]+$/.test(url.username)||url.search||url.hash)throw Error('Dedicated loopback Task test database and role required.');
test('real PostgreSQL lock queues serialize stop/application in both orders with exact receipts and no lost facts',async()=>{
 const db=new pg.Pool({connectionString:raw,max:5,application_name:'galaxy-convergence-task-test'});
 try{
  const who=(await db.query('SELECT current_database() AS database,current_user AS role,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.equal(who.database,url.pathname.slice(1));assert.equal(who.role,url.username);assert.equal(['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].some(key=>who[key]),false);
  const scopes=['binding','consent','case-teaser','assistance'],now=Math.floor(Date.now()/1000),owner=await serviceFixture(scopes,db,{now}),peer=await serviceFixture(scopes,db,{now,migrateDatabase:false});
  const waitLocks=async count=>{for(let turn=0;turn<100;turn++){
   const waiting=Number((await db.query("SELECT count(*) FROM pg_stat_activity WHERE application_name='galaxy-convergence-task-test' AND wait_event_type='Lock' AND query LIKE '%task_requests%'" )).rows[0].count);
   if(waiting>=count)return;await new Promise(resolve=>setTimeout(resolve,10));
  }throw Error('Expected real Task lock queue was not observed.');};
  for(const firstKind of ['stop','apply']){
   const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'collaboration',title:'Independent concurrent enrollment',summary:'Preserve both committed facts and the current stopping intent',
    workContext:{goal:'Collaborate',currentSituation:'Ready to recruit',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:now+3600};
   await owner.assistance.createTask(owner.actor,await owner.authorize(task,'assistance.publish',{objectId:task.operationId,viewers:[peer.actor.subjectId]}));
   const stop={taskId:task.taskId,event:{kind:'stop-enrollment',eventId:randomUUID(),expectedTaskVersion:1,reason:'Enough people'}},apply={taskId:task.taskId,event:{kind:'apply',eventId:randomUUID(),expectedTaskVersion:1,proposal:'I can help'}};
   const permits={stop:await owner.authorize(stop,'assistance.publish',{objectId:stop.event.eventId}),apply:await peer.authorize(apply,'assistance.publish',{objectId:apply.event.eventId,viewers:[owner.actor.subjectId]})};
   const call=kind=>(kind==='stop'?owner:peer).assistance.submitTaskEvent((kind==='stop'?owner:peer).actor,task.taskId,permits[kind]);
   const blocker=await db.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM task_requests WHERE id=$1 FOR UPDATE',[task.taskId]);
   let first,second;
   try{first=call(firstKind);void first.catch(()=>{});await waitLocks(1);second=call(firstKind==='stop'?'apply':'stop');void second.catch(()=>{});await waitLocks(2);await blocker.query('COMMIT');}
   finally{await blocker.query('ROLLBACK');blocker.release();}
   const results=await Promise.allSettled([first,second]);assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(results[1].reason.code,'task_version_conflict');
   let stopped=firstKind==='stop'?results[0].value:null;
   if(firstKind==='apply'){
    stop.event.expectedTaskVersion=2;permits.stop=await owner.authorize(stop,'assistance.publish',{objectId:stop.event.eventId});
    stopped=await call('stop');
   }
   const snapshot=(await db.query('SELECT snapshot FROM task_requests WHERE id=$1',[task.taskId])).rows[0].snapshot;
   assert.equal(snapshot.state,'open');assert.equal(snapshot.enrollment.state,'stopped');assert.equal(snapshot.applications.length,firstKind==='apply'?1:0);
   assert.deepEqual(await call('stop'),{taskId:stopped.taskId,eventId:stopped.eventId,version:stopped.version},'Exact accepted stop replays its original metadata, not a current-state grant.');
   const late={taskId:task.taskId,event:{...apply.event,eventId:randomUUID(),expectedTaskVersion:snapshot.version}};
   await assert.rejects(peer.assistance.submitTaskEvent(peer.actor,task.taskId,await peer.authorize(late,'assistance.publish',{objectId:late.event.eventId,viewers:[owner.actor.subjectId]})),error=>error.code==='task_transition_denied');
   assert.equal(Number((await db.query('SELECT count(*) FROM task_events WHERE task_id=$1',[task.taskId])).rows[0].count),firstKind==='apply'?3:2);
  }
 }finally{await db.end();}
});
