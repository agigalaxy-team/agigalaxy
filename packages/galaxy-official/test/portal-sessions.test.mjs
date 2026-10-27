import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {PortalSessions} from '../src/identity/authentication/portal-session.mjs';
import {portalSessionsV1MigrationSql} from '../src/infrastructure/portal-sessions-v1-schema.mjs';

// The isolated PostgreSQL runner sets this guard; no connection string is read.
async function database(){
 if(process.env.GALAXY_TEST_PG_ISOLATED==='1'){
  const {default:pg}=await import('pg');const pool=new pg.Pool({max:8,statement_timeout:10000});
  const schema='portal_fixture_'+randomBytes(8).toString('hex');
  await pool.query(`CREATE SCHEMA ${schema}`);
  const db=new pg.Pool({max:8,statement_timeout:10000,options:`-c search_path=${schema}`});
  return {db,close:async()=>{await db.end();await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();}};
 }
 const {PGlite}=await import('@electric-sql/pglite');const db=new PGlite();return {db,close:()=>db.close()};
}
async function setup(){
 const f=await database();
 await (f.db.exec?sql=>f.db.exec(sql):sql=>f.db.query(sql))(`CREATE TABLE official_account_sessions_v1(scope_hash text,token_hash text,issuer text,external_subject text,created_at bigint,expires_at bigint,revoked_at bigint,CHECK(expires_at>created_at AND expires_at<=created_at+86400),PRIMARY KEY(scope_hash,token_hash));
 CREATE TABLE operations_operator_sessions_v1(endpoint text,configuration_id text,token_hash text,issuer text,external_subject text,expires_at timestamptz,PRIMARY KEY(endpoint,configuration_id,token_hash));`);
 await (f.db.exec?f.db.exec(portalSessionsV1MigrationSql):f.db.query(portalSessionsV1MigrationSql));return f;
}
for(const kind of ['account','operator'])test(`${kind}: shared CAS, encrypted rotating token, unknown outcome, idle/max and logout fences`,async()=>{
 const f=await setup();try{
  let clock=1000,calls=0,release;
  const at=()=>clock,scope=kind==='account'?['a'.repeat(64)]:['https://operator.invalid','configuration'];
  const table=kind==='account'?'official_account_sessions_v1':'operations_operator_sessions_v1';
  const key='b'.repeat(64),policy={key:randomBytes(32),idleSeconds:120,maximumSeconds:600,refreshBeforeSeconds:10};
  const identity={issuer:'https://issuer.invalid',externalSubject:'subject',portalTokens:{refreshToken:'server-only-original',expiresAt:1005}};
  if(kind==='account')await f.db.query(`INSERT INTO ${table}(scope_hash,token_hash,issuer,external_subject,created_at,expires_at) VALUES($1,$2,$3,$4,1000,1600)`,[...scope,key,identity.issuer,identity.externalSubject]);
  else await f.db.query(`INSERT INTO ${table} VALUES($1,$2,$3,$4,$5,to_timestamp(1600),NULL,NULL,NULL,NULL,0,'ready')`,[...scope,key,identity.issuer,identity.externalSubject]);
  const provider={refresh:async({refreshToken})=>{calls++;assert.equal(refreshToken,'server-only-original');await new Promise(resolve=>{release=resolve;});return {refreshToken:'server-only-rotated',expiresAt:1100};}};
  const a=new PortalSessions({db:f.db,kind,scope,policy,provider,now:at}),b=new PortalSessions({db:f.db,kind,scope,policy,provider,now:at});
  await a.create(f.db,key,identity);
  const read=async()=> (await f.db.query(`SELECT * FROM ${table}`)).rows[0];
  let row=await read();assert.ok(!row.refresh_cipher.includes('server-only-original'));
  const first=a.current(row);
  while(!release)await new Promise(resolve=>setTimeout(resolve,1));
  await assert.rejects(b.current(await read()),{code:'portal_session_refresh_unconfirmed'});
  assert.equal(calls,1);release();assert.deepEqual(await first,{expiresAt:1120});
  row=await read();assert.equal(a.decrypt(row.refresh_cipher,key),'server-only-rotated');
  clock=1050;assert.deepEqual(await a.current(row),{expiresAt:1120},'background read does not renew idle');
  assert.deepEqual(await a.current(await read(),{activity:true}),{expiresAt:1170});
  clock=1170;assert.equal(await a.current(await read()),null,'idle deadline is final');
  clock=1600;assert.equal(await a.current({...await read(),idle_expires_at:2000}),null,'maximum deadline wins over idle');
  // An uncertain exchange is never retried by another process.
  clock=1095;provider.refresh=async()=>{calls++;throw Error('lost response');};
  await assert.rejects(a.current(await read()),{code:'portal_session_refresh_unconfirmed'});
  await assert.rejects(b.current(await read()),{code:'portal_session_refresh_unconfirmed'});assert.equal(calls,2);
  // Logout while an AS response is in flight cannot restore the original row.
  await f.db.query(`UPDATE ${table} SET refresh_state='ready',upstream_expires_at=1090`);
  release=null;provider.refresh=async()=>{await new Promise(resolve=>{release=resolve;});return {refreshToken:'late-token',expiresAt:1200};};
  const delayed=a.current(await read());while(!release)await new Promise(resolve=>setTimeout(resolve,1));
  if(kind==='account')await f.db.query(`UPDATE ${table} SET revoked_at=1095`);else await f.db.query(`DELETE FROM ${table}`);
  release();assert.equal(await delayed,null);
 }finally{await f.close();}
});
