import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import pg from 'pg';
import {migrate,transaction} from "../../src/infrastructure/database.mjs";
import {migrations} from '../../src/infrastructure/migrations.mjs';
import {digest} from '../../src/shared/digest.mjs';
import {communityForumFixture} from '../community-forum-fixture.mjs';

const repository=fileURLToPath(new URL('../../../../',import.meta.url));
async function headModule(relative){
 const source=execFileSync('git',['show','HEAD:'+relative],{cwd:repository,encoding:'utf8'});
 const original=pathToFileURL(join(repository,relative));
 const exactImports=source.replace(/from\s+(['"])([^'"]+)\1/g,(_statement,_quote,specifier)=>
  'from '+JSON.stringify(specifier.startsWith('.')?new URL(specifier,original).href:import.meta.resolve(specifier)));
 return import('data:text/javascript;base64,'+Buffer.from(exactImports).toString('base64'));
}

test('real PostgreSQL81 ->83 preserves accepted forum facts and permits only normal API-role private bookmark mutations',
 {timeout:240000,skip:!process.env.GALAXY_COMMUNITY_PG_METADATA},async()=>{
 const metadata=JSON.parse(await readFile(process.env.GALAXY_COMMUNITY_PG_METADATA,'utf8'));
 assert.equal(metadata.status,'ready');assert.equal(metadata.localHost,'127.0.0.1');assert.equal(metadata.localPort,64717);
 assert.equal(metadata.database,'galaxy_chat_test');assert.equal(metadata.user,'galaxy_chat_test');
 const reportDirectory=process.env.GALAXY_COMMUNITY_PG_REPORT;assert.ok(reportDirectory);
 await mkdir(reportDirectory,{recursive:true});
 const report={startedAt:new Date().toISOString(),runId:metadata.runId,phases:[],checks:[],rawSecretsReturned:false,
  boundary:'Dedicated real PostgreSQL container through ROOT SSH tunnel. Actual HTTP/OIDC code/PKCE/ID-token and Ed25519 signatures; synthetic actors/content only. No production DB, frontend acceptance, model or permission bypass.'};
 const save=()=>writeFile(join(reportDirectory,'postgres-community-discovery.json'),JSON.stringify(report,null,2));
 const mark=async(name,data={})=>{report.phases.push({name,at:new Date().toISOString(),...data});await save();};
 const options={host:metadata.localHost,port:metadata.localPort,database:metadata.database,user:metadata.user,
  password:(await readFile(metadata.localSecretFile,'utf8')).trim(),max:4,connectionTimeoutMillis:5000,statement_timeout:15000,
  application_name:'galaxy-community-isolated-prepublication'};
 const admin=new pg.Pool(options);let runtimeDb,legacy,current;
 try{
  const actual=(await admin.query("SELECT current_setting('server_version') AS version,current_user,current_database() AS database,(SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public') AS public_tables")).rows[0];
  assert.equal(actual.public_tables,0,'Fresh isolated container required; never reset an existing database.');
  report.postgres=actual;await mark('fresh-real-database-verified');
  const head=await headModule('packages/galaxy-official/src/infrastructure/migrations.mjs'),prefix=migrations.filter(value=>value.version<=81),headPrefix=head.migrations.filter(value=>value.version<=81);
  assert.equal(prefix.length,81);assert.deepEqual(prefix.map(value=>({version:value.version,hash:digest(value.sql)})),headPrefix.map(value=>({version:value.version,hash:digest(value.sql)})));
  report.migration81={currentHash:digest(prefix.at(-1).sql),headHash:digest(headPrefix.at(-1).sql),all81Exact:true};
  await transaction(admin,async db=>{await db.query('SELECT pg_advisory_xact_lock(734912306)');
   await db.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
   for(const migration of prefix){await db.query(migration.sql);await db.query('INSERT INTO schema_migrations(version) VALUES($1)',[migration.version]);}
  });await mark('exact-head81-schema-applied');
  legacy=await communityForumFixture({database:admin,migrateDatabase:false});await legacy.login(legacy.owner,'real-pg-legacy-forum-author');
  const {CommunityForumV1:HeadForum}=await headModule("packages/galaxy-official/src/community/community-forum-v1.mjs");
  const originalForum=new HeadForum(legacy.owner.access,legacy.owner.consents,{accounts:legacy.owner.communityAccounts,publicWrites:legacy.owner.publicWrites});
  const p=await legacy.post({title:'[Synthetic local] Retained pre82 original post',body:'This exact old signed post remains available after the new topic/index and private bookmark migration.'}),input=await legacy.authorize(legacy.owner,'create-post',p);
  const published=await originalForum.publish(legacy.owner.actor,input);assert.equal(published.acknowledged,true);assert.equal((await originalForum.getPost(p.postId)).payload.body,p.body);
  const consentId=JSON.parse(Buffer.from(input.signedIntent.split('.')[1],'base64url')).id;
  const snapshot=async()=>({posts:(await admin.query('SELECT * FROM forum_posts_v1 ORDER BY id')).rows,
   events:(await admin.query('SELECT * FROM forum_events_v1 ORDER BY id')).rows,
   versions:(await admin.query('SELECT * FROM forum_versions_v1 ORDER BY id')).rows,
   permissions:(await admin.query('SELECT * FROM forum_permissions_v1 ORDER BY id')).rows,
   consents:(await admin.query('SELECT * FROM consents WHERE id=$1',[consentId])).rows});
  const before=await snapshot(),beforeHash=digest(JSON.stringify(before));
  report.legacy={postId:p.postId,versionId:p.versionId,operationId:p.operationId,payloadHash:digest(input.payloadJson),consentId,beforeHash};
  await mark('head-business-accepted-old-signed-post');await legacy.close();legacy=null;
  assert.equal(await migrate(admin,{roles:['api']}),83);
  const after=await snapshot(),{topic,...version}=after.versions[0];assert.equal(topic,null);after.versions=[version];
  assert.equal(digest(JSON.stringify(after)),beforeHash);report.originalRowsAndHashesUnchanged=true;await mark('81-to82-83-original-json-signatures-and-times-retained');
  runtimeDb=new pg.Pool({...options,options:'-c role=galaxy_api'});
  report.runtimeRole=(await runtimeDb.query(`SELECT current_user,session_user,r.rolsuper,r.rolcreatedb,r.rolcreaterole,
   EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tableowner=current_user) AS owns_any_public_table
   FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  assert.equal(report.runtimeRole.current_user,'galaxy_api');assert.equal(report.runtimeRole.rolsuper,false);assert.equal(report.runtimeRole.owns_any_public_table,false);
  current=await communityForumFixture({database:runtimeDb,migrateDatabase:false});await current.login(current.owner,'real-pg-current-author');await current.login(current.responder,'real-pg-current-reader');
  const oldRead=await current.ok('/v2/community/posts/'+p.postId,{authorization:false});assert.deepEqual(oldRead.payload,p);assert.equal(oldRead.topic,'unclassified');assert.equal(Object.hasOwn(oldRead.payload,'topic'),false);
  const next=await current.post({topic:'technology',title:'[Synthetic local] API-role topic publication',body:'Current normal actor publishes within one real topic using actual authorization.'});
  const written=await current.write(current.owner,'create-post',next);assert.equal(written.status,200,JSON.stringify(written.body));
  const page=await current.ok('/v2/community/posts/query',{authorization:false,input:{topic:'technology',query:'normal actor',order:'published'}});assert.equal(page.items[0].locator.postId,next.postId);assert.equal(page.items[0].topic,'technology');
  const own=await current.ok('/v2/community/posts/owned',{input:{topic:'technology',order:'published'}});assert.equal(own.items[0].payload.title,next.title);
  report.currentPost={postId:next.postId,versionId:next.versionId,operationId:next.operationId,payloadHash:digest(written.input.payloadJson),consentId:written.consentId};
  await mark('nonowner-api-role-real-oidc-and-signed-topic-http');
  const reference={kind:'forum-post',postId:next.postId},command={operationId:randomUUID(),reference,saved:true,expectedRevision:0},hash=digest(JSON.stringify(command));
  assert.equal((await current.ok('/v2/reading-bookmarks/status',{input:{reference}})).saved,false);
  const saved=await current.ok('/v2/reading-bookmarks/command',{input:command});assert.equal(saved.state,'acknowledged');assert.equal(saved.payloadHash,hash);assert.equal(saved.bookmark.saved,true);
  const receipt=await current.ok('/v2/reading-bookmarks/receipt',{input:{operationId:command.operationId,payloadHash:hash}});assert.deepEqual(receipt,saved);
  const collected=await current.ok('/v2/reading-bookmarks/query',{input:{kind:'forum-post'}});assert.equal(collected.items.length,1);assert.equal(collected.items[0].source.title,next.title);assert.equal(collected.items[0].source.state,'available');
  assert.equal((await current.ok('/v2/reading-bookmarks/status',{who:current.responder,input:{reference}})).saved,false);
  assert.equal((await current.ok('/v2/reading-bookmarks/query',{who:current.responder,input:{}})).items.length,0);
  assert.equal((await current.ok('/v2/reading-bookmarks/receipt',{who:current.responder,input:{operationId:command.operationId,payloadHash:hash}})).state,'absent');
  const readerSave=await current.ok('/v2/reading-bookmarks/command',{who:current.responder,input:{operationId:randomUUID(),reference,saved:true,expectedRevision:0}});assert.notEqual(readerSave.bookmark.id,saved.bookmark.id);
  const removedCommand={operationId:randomUUID(),reference,saved:false,expectedRevision:1},removed=await current.ok('/v2/reading-bookmarks/command',{input:removedCommand});assert.equal(removed.bookmark.saved,false);assert.equal(removed.bookmark.revision,2);
  assert.deepEqual(await current.ok('/v2/reading-bookmarks/command',{input:command}),saved,'Old exact receipt does not perform its historical save again.');
  assert.equal((await current.ok('/v2/reading-bookmarks/status',{input:{reference}})).saved,false);assert.equal((await current.ok('/v2/reading-bookmarks/query',{input:{}})).items.length,0);
  assert.equal((await current.ok('/v2/reading-bookmarks/status',{who:current.responder,input:{reference}})).saved,true);
  await mark('private-save-cancel-receipt-idempotence-and-owner-isolation');
  const denied=[
   ["UPDATE reading_bookmarks_v1 SET reference=reference WHERE id=$1",[saved.bookmark.id]],
   ["UPDATE reading_bookmarks_v1 SET reference_key='changed' WHERE id=$1",[saved.bookmark.id]],
   ["UPDATE reading_bookmarks_v1 SET subject_id=$2 WHERE id=$1",[saved.bookmark.id,current.responder.actor.subjectId]],
   ["UPDATE reading_bookmark_operations_v1 SET result='{}' WHERE operation_id=$1",[command.operationId]],
   ["DELETE FROM reading_bookmark_operations_v1 WHERE operation_id=$1",[command.operationId]],
   ["UPDATE forum_events_v1 SET payload_text='changed' WHERE id=$1",[p.operationId]],
   ["UPDATE forum_versions_v1 SET topic='life' WHERE id=$1",[next.versionId]],
  ];
  for(const [sql,args] of denied){await assert.rejects(runtimeDb.query(sql,args),error=>error.code==='42501');report.checks.push({action:sql.split(' WHERE ')[0],deniedCode:'42501'});}
  const bookmarkRows=(await admin.query('SELECT subject_id,id,reference,saved,revision FROM reading_bookmarks_v1 ORDER BY id')).rows;
  assert.equal(bookmarkRows.length,2);assert.equal(bookmarkRows.find(row=>row.subject_id===current.owner.actor.subjectId).saved,false);
  assert.equal(Number((await admin.query('SELECT count(*) n FROM reading_bookmark_operations_v1')).rows[0].n),3);
  assert.equal((await admin.query('SELECT payload_hash FROM forum_events_v1 WHERE id=$1',[p.operationId])).rows[0].payload_hash,report.legacy.payloadHash);
  await current.owner.consents.revoke(current.owner.actor,written.consentId);
  const afterRevocation=await current.ok('/v2/reading-bookmarks/query',{who:current.responder,input:{}});
  assert.equal(afterRevocation.items[0].saved,true);assert.equal(afterRevocation.items[0].source.state,'unavailable');assert.equal(Object.hasOwn(afterRevocation.items[0].source,'title'),false);assert.equal(JSON.stringify(afterRevocation).includes(next.body),false);
  await mark('direct-reference-owner-event-mutations-denied-and-revoked-source-hidden');
  report.complete=true;report.finishedAt=new Date().toISOString();report.schema=(await admin.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row=>row.version);
  report.bookmarkCounts={objects:2,immutableOperations:3};await save();
 }catch(error){report.complete=false;report.failure={code:error.code??'assertion-failed',message:error.message};await save();throw error;}
 finally{if(legacy)await legacy.close();if(current)await current.close();if(runtimeDb)await runtimeDb.end();await admin.end();}
});
