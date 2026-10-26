import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {captureCurrentRecoveryFacts,currentRecoveryFactsCaptureSql,reconcileCurrentRecoveryFacts} from '../src/operations/maintenance-recovery-facts.mjs';

// Real current 110 schema, SQL capture and restored older database. The room
// transport is the existing explicit fixture double. No host, SMTP or storage
// action occurs and all credentials/subjects here are synthetic.
test('maintenance merges current security and model versions, source gates and outbound effects into an exact older quarantine',async t=>{
 const f=await accountChatFixture();t.after(f.close);const at=new Date(f.now()*1000),operator='current-recovery-operator',roleId=randomUUID(),planId=randomUUID(),runId=randomUUID(),recipients=[randomUUID(),randomUUID()],modelId=randomUUID();
 await f.db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operator.example.invalid',$1,'Synthetic current operator',$3,$3)",[operator,f.endpoint,at]);
 await f.db.query("INSERT INTO operations_business_roles_v1(id,endpoint,name,enabled,version,permissions,created_by,updated_by,created_at,updated_at) VALUES($1,$2,'Synthetic role',true,1,ARRAY['content.hide'],$3,$3,$4,$4)",[roleId,f.endpoint,operator,at]);
 await f.db.query("INSERT INTO operations_smtp_settings_v1(endpoint,version,configuration,updated_by,updated_at) VALUES($1,1,'{\"enabled\":true,\"credentialRef\":\"old-synthetic-ref\"}',$2,$3)",[f.endpoint,operator,at]);
 await f.db.query("INSERT INTO operations_model_settings_versions_v1(id,endpoint,version,configuration,operator_id,created_at) VALUES($1,$2,1,'{\"bindings\":{\"overview\":\"old-enabled-model\"}}',$3,$4)",[modelId,f.endpoint,operator,at]);
 await f.db.query('INSERT INTO operations_model_settings_state_v1(endpoint,revision,active_id,updated_at) VALUES($1,1,$2,$3)',[f.endpoint,modelId,at]);
 const roomId=await joinAccountConversation(f,f.people[0],f.people[1]),sent=await f.chat.send(f.people[0],roomId,{clientMessageId:randomUUID(),text:'Synthetic point source'});
 await f.db.query("INSERT INTO operations_messaging_plans_v1(id,endpoint,version,revision,state,created_by,updated_by,created_at,updated_at) VALUES($1,$2,1,1,'active',$3,$3,$4,$4)",[planId,f.endpoint,operator,at]);
 await f.db.query("INSERT INTO operations_messaging_versions_v1(plan_id,version,config,created_by,created_at) VALUES($1,1,'{}',$2,$3)",[planId,operator,at]);
 await f.db.query("INSERT INTO operations_messaging_runs_v1(id,endpoint,plan_id,plan_version,occurrence_key,state,approved_by,approved_role,frozen_at,audience_count,created_at,updated_at) VALUES($1,$2,$3,1,'synthetic-once','running',$4,'administrator',$5,2,$5,$5)",[runId,f.endpoint,planId,operator,at]);
 for(let i=0;i<2;i++)await f.db.query("INSERT INTO operations_messaging_recipients_v1(id,run_id,account_id,channel,state,updated_at) VALUES($1,$2,$3,'email','pending',$4)",[recipients[i],runId,f.people[i].accountId,at]);
 const job=randomUUID();await f.db.query("INSERT INTO galaxy_jobs.job(id,name,state,data) VALUES($1,'messaging-delivery','created','{}')",[job]);
 const snapshot=await f.db.dumpDataDir();
 await f.db.query('UPDATE operations_business_roles_v1 SET enabled=false,permissions=ARRAY[]::text[],version=2 WHERE id=$1',[roleId]);
 await f.db.query('DELETE FROM operations_smtp_settings_v1');
 const currentModel=randomUUID();await f.db.query("INSERT INTO operations_model_settings_versions_v1(id,endpoint,version,configuration,operator_id,created_at) VALUES($1,$2,2,'{\"bindings\":{}}',$3,$4)",[currentModel,f.endpoint,operator,at]);
 await f.db.query('UPDATE operations_model_settings_state_v1 SET revision=2,active_id=$1,draft_id=NULL,pending_operation=NULL',[currentModel]);
 await f.db.query("UPDATE chat_message_refs SET revision=2,payload_hash=$2,archive_id='current-only-body',state='retracted',retracted_at=$3 WHERE message_id=$1",[sent.messageId,'e'.repeat(64),at]);
 await f.db.query("UPDATE operations_messaging_recipients_v1 SET state='submitted',submitted_at=$2 WHERE id=$1",[recipients[0],at]);
 await f.db.query("UPDATE operations_messaging_recipients_v1 SET state='submitting',retryable=true,lease_until=$2 WHERE id=$1",[recipients[1],new Date(at.getTime()+60000)]);
 const facts=await captureCurrentRecoveryFacts(f.db,{endpoint:f.endpoint,now:f.now});
 const nativeResults=await f.db.exec(currentRecoveryFactsCaptureSql(f.endpoint));
 const nativeFacts=nativeResults.find(row=>row.rows?.[0]?.jsonb_build_object)?.rows[0].jsonb_build_object;
 assert(nativeFacts);assert.equal(nativeFacts.schema,facts.schema);assert.deepEqual(nativeFacts.tables.operations_model_settings_state_v1.rows.map(x=>x.active_id),[currentModel]);assert.equal(nativeFacts.gates.chat_message_refs.rows.find(x=>x.message_id===sent.messageId).state,'retracted');
 assert(!JSON.stringify(facts.gates).includes('Synthetic point source'),'source contribution holds gating metadata rather than old message text');
 const restored=new PGlite({loadDataDir:snapshot});t.after(()=>restored.close());const recoveryId=randomUUID();await restored.query("INSERT INTO recovery_state(singleton,recovery_id,snapshot_id,status) VALUES(true,$1,$2,'quarantined')",[recoveryId,'a'.repeat(64)]);
 await assert.rejects(reconcileCurrentRecoveryFacts(restored,facts,{endpoint:f.endpoint,recoveryId:randomUUID()}),{code:'maintenance_exact_quarantine_required'});
 const result=await reconcileCurrentRecoveryFacts(restored,facts,{endpoint:f.endpoint,recoveryId});
 assert.equal(result.authorityPreserved,true);assert.equal(result.quarantined,true);assert.equal(result.publicActivation,false);
 assert.equal((await restored.query('SELECT enabled FROM operations_business_roles_v1 WHERE id=$1',[roleId])).rows[0].enabled,false);
 assert.equal((await restored.query('SELECT * FROM operations_smtp_settings_v1')).rows.length,0,'old enabled transport cannot reappear when current configuration is absent');
 assert.equal((await restored.query('SELECT active_id FROM operations_model_settings_state_v1')).rows[0].active_id,currentModel);
 const source=(await restored.query('SELECT state,archive_id,revision FROM chat_message_refs WHERE message_id=$1',[sent.messageId])).rows[0];assert.equal(source.state,'retracted');assert.equal(source.archive_id,null);assert.equal(source.revision,2);
 const delivery=(await restored.query('SELECT id,state,retryable FROM operations_messaging_recipients_v1 ORDER BY id')).rows;
 assert.equal(delivery.find(x=>x.id===recipients[0]).state,'submitted');assert.equal(delivery.find(x=>x.id===recipients[1]).state,'unknown');assert.equal(delivery.find(x=>x.id===recipients[1]).retryable,false);
 assert.equal((await restored.query('SELECT state FROM operations_messaging_plans_v1')).rows[0].state,'paused');assert.equal((await restored.query('SELECT state FROM galaxy_jobs.job WHERE id=$1',[job])).rows[0].state,'cancelled');
 assert.equal((await restored.query('SELECT status FROM recovery_state')).rows[0].status,'quarantined');
});
