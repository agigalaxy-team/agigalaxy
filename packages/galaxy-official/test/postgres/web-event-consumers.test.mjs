import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrate} from '../../src/infrastructure/database.mjs';
import {createWebEventAuthorization} from '../../src/web-events/authorization.mjs';
import {webEventSources} from '../../src/web-events/topics.mjs';
import {serviceFixture} from '../service-fixture.mjs';
import {builderDeclaration} from '../builders-workflow.mjs';
import {CommunityAccountRegistry} from '../../src/accounts/community-accounts.mjs';

test('real PostgreSQL: consumer source triggers, published-only website hints and current builder/account owner authority',async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
 const pool=new pg.Pool({max:8,statement_timeout:10000});
 const endpoint='https://event-consumers.invalid';
 try{
  await migrate(pool);
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM pg_trigger WHERE tgname='web_event_capture_v1'")).rows[0].count,Object.keys(webEventSources).length);
  const publicConnection={actor:null,identity:'anonymous',endpoint,surface:'web'};
  const authority=createWebEventAuthorization({pool,endpoint});
  const publicationId=randomUUID();
  await pool.query("INSERT INTO site_publications_v1(id,endpoint,requested_by,snapshot,state,created_at,updated_at) VALUES($1,$2,'synthetic','{}','queued',now(),now())",[publicationId,endpoint]);
  await pool.query("UPDATE site_publications_v1 SET state='failed' WHERE id=$1",[publicationId]);
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM web_event_outbox_v1 WHERE module='site-content'")).rows[0].count,0,'Queued and failed work is never a public website hint');
  await pool.query("UPDATE site_publications_v1 SET state='published',published_at=now(),result=$2 WHERE id=$1",[publicationId,JSON.stringify({publicationId,siteVersion:'synthetic',publicUrl:'https://site.invalid/'})]);
  const published=(await pool.query("SELECT * FROM web_event_outbox_v1 WHERE module='site-content'")).rows;
  assert.equal(published.length,1);assert.equal(await authority.authorizeSource(publicConnection,published[0]),true);
  assert.ok(!JSON.stringify(published[0]).includes('snapshot'));
  assert.equal(await authority.authorizeSource({...publicConnection,endpoint:'https://other.invalid'},published[0]),false);
  const f=await serviceFixture(['binding','consent','builders'],pool,{migrateDatabase:false,endpoint,now:Math.floor(Date.now()/1000)});
  const other=await serviceFixture(['binding','consent','builders'],pool,{migrateDatabase:false,endpoint,now:f.now});
  const builderAuthority=createWebEventAuthorization({pool,endpoint,builders:f.builders});
  for(const visibility of ['Public','Private']){
   const builderId=randomUUID(),payload={id:randomUUID(),builderId,kind:'declare',expectedRevision:0,declaration:builderDeclaration('worker',f.actor.subjectId)};
   const grant=await f.authorize(payload,'builder.publish',{visibility,purpose:visibility==='Public'?'public-profile':'operational'});
   await f.builders.publish(f.actor,grant);
   const source=(await pool.query("SELECT * FROM web_event_outbox_v1 WHERE source_table='builder_events' AND module='builders' AND source_ref->>'id'=$1",[payload.id])).rows[0];
   assert.ok(source);assert.equal(await builderAuthority.authorizeSource(publicConnection,source),visibility==='Public');
   assert.equal(await builderAuthority.authorizeSource({...publicConnection,actor:f.actor,identity:f.actor.subjectId},source),true);
   assert.equal(await builderAuthority.authorizeSource({...publicConnection,actor:other.actor,identity:other.actor.subjectId},source),visibility==='Public');
  }
  const accountId=randomUUID(),noticeId=randomUUID();
  await pool.query("INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,'https://issuer.invalid','synthetic','email',now(),now())",[accountId,endpoint]);
  await pool.query("INSERT INTO operations_notices_v1(id,endpoint,version,content,state,created_by,updated_by,expires_at,created_at,updated_at) VALUES($1,$2,1,'{}','delivered','synthetic','synthetic',now()+interval '1 day',now(),now())",[noticeId,endpoint]);
  await pool.query('INSERT INTO account_operations_notices_v1(notice_id,account_id,delivered_at) VALUES($1,$2,now())',[noticeId,accountId]);
  const notice=(await pool.query("SELECT * FROM web_event_outbox_v1 WHERE source_table='account_operations_notices_v1' AND module='account'")).rows[0];
  const accounts=new CommunityAccountRegistry({db:pool,endpoint});
  const accountAuthority=createWebEventAuthorization({pool,endpoint,communityAccounts:accounts});
  const owner={...publicConnection,actor:{kind:'official-account',accountId,endpoint},identity:accountId};
  assert.equal(await accountAuthority.authorizeSource(owner,notice),true);
  assert.equal(await accountAuthority.authorizeSource(publicConnection,notice),false);
  assert.equal(await accountAuthority.authorizeSource({...owner,actor:{...owner.actor,accountId:randomUUID()}},notice),false);
 }finally{await pool.end();}
});
