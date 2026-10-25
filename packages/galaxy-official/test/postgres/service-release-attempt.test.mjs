import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {runServiceReleaseAttempt} from '../../src/operations/service-release-attempt.mjs';

const raw=process.env.GALAXY_CONVERGENCE_TEST_DATABASE_URL;
if(!raw)throw Error('Explicit GALAXY_CONVERGENCE_TEST_DATABASE_URL required; runtime URL is never used.');
const url=new URL(raw);
if(url.protocol!=='postgresql:'||url.hostname!=='127.0.0.1'||!url.port||!/^\/galaxy_release_test_[a-z0-9_]+$/.test(url.pathname)||!/^galaxy_release_test_[a-z0-9_]+$/.test(url.username)||url.search||url.hash)
 throw Error('Dedicated loopback release-test database and role required.');
const from={releaseId:'fixture-old',migrations:[{version:1,sha256:'a'.repeat(64)}]},to={releaseId:'fixture-new',migrations:[...from.migrations,{version:2,sha256:'b'.repeat(64)}]};
async function fixture(){
 const probe=new pg.Pool({connectionString:raw,max:1});
 const row=(await probe.query('SELECT current_database() AS database,current_user AS role,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
 assert.equal(row.database,url.pathname.slice(1));assert.equal(row.role,url.username);
 assert.equal(['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].some(key=>row[key]),false);
 const schema='release_probe_'+randomUUID().replaceAll('-','');
 await probe.query(`CREATE SCHEMA ${schema}`);await probe.end();
 const db=new pg.Pool({connectionString:raw,max:3,options:'-c search_path='+schema});
 await db.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY); INSERT INTO schema_migrations VALUES(1); CREATE TABLE migration_probe(value integer); INSERT INTO migration_probe VALUES(1)');
 let env='old',units='old',running='old',migrationState='inactive',verifyTargetFails=false,observerFails=false,migrationCalls=0;
 const journalRecords=new Map(),events=[];
 const journal={read:async id=>structuredClone(journalRecords.get(id)),write:async record=>journalRecords.set(record.operationId,structuredClone(record))};
 const host={snapshot:async()=>{events.push('snapshot');return'protected-snapshot-reference';},stopAll:async()=>{running='stopped';events.push('stop');},
  applyTarget:async()=>{env='new';units='new';events.push('target-config');},restore:async ref=>{assert.equal(ref,'protected-snapshot-reference');env='old';units='old';events.push('restore');},
  startPrevious:async()=>{running='old';events.push('start-old');},verifyPrevious:async()=>assert.equal((await db.query('SELECT value FROM migration_probe')).rows[0].value,1),
  startTarget:async()=>{running='new';events.push('start-new');},verifyTarget:async()=>{if(verifyTargetFails)throw Error('synthetic target readiness failure');},
  migrationState:async()=>{if(observerFails)throw Error('synthetic observer unavailable');return migrationState;}};
 const operationId=randomUUID();
 const migration=async({commit=false,fail=false}={})=>{
  migrationCalls++;migrationState='active';const client=await db.connect();
  try{await client.query('BEGIN');await client.query('UPDATE migration_probe SET value=2');await client.query('INSERT INTO schema_migrations VALUES(2)');
   if(fail&&!commit)throw Error('synthetic DDL failure before commit');await client.query('COMMIT');if(fail)throw Error('synthetic ACK loss after commit');migrationState='inactive';
  }catch(error){await client.query('ROLLBACK');migrationState='failed';throw error;}finally{client.release();}
 };
 return{db,operationId,from,to,host,journal,migration,events,get state(){return{env,units,running,migrationCalls};},setReadinessFailure:()=>{verifyTargetFails=true;},
  setObserverFailure:value=>{observerFails=value;},close:()=>db.end()};
}
test('actual PostgreSQL rollback before commit restores exact old config and all processes',async()=>{
 const h=await fixture();try{const result=await runServiceReleaseAttempt({...h,migrate:()=>h.migration({fail:true})});
  assert.equal(result.state,'old-runtime-restored');assert.deepEqual(result.actualVersions,[1]);assert.deepEqual(h.state,{env:'old',units:'old',running:'old',migrationCalls:1});
  assert.equal((await h.db.query('SELECT value FROM migration_probe')).rows[0].value,1);assert.equal(result.databaseDowngrade,false);
 }finally{await h.close();}
});
test('actual commit followed by readiness failure never points old runtime at advanced schema',async()=>{
 const h=await fixture();try{h.setReadinessFailure();const result=await runServiceReleaseAttempt({...h,migrate:()=>h.migration()});
  assert.equal(result.state,'requires-compatible-fix');assert.equal(result.schemaAdvanced,true);assert.equal(result.failedPhase,'migration-committed');
  assert.deepEqual(h.state,{env:'new',units:'new',running:'stopped',migrationCalls:1});assert.equal(h.events.includes('restore'),false);assert.equal(h.events.includes('start-old'),false);
  assert.equal((await h.db.query('SELECT value FROM migration_probe')).rows[0].value,2);assert.deepEqual((await h.db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r=>r.version),[1,2]);
 }finally{await h.close();}
});
test('unknown commit ACK queries the same operation, never remigrates, then keeps advanced schema stopped',async()=>{
 const h=await fixture();try{h.setObserverFailure(true);const first=await runServiceReleaseAttempt({...h,migrate:()=>h.migration({commit:true,fail:true})});
  assert.equal(first.state,'result-unknown');assert.equal(first.nextAction,'query-original-attempt');assert.equal(h.state.running,'stopped');
  h.setObserverFailure(false);const result=await runServiceReleaseAttempt({...h,migrate:()=>{throw Error('must never dispatch another migration');}});
  assert.equal(result.operationId,first.operationId);assert.equal(result.state,'requires-compatible-fix');assert.equal(h.state.migrationCalls,1);assert.equal(h.events.includes('restore'),false);
 }finally{await h.close();}
});
test('one session lock excludes simultaneous independent release attempts',async()=>{
 const h=await fixture();let release,entered;const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
 try{const first=runServiceReleaseAttempt({...h,migrate:async()=>{entered();await gate;await h.migration();}});await started;
  await assert.rejects(runServiceReleaseAttempt({...h,operationId:randomUUID(),migrate:()=>h.migration()}),/Another release attempt/);release();assert.equal((await first).state,'activated');
 }finally{release?.();await h.close();}
});
