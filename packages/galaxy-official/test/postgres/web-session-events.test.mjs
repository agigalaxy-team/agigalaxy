import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrate} from '../../src/infrastructure/database.mjs';
import {PortalSessions} from '../../src/identity/authentication/portal-session.mjs';
import {createWebEventService} from '../../src/web-events/service.mjs';
import {CommunityAccountRegistry} from '../../src/accounts/community-accounts.mjs';

test('real PostgreSQL: activity and rotating-token CAS do not reset account queries; authority/logout changes still do',async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
 const pool=new pg.Pool({max:8,statement_timeout:10000});
 const endpoint='https://session-events.invalid',accountId=randomUUID(),scope='a'.repeat(64),tokenHash='b'.repeat(64);
 try{
  await migrate(pool);
  await pool.query("INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,'https://issuer.invalid','synthetic','email',now(),now())",[accountId,endpoint]);
  await pool.query(`INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email_verified,csrf_token,created_at,expires_at)
   VALUES($1,$2,$3,$4,'https://issuer.invalid','synthetic',true,$5,1000,1600)`,[scope,tokenHash,'c'.repeat(64),accountId,'d'.repeat(43)]);
  let clock=1000,refreshes=0;
  const sessions=new PortalSessions({db:pool,kind:'account',scope:[scope],now:()=>clock,
   policy:{key:randomBytes(32),idleSeconds:120,maximumSeconds:600,refreshBeforeSeconds:10},
   provider:{refresh:async()=>{refreshes++;return{refreshToken:'synthetic-rotated',expiresAt:clock+300};}}});
  await sessions.create(pool,tokenHash,{portalTokens:{refreshToken:'synthetic-original',expiresAt:1100}});
  await pool.query('TRUNCATE web_event_outbox_v1');
  const row=async()=>(await pool.query('SELECT * FROM official_account_sessions_v1 WHERE scope_hash=$1 AND token_hash=$2',[scope,tokenHash])).rows[0];
  const count=async()=>Number((await pool.query("SELECT count(*) AS count FROM web_event_outbox_v1 WHERE source_table='official_account_sessions_v1'")).rows[0].count);
  clock=1010;await sessions.current(await row(),{activity:true});
  assert.equal(await count(),0,'Genuine user activity only extending idle expiry is not a query reset');
  clock=1095;await sessions.current(await row(),{activity:true});
  assert.equal(refreshes,1);assert.equal((await row()).refresh_state,'ready');
  assert.equal(await count(),0,'Refresh claim, token rotation and successful CAS create no authority hints');
  await pool.query("UPDATE official_account_sessions_v1 SET refresh_state='unknown',refresh_version=refresh_version+1 WHERE scope_hash=$1 AND token_hash=$2",[scope,tokenHash]);
  assert.equal(await count(),0,'Unknown refresh progress does not pretend that business authority changed');
  await pool.query('UPDATE official_account_sessions_v1 SET max_expires_at=max_expires_at-1 WHERE scope_hash=$1 AND token_hash=$2',[scope,tokenHash]);
  assert.equal(await count(),1,'The real maximum session deadline remains authoritative');
  await pool.query('UPDATE official_account_sessions_v1 SET csrf_token=$3 WHERE scope_hash=$1 AND token_hash=$2',[scope,tokenHash,'e'.repeat(43)]);
  assert.equal(await count(),2,'CSRF authority changes are never filtered as refresh progress');
  await pool.query('TRUNCATE web_event_outbox_v1');
  const accounts=new CommunityAccountRegistry({db:pool,endpoint}),actor={kind:'official-account',accountId,endpoint};
  const service=createWebEventService({pool,endpoint,communityAccounts:accounts,officialAccounts:{actionActor:async()=>actor}});
  const connection=await service.connect({request:{headers:{'x-galaxy-account-id':accountId}},surface:'web',topics:['account','account-work']});
  const before=await service.position();
  await pool.query("UPDATE official_account_sessions_v1 SET refresh_state='revoked',refresh_cipher=NULL WHERE scope_hash=$1 AND token_hash=$2",[scope,tokenHash]);
  assert.equal(await count(),1,'Entering revoked is always an authority event even if only refresh fields changed');
  await pool.query('UPDATE official_account_sessions_v1 SET revoked_at=$3 WHERE scope_hash=$1 AND token_hash=$2',[scope,tokenHash,clock]);
  assert.equal(await count(),2,'Logout revoked_at is also retained');
  const frames=await service.read(connection,before);
  assert.deepEqual(frames.find(frame=>frame.type==='reset')?.modules,['account','account-work']);
  assert.ok(!JSON.stringify(frames).includes('refresh_cipher'));
 }finally{await pool.end();}
});
