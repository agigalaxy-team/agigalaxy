import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import canonicalize from 'canonicalize';
import {digest} from '../src/shared/digest.mjs';
import {chatSendRequestHash} from '../src/shared/chat-message-request-hash.mjs';
import {migrations} from '../src/infrastructure/migrations.mjs';
import {chatFixture} from './chat-workflow.mjs';
import {chatRoomGovernanceV2MigrationSql} from '../src/infrastructure/chat-room-governance-v2-schema.mjs';
import {moderationNotificationsV2MigrationSql} from '../src/infrastructure/moderation-notifications-v2-schema.mjs';

test('actual legacy76 DDL upgrades add default approval rules and preserve prior IDs, canonical bytes and fixed TTL',async()=>{
 const db=new PGlite();try{
  for(const migration of migrations.filter(item=>item.version<=76))await db.exec(migration.sql);
  const f=await chatFixture({database:db,migrateDatabase:false}),actor=f.people[0],roomId=randomUUID();
  // Seed the real legacy room before applying its governance migration; the
  // current create service also requires newer participant integration tables.
  await db.query("INSERT INTO chat_rooms(room_id,creator_subject_id,operation_id,request_hash,title,created_at,updated_at) VALUES($1,$2,$3,$4,'Synthetic legacy room',now(),now())",[roomId,actor.subjectId,randomUUID(),'synthetic-legacy-room']);
  await db.query('INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$2,now())',[roomId,actor.subjectId]);
  const decisionId=randomUUID(),payload={decisionId,expectedRevision:1,action:'retention',retentionDays:7},hash=digest(canonicalize(payload)),messageId=randomUUID(),clientMessageId=randomUUID(),expiry=new Date((f.now()+7*86400)*1000).toISOString();
  // Privileged legacy fixture data; no product path accepts these SQL rows.
  await db.query(`INSERT INTO chat_decisions(decision_id,room_id,proposer_subject_id,member_revision,required_parties,votes,action,payload,request_hash,state,created_at,expires_at)
   VALUES($1,$2,$3,1,'[]','{}','retention',$4,$5,'pending',now(),now()+interval '7 days')`,[decisionId,roomId,actor.subjectId,JSON.stringify(payload),hash]);
  await db.query(`INSERT INTO chat_message_refs(message_id,room_id,subject_id,client_message_id,payload_hash,actor_kind,state,sent_at,expires_at)
   VALUES($1,$2,$3,$4,$5,'human','accepted',now(),$6)`,[messageId,roomId,actor.subjectId,clientMessageId,await chatSendRequestHash({clientMessageId,text:'Synthetic retained legacy metadata',replyTo:null}),expiry]);
  const before={room:(await db.query('SELECT * FROM chat_rooms WHERE room_id=$1',[roomId])).rows[0],decision:(await db.query('SELECT * FROM chat_decisions WHERE decision_id=$1',[decisionId])).rows[0],message:(await db.query('SELECT * FROM chat_message_refs WHERE message_id=$1',[messageId])).rows[0]};
  await db.exec(moderationNotificationsV2MigrationSql);await db.exec(chatRoomGovernanceV2MigrationSql);

  const room=(await db.query('SELECT * FROM chat_rooms WHERE room_id=$1',[roomId])).rows[0],decision=(await db.query('SELECT * FROM chat_decisions WHERE decision_id=$1',[decisionId])).rows[0],message=(await db.query('SELECT * FROM chat_message_refs WHERE message_id=$1',[messageId])).rows[0];
  const{join_rule,administrator_ids,...legacyRoom}=room;assert.deepEqual(legacyRoom,before.room);assert.equal(join_rule.mode,'approval-required');assert.deepEqual(administrator_ids,[]);
  const{authority_rule_version,authority_rule_hash,...legacyDecision}=decision;assert.deepEqual(legacyDecision,before.decision);assert.equal(authority_rule_version,null);assert.equal(authority_rule_hash,null);assert.deepEqual(message,before.message);
  await assert.rejects(db.query('UPDATE chat_rooms SET join_rule=$2 WHERE room_id=$1',[roomId,JSON.stringify({mode:'open'})]),error=>error.code==='23514');
  await assert.rejects(db.query('UPDATE chat_rooms SET join_rule=$2 WHERE room_id=$1',[roomId,JSON.stringify({...join_rule,mode:'open'})]),error=>error.code==='23514');
  await assert.rejects(db.query('UPDATE chat_decisions SET authority_rule_hash=$2 WHERE decision_id=$1',[decisionId,hash]),error=>error.code==='23514');
  await assert.rejects(db.query('UPDATE chat_rooms SET administrator_ids=$2 WHERE room_id=$1',[roomId,JSON.stringify(Array(10).fill(actor.subjectId))]),error=>error.code==='23514');
  // Only after checking the exact legacy rows, complete current integration
  // migrations before invoking the current read service.
  for(const migration of migrations.filter(item=>item.version>78))await db.exec(migration.sql);
  const view=await f.chat.get(actor,roomId);assert.equal(view.joinRule.mode,'approval-required');assert.equal(view.joinRule.version,1);assert.equal(view.joinRule.decisionId,null);assert.deepEqual(view.administratorSubjectIds,[]);
 }finally{await db.close();}
});
