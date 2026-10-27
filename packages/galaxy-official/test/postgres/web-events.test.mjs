import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrate} from '../../src/infrastructure/database.mjs';
import {webEventsV1MigrationSql} from '../../src/infrastructure/web-events-v1-schema.mjs';
import {webEventSources} from '../../src/web-events/topics.mjs';
import {createWebEventService} from '../../src/web-events/service.mjs';
import {createWebEventAuthorization} from '../../src/web-events/authorization.mjs';
import {BusinessAdminService} from '../../src/operations/audit/service.mjs';
import {attachOperationsFixtureAuthority} from '../fixtures/operations-authority.mjs';
import {CommunityAccountRegistry} from '../../src/accounts/community-accounts.mjs';

test('real PostgreSQL: committed sources, postcommit cursor, rollback, shared LISTEN, endpoint/permission isolation and finite gap reset',async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1','Only a freshly initialized synthetic cluster is accepted');
 const pool=new pg.Pool({max:8,statement_timeout:10000});
 const endpoint='https://events.invalid',otherEndpoint='https://other.invalid';
 let unsubscribeA,unsubscribeB;
 try{
  await migrate(pool);
  if(!(await pool.query("SELECT to_regclass('web_event_outbox_v1') AS present")).rows[0].present)await pool.query(webEventsV1MigrationSql);
  const triggers=(await pool.query("SELECT count(*)::integer AS count FROM pg_trigger WHERE tgname='web_event_capture_v1'")).rows[0].count;
  assert.equal(triggers,Object.keys(webEventSources).length,'Every declared business source has an actual trigger');
  const accountId=randomUUID();
  await pool.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
   VALUES($1,$2,'https://issuer.invalid','synthetic','email',now(),now())`,[accountId,endpoint]);
  await pool.query('SELECT galaxy_web_events_promote_v1(256)');
  await pool.query('TRUNCATE web_event_log_v1');await pool.query('UPDATE web_event_sequence_v1 SET cursor=0 WHERE singleton');
  const a=await pool.connect(),b=await pool.connect();
  try{
   await a.query('BEGIN');
   await a.query('INSERT INTO official_account_profiles_v1(account_id,display_name,updated_at) VALUES($1,$2,now())',[accountId,'private body never broadcast']);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM web_event_outbox_v1')).rows[0].count,0,'Uncommitted outbox is invisible');
   await pool.query('SELECT galaxy_web_events_promote_v1(256)');
   await b.query('BEGIN');
   await b.query('INSERT INTO operations_model_settings_state_v1(endpoint,updated_at) VALUES($1,now())',[endpoint]);
   await b.query('COMMIT');
   await pool.query('SELECT galaxy_web_events_promote_v1(256)');
   await a.query('COMMIT');
   await pool.query('SELECT galaxy_web_events_promote_v1(256)');
   const rows=(await pool.query('SELECT * FROM web_event_log_v1 ORDER BY cursor')).rows;
   assert.deepEqual(rows.map(r=>r.module),['model-settings','account','users'],'Sequence follows visible commits, including exact profile consumers, not precommit identity allocation');
   assert.ok(!JSON.stringify(rows).includes('private body'));
   await a.query('BEGIN');await a.query("UPDATE official_account_profiles_v1 SET display_name='rolled back' WHERE account_id=$1",[accountId]);await a.query('ROLLBACK');
   await pool.query('SELECT galaxy_web_events_promote_v1(256)');
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM web_event_log_v1')).rows[0].count,3);
  }finally{a.release();b.release();}
  let permitted=true;
  const options={pool,endpoint,authorizeOperator:async()=>({kind:'business-operator',operatorId:'synthetic',endpoint}),
   businessAdmin:{authorizeAction:async()=>{if(!permitted)throw Object.assign(new Error('denied'),{status:403});}}};
  const service=createWebEventService(options),context={request:{headers:{}},requestId:'synthetic',surface:'admin',topics:['model-settings']};
  const connection=await service.connect(context);
  const events=await service.read(connection,'0');
  assert.equal(events.filter(e=>e.type==='change').length,1);
  assert.ok(!JSON.stringify(events).includes('source_ref'));
  const authority=createWebEventAuthorization(options);
  assert.equal(await authority.authorizeSource(connection,{module:'model-settings',source_table:'operations_model_settings_state_v1',source_ref:{endpoint:otherEndpoint},endpoint:otherEndpoint}),false);
  permitted=false;
  const revoked=await service.read(connection,events.at(-1).cursor);
  assert.deepEqual(revoked.find(e=>e.type==='reset')?.modules,['model-settings']);
  permitted=true;
  let wakeCount=0;
  unsubscribeA=await service.subscribe(()=>wakeCount++);
  unsubscribeB=await service.subscribe(()=>wakeCount++);
  const listening=(await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE query='LISTEN galaxy_web_event_ready_v1' AND state='idle'")).rows[0].count;
  assert.equal(listening,1,'Browser count does not allocate additional LISTEN clients');
  await pool.query('UPDATE operations_model_settings_state_v1 SET revision=revision+1 WHERE endpoint=$1',[endpoint]);
  await new Promise((resolve,reject)=>{const end=Date.now()+3000;const check=()=>{if(wakeCount>=2)resolve();else if(Date.now()>end)reject(new Error('Committed source notification was not delivered'));else setTimeout(check,10);};check();});
  const beforeDelete=(await pool.query('SELECT cursor::text FROM web_event_sequence_v1')).rows[0].cursor;
  await pool.query('DELETE FROM operations_model_settings_state_v1 WHERE endpoint=$1',[endpoint]);
  const deletion=await service.read(await service.connect(context),beforeDelete);
  assert.deepEqual(deletion.find(e=>e.type==='reset')?.modules,['model-settings'],'A deleted source clears its stale module without broadcasting its old locator');
  await pool.query("UPDATE web_event_log_v1 SET committed_at=now()-interval '8 days'");
  await pool.query('SELECT galaxy_web_events_promote_v1(256)');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM web_event_log_v1')).rows[0].count,0,'Seven day retention removes old hints even with no new business events');
  await pool.query('UPDATE web_event_sequence_v1 SET cursor=5000 WHERE singleton');
  await pool.query('DELETE FROM web_event_log_v1 WHERE cursor<4999');
  const gap=await service.read(await service.connect(context),'1');
  assert.deepEqual(gap.find(e=>e.type==='reset')?.modules,['model-settings']);
  assert.equal(gap.at(-1).cursor,'5000');
  // Real current PG role assignment checks, separate from the portal test
  // double above. Actor snapshots cannot preserve a revoked permission.
  const admin={kind:'business-operator',operatorId:'event-root',role:'administrator',endpoint};
  const reader={...admin,operatorId:'event-reader',role:'reader'};
  for(const actor of [admin,reader])await pool.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://issuer.invalid',$1,'synthetic',now(),now())",[actor.operatorId,endpoint]);
  const businessAdmin=new BusinessAdminService({db:pool,endpoint});
  await attachOperationsFixtureAuthority({businessAdmin,admin,reader,permissions:['accounts.read']});
  const real=createWebEventAuthorization({pool,endpoint,businessAdmin,authorizeOperator:async()=>reader});
  const principal=await real.authorizeConnection(context);
  assert.equal(await real.authorizeModule(principal,'users'),true);
  const otherAccountId=randomUUID();
  await pool.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
   VALUES($1,$2,'https://issuer.invalid','other-endpoint','email',now(),now())`,[otherAccountId,otherEndpoint]);
  await pool.query('INSERT INTO official_account_profiles_v1(account_id,updated_at) VALUES($1,now())',[otherAccountId]);
  const otherSource=(await pool.query("SELECT * FROM web_event_outbox_v1 WHERE source_table='official_account_profiles_v1' AND module='users' AND source_ref->>'account_id'=$1",[otherAccountId])).rows[0];
  assert.equal(otherSource.endpoint,otherEndpoint,'A profile producer derives its exact account endpoint inside the committing transaction');
  assert.equal(await real.authorizeSource(principal,otherSource),false);
  await pool.query('UPDATE operations_role_assignments_v1 SET enabled=false WHERE operator_id=$1',[reader.operatorId]);
  assert.equal(await real.authorizeModule(principal,'users'),false);
  const accounts=new CommunityAccountRegistry({db:pool,endpoint});
  const accountAuthority=createWebEventAuthorization({pool,endpoint,communityAccounts:accounts});
  const owner={actor:{kind:'official-account',accountId,endpoint},endpoint,surface:'web'};
  const source={module:'account',source_table:'official_account_profiles_v1',source_ref:{account_id:accountId},endpoint:null};
  assert.equal(await accountAuthority.authorizeSource(owner,source),true);
  assert.equal(await accountAuthority.authorizeSource({...owner,actor:{...owner.actor,accountId:randomUUID()}},source),false);
 }finally{unsubscribeA?.();unsubscribeB?.();await pool.end();}
});
