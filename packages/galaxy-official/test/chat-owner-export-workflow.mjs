import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { productV2ExportDatasets } from '../src/infrastructure/lifecycle-export-v2.mjs';

// Synthetic persisted metadata tests owner filtering and export SQL/role grants.
// No archive transport, message delivery, Account verification or erasure claim.
export async function verifyChatOwnerMetadataExport(database = null, options = {}) {
  const f = await serviceFixture(['binding','data-export'], database, options);
  const p = await serviceFixture(['binding','data-export'], f.db, { ...options, migrateDatabase:false });
  const admin = options.adminDatabase ?? f.db, roomId = randomUUID(), datasets = productV2ExportDatasets.filter(name => name.startsWith('chat-'));
  const at = new Date(Date.now()-1000).toISOString(), later = new Date(Date.now()+3600000).toISOString();
  try {
    await admin.query(`INSERT INTO chat_rooms(room_id,creator_subject_id,operation_id,request_hash,title,created_at,updated_at)
      VALUES($1,$2,$3,'synthetic-room-hash','SHARED_ROOM_BODY_NOT_EXPORTED',$4,$4)`, [roomId,f.actor.subjectId,randomUUID(),at]);
    const owned = [];
    for (const who of [f,p]) {
      const subjectId = who.actor.subjectId, messageId = randomUUID(), operationId = randomUUID(), decisionId = randomUUID();
      owned.push({ subjectId,messageId,operationId,decisionId });
      await admin.query('INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$3,$4)',[roomId,subjectId,'subject:'+subjectId,at]);
      await admin.query(`INSERT INTO chat_decisions(decision_id,room_id,proposer_subject_id,member_revision,required_parties,votes,action,payload,request_hash,state,created_at,expires_at)
        VALUES($1,$2,$3,1,'[]','{"other":"PRIVATE_VOTE_NOT_EXPORTED"}','invite','{"private":"PROPOSAL_BODY_NOT_EXPORTED"}','synthetic','pending',$4,$5)`,[decisionId,roomId,subjectId,at,later]);
      await admin.query(`INSERT INTO chat_message_refs(message_id,room_id,subject_id,client_message_id,payload_hash,actor_kind,archive_id,sent_at,expires_at,content_bytes)
        VALUES($1,$2,$3,$4,'synthetic','human','synthetic-own-archive',$5,$6,19)`,[messageId,roomId,subjectId,randomUUID(),at,later]);
      if (who === f) await admin.query(`INSERT INTO chat_attachments
        (id,room_id,subject_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,message_id,created_at,prepare_expires_at,uploaded_at,expires_at,scan_result)
        VALUES($1,$2,$3,'synthetic-attachment','own.txt','text/plain',19,$4,'synthetic-own-key','synthetic-key','available',$5,$6,$7,$6,$8,'{"status":"clean"}')`,
        [randomUUID(),roomId,subjectId,'a'.repeat(64),messageId,at,later,later]);
      await admin.query(`INSERT INTO chat_message_operations(operation_id,room_id,message_id,subject_id,kind,request_hash,result,created_at,state,previous_content_bytes,target_content_bytes,base_revision)
        VALUES($1,$2,$3,$4,'edit','synthetic','{"revision":2,"editedAt":"2026-09-13T00:00:00Z","futurePrivateField":"NOT_EXPORTED"}',$5,'pending',12,19,1)`,[operationId,roomId,messageId,subjectId,at]);
      await admin.query("INSERT INTO chat_cursors(room_id,subject_id,cursor_kind,agent_ref,updated_at) VALUES($1,$2,'agent','agent:示例',$3)",[roomId,subjectId,at]);
      await admin.query('INSERT INTO chat_message_preferences(room_id,subject_id,message_id,hidden,updated_at) VALUES($1,$2,$3,true,$4)',[roomId,subjectId,messageId,at]);
      await admin.query("INSERT INTO chat_agent_grants(grant_id,room_id,subject_id,binding_id,mode,expires_at,created_at) VALUES($1,$2,$3,$4,'read',$5,$6)",[randomUUID(),roomId,subjectId,who.actor.bindingId,later,at]);
    }
    const ticket = await f.dataExport.create(f.actor,{id:randomUUID(),datasets});
    const pages = {};
    for (const dataset of datasets) {
      pages[dataset] = await f.dataExport.page(f.actor,{id:ticket.id,dataset,limit:1});
      assert.equal(pages[dataset].items.length,1,dataset);
      assert.equal(pages[dataset].nextAfter,null,dataset+' must not include the other subject');
    }
    assert.equal(String(pages['chat-message-receipts'].items[0].content_bytes),'19');
    const operation = pages['chat-message-operations'].items[0];
    assert.equal(operation.operation_id,owned[0].operationId); assert.equal(operation.state,'pending');
    assert.equal(String(operation.previous_content_bytes),'12'); assert.equal(String(operation.target_content_bytes),'19'); assert.equal(operation.base_revision,1);
    assert.equal(operation.result_revision,'2'); assert.equal('result' in operation,false);
    assert.equal(pages['chat-message-receipts'].items[0].message_id,owned[0].messageId);
    assert.equal(pages['chat-proposal-receipts'].items[0].decision_id,owned[0].decisionId);
    const serialized = JSON.stringify(pages);
    assert.equal(serialized.includes('NOT_EXPORTED'),false);
    assert.equal(serialized.includes(p.actor.subjectId),false);
    assert.equal(serialized.includes(owned[1].messageId),false);
    return {datasets:datasets.length,ownerOnly:true,messageBudgetFields:true,noBodyOrOtherVotes:true,transportNotTested:true};
  } finally { if(!database)await f.db.close(); }
}
