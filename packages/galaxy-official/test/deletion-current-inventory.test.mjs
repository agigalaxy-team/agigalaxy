import {migrations} from '../src/infrastructure/migrations.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {serviceFixture} from './service-fixture.mjs';
import {approveFixtureDeletion} from './deletion-execute-workflow.mjs';
import {executeDeletion,lockDeletionTables} from '../src/operations/deletion-execute.mjs';
import {captureDeletionLedger,replayDeletionLedger} from '../src/operations/deletion-ledger.mjs';
import {transaction} from "../src/infrastructure/database.mjs";
import {seedIndependentServiceFacts,assertIndependentServiceFacts} from './deletion-current-service-facts.mjs';

const scopes=['binding','consent','case-teaser','data-delete'];
const stamp=f=>new Date(f.now*1000).toISOString();
async function currentSources(f,other){
 const accountId=randomUUID(),at=stamp(f),workId='synthetic-work',scopeId=randomUUID(),archiveId=randomUUID(),independentArchive=randomUUID();
 await f.db.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
  VALUES($1::uuid,$2,'https://synthetic-accounts.invalid',($1::uuid)::text,'email',$3,$3)`,[accountId,f.access.endpoint,at]);
 await f.db.query("INSERT INTO official_account_profiles_v1(account_id,display_name,updated_at) VALUES($1,'Account name retained',$2)",[accountId,at]);
 await f.db.query(`INSERT INTO account_work_scopes_v1(account_id,scope_id,work_id,origin_subject_id,created_at) VALUES($1,$2,$3,$4,$5)`,[accountId,scopeId,workId,f.actor.subjectId,at]);
 await f.db.query(`INSERT INTO account_work_v1(account_id,work_id,origin_subject_id,scope_id,revision,state,upload_level,data,last_operation_id,created_at,updated_at)
  VALUES($1,$2,$3,$4,1,'stored','work-content','{"summary":{"title":"Owned uploaded prose"}}',$5,$6,$6)`,[accountId,workId,f.actor.subjectId,scopeId,randomUUID(),at]);
 const independentScope=randomUUID();
 await f.db.query(`INSERT INTO account_work_scopes_v1(account_id,scope_id,work_id,origin_subject_id,created_at) VALUES($1,$2,'other-work',$3,$4)`,[accountId,independentScope,other.actor.subjectId,at]);
 await f.db.query(`INSERT INTO account_work_v1(account_id,work_id,origin_subject_id,scope_id,revision,state,upload_level,data,last_operation_id,created_at,updated_at)
  VALUES($1,'other-work',$2,$3,1,'stored','work-content','{"summary":{"title":"Independent source"}}',$4,$5,$5)`,[accountId,other.actor.subjectId,independentScope,randomUUID(),at]);
 const archiveScope=randomUUID();
 for(const [id,origin,text] of [[archiveId,f.actor.subjectId,'Owned raw conversation'],[independentArchive,null,'Account-owned conversation']]){
  await f.db.query(`INSERT INTO private_conversation_archives_v1(id,account_id,origin_subject_id,title,selection,state,byte_length,chunk_count,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5::jsonb,'ready',1,1,$6,$6)`,[id,accountId,origin,text,JSON.stringify({scopeId:origin?archiveScope:randomUUID(),workspaceId:null,sessionIds:['synthetic']}),at]);
  await f.db.query('INSERT INTO private_conversation_chunks_v1(archive_id,sequence,content,byte_length) VALUES($1,0,$2,1)',[id,text]);
 }
 // These are independent account and operator facts even when an operator's
 // opaque ID happens to equal a local subject ID. Association is not ownership.
 const credentialId=randomUUID(),auditId=randomUUID(),eventId=randomUUID();
 await f.db.query(`INSERT INTO account_external_credentials_v1(id,account_id,issuer_id,issuer_uri,issuer_name,metadata,revocation,imported_at,checked_at)
  VALUES($1,$2,'synthetic','https://issuer.invalid','Issuer','{}','{}',$3,$3)`,[credentialId,accountId,at]);
 await f.db.query(`INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,selection,result,created_at)
  VALUES($1,$2,$3,'reader','users-query','{}','{}',$4)`,[auditId,f.access.endpoint,f.actor.subjectId,at]);
 await f.db.query(`INSERT INTO operations_model_settings_state_v1(endpoint,revision,updated_at) VALUES($1,3,$2)`,[f.access.endpoint,at]);
 await f.db.query(`INSERT INTO discovery_usage_events_v1(endpoint,id,account_id,visitor_id,profile_id,name,purpose,payload,created_at)
  VALUES($1,$2,$3,$4,$5,'search','site-usage-analytics','{"query":"Account usage fact"}',$6)`,[f.access.endpoint,eventId,accountId,randomUUID(),'account:'+accountId,at]);
 await f.db.query("INSERT INTO discovery_delivery_outbox_v1(endpoint,event_id,target) VALUES($1,$2,'openpanel')",[f.access.endpoint,eventId]);
 const independentFacts=await seedIndependentServiceFacts(f,accountId);
 return{accountId,workId,scopeId,archiveId,archiveScope,independentArchive,credentialId,auditId,eventId,independentFacts};
}
async function assertSources(db,f,s){
 await assertIndependentServiceFacts(db,s.independentFacts);
 assert.equal((await db.query('SELECT state,data FROM account_work_v1 WHERE account_id=$1 AND work_id=$2',[s.accountId,s.workId])).rows[0].data,null);
 const work=(await db.query('SELECT * FROM account_work_scopes_v1 WHERE account_id=$1 AND scope_id=$2',[s.accountId,s.scopeId])).rows[0];
 assert.equal(work.deleted_reason,'owner-deleted');assert.equal(work.deleted_by_subject_id,f.actor.subjectId);
 assert.equal((await db.query("SELECT state,data FROM account_work_v1 WHERE account_id=$1 AND work_id='other-work'",[s.accountId])).rows[0].state,'stored');
 assert.equal((await db.query('SELECT 1 FROM private_conversation_archives_v1 WHERE id=$1',[s.archiveId])).rows.length,0);
 assert.equal((await db.query('SELECT 1 FROM private_conversation_chunks_v1 WHERE archive_id=$1',[s.archiveId])).rows.length,0);
 assert.equal((await db.query('SELECT scope_id,reason FROM private_conversation_deletions_v1 WHERE archive_id=$1',[s.archiveId])).rows[0].scope_id,s.archiveScope);
 assert.equal((await db.query('SELECT content FROM private_conversation_chunks_v1 WHERE archive_id=$1',[s.independentArchive])).rows[0].content,'Account-owned conversation');
 assert.equal((await db.query('SELECT display_name FROM official_account_profiles_v1 WHERE account_id=$1',[s.accountId])).rows[0].display_name,'Account name retained');
 assert.equal((await db.query('SELECT 1 FROM account_external_credentials_v1 WHERE id=$1',[s.credentialId])).rows.length,1);
 assert.equal((await db.query('SELECT operator_id FROM business_admin_audit_v1 WHERE id=$1',[s.auditId])).rows[0].operator_id,f.actor.subjectId);
 assert.equal((await db.query('SELECT revision FROM operations_model_settings_state_v1 WHERE endpoint=$1',[f.access.endpoint])).rows[0].revision,3);
 assert.equal((await db.query('SELECT 1 FROM discovery_delivery_outbox_v1 WHERE event_id=$1',[s.eventId])).rows.length,1);
}

test('current schema deletion maps origin uploads while retaining independent account/operator facts, audit and delegated file locators',async t=>{
 const f=await serviceFixture(scopes);t.after(()=>f.db.close());
 const other=await serviceFixture(scopes,f.db,{migrateDatabase:false}),s=await currentSources(f,other),at=stamp(f);
 assert.equal((await f.db.query('SELECT max(version) version FROM schema_migrations')).rows[0].version,migrations.at(-1).version);
 await transaction(f.db,db=>lockDeletionTables(db));
 // A newly added, unmapped table still fails closed; there is no wildcard skip.
 await f.db.query('CREATE TABLE synthetic_unmapped_subject_data(id uuid PRIMARY KEY,body text)');
 await assert.rejects(transaction(f.db,db=>lockDeletionTables(db)),/inventory does not cover/);
 await f.db.query('DROP TABLE synthetic_unmapped_subject_data');
 const room=randomUUID(),file=randomUUID();
 await f.db.query(`INSERT INTO chat_rooms(room_id,creator_subject_id,operation_id,request_hash,title,state,created_at,updated_at)
  VALUES($1,$2,$3,'synthetic','Independent shared room','active',$4,$4)`,[room,other.actor.subjectId,randomUUID(),at]);
 await f.db.query(`INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$2,$3)`,[room,f.actor.subjectId,at]);
 await f.db.query(`INSERT INTO forum_attachments_v1(id,account_id,subject_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,created_at,prepare_expires_at)
  VALUES($1,$2,$3,'synthetic','Own file','text/plain',1,$4,'synthetic-object-key','synthetic-key',$5,$5)`,[file,s.accountId,f.actor.subjectId,'a'.repeat(64),at]);
 const command=await approveFixtureDeletion(f,f.db,{auditUntil:f.now+60});
 const result=await executeDeletion(f.db,command,{now:()=>f.now});
 assert.equal(result.audit.state,'retained-until-policy');assert.equal(result.state,'partial');
 assert.equal(result.deletedCounts.private_conversation_archives_v1,1);assert.equal(result.deletedCounts.private_conversation_chunks_v1,1);
 assert.equal(result.remainingCounts.chat_participants_v3,1);
 await assertSources(f.db,f,s);
 const pointer=(await f.db.query('SELECT storage_key,purge_pending,revoked_at,purged_at FROM forum_attachments_v1 WHERE id=$1',[file])).rows[0];
 assert.equal(pointer.storage_key,'synthetic-object-key');assert.equal(pointer.purge_pending,true);assert.ok(pointer.revoked_at);assert.equal(pointer.purged_at,null);
 assert.equal((await f.db.query('SELECT 1 FROM chat_rooms WHERE room_id=$1',[room])).rows.length,1);
 assert.equal((await f.db.query('SELECT 1 FROM chat_participants_v3 WHERE subject_id=$1',[other.actor.subjectId])).rows.length,1);
 assert.deepEqual(await executeDeletion(f.db,command,{now:()=>f.now+120}),result);
 const resumed=await executeDeletion(f.db,{...command,id:randomUUID(),expectedRevision:result.revision},{now:()=>f.now+60});
 assert.equal(resumed.audit.state,'erased');assert.equal(resumed.state,'partial');
 await assertSources(f.db,f,s);
});

test('current schema old snapshots replay executed deletion into quarantine without reviving origin data or deleting independent owners',async t=>{
 const f=await serviceFixture(scopes);t.after(()=>f.db.close());
 const other=await serviceFixture(scopes,f.db,{migrateDatabase:false}),s=await currentSources(f,other);
 const item={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Old source',summary:'Owned text',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
 await f.cases.submit(f.actor,await f.authorize(item));
 const command=await approveFixtureDeletion(f,f.db),snapshot=await f.db.dumpDataDir();
 const executed=await executeDeletion(f.db,command,{now:()=>f.now});
 assert.equal(executed.state,'primary-erased');
 const capture=await captureDeletionLedger(f.db,{endpoint:f.access.endpoint,now:()=>f.now+1});
 const restored=new PGlite({loadDataDir:snapshot});t.after(()=>restored.close());
 const recoveryId=randomUUID();await restored.query("INSERT INTO recovery_state(singleton,recovery_id,snapshot_id,status) VALUES(true,$1,$2,'quarantined')",[recoveryId,'a'.repeat(64)]);
 const replay={version:1,id:randomUUID(),recoveryId,endpoint:f.access.endpoint,ledgerSha256:capture.sha256,capturedNotBefore:f.now+1,executorRef:'synthetic-current-schema'};
 const result=await replayDeletionLedger(restored,capture.payloadJson,replay,{now:()=>f.now+10});
 assert.equal(result.requestsReplayed,1);assert.equal(result.publicActivationReady,false);
 await assertSources(restored,f,s);
 assert.equal((await restored.query('SELECT 1 FROM cases WHERE id=$1',[item.id])).rows.length,0);
 assert.equal((await restored.query('SELECT 1 FROM subjects WHERE id=$1',[f.actor.subjectId])).rows.length,0);
 assert.equal((await restored.query('SELECT 1 FROM chat_participants_v3 WHERE subject_id=$1',[f.actor.subjectId])).rows.length,0);
 assert.equal((await restored.query('SELECT 1 FROM subjects WHERE id=$1',[other.actor.subjectId])).rows.length,1);
 assert.equal((await restored.query('SELECT status FROM recovery_state')).rows[0].status,'quarantined');
 assert.deepEqual(await replayDeletionLedger(restored,capture.payloadJson,replay,{now:()=>f.now+20}),result);
});
