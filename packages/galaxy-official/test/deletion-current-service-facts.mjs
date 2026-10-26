import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

// Nonempty authority records from every table added to the closed deletion
// inventory after schema120. External subjects deliberately equal the erased
// local ID; a textual association must never become ownership.
export async function seedIndependentServiceFacts(f,accountId){
 const db=f.db,endpoint=f.access.endpoint,at=new Date(f.now*1000).toISOString(),operator='d'.repeat(64),issuer='https://independent.invalid';
 const populated=new Set();
 const put=async(table,row)=>{const keys=Object.keys(row);await db.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));populated.add(table);};
 const json=JSON.stringify,dates={created_at:at,updated_at:at},original=f.actor.subjectId;
 await put('operations_operator_principals_v1',{operator_id:operator,endpoint,issuer,external_subject:original,display_name:'Independent operator',...dates});
 populated.delete('operations_operator_principals_v1');
 const registration=randomUUID(),generation=randomUUID();
 await put('operations_registered_subjects_v1',{id:registration,endpoint,issuer,external_subject:original});
 await put('operations_registered_generations_v1',{id:generation,endpoint,issuer,state:'complete',started_at:at,completed_at:at,observed_count:1});
 await put('operations_registered_entries_v1',{generation_id:generation,registration_id:registration,present:true,email:'independent@example.invalid',enabled:false,email_verified:true,observed_at:at});
 await put('operations_registered_directory_v1',{endpoint,issuer,generation_id:generation});
 await put('operations_registered_commands_v1',{operation_id:randomUUID(),endpoint,operator_id:operator,registration_id:registration,kind:'login-disable',state:'completed',input:json({subjectId:original}),result:json({disabled:true}),...dates});
 await put('operations_registered_login_fences_v1',{scope_hash:'e'.repeat(64),issuer,external_subject:original,revoked_before:at});
 const managementGeneration=randomUUID();
 await put('operations_management_accounts_v1',{operator_id:operator,endpoint,issuer,external_subject:original,version:2,login_blocked:true,created_by:operator,...dates});
 await put('operations_management_generations_v1',{id:managementGeneration,endpoint,issuer,state:'complete',started_at:at,completed_at:at,observed_count:1});
 await put('operations_management_entries_v1',{generation_id:managementGeneration,operator_id:operator,issuer,external_subject:original,username:'independent',first_name:'',last_name:'',email_verified:false,enabled:false,admission:'reader',required_actions:[]});
 await put('operations_management_directory_v1',{endpoint,issuer,generation_id:managementGeneration});
 await put('operations_management_commands_v1',{operation_id:randomUUID(),endpoint,operator_id:operator,target_operator_id:original,kind:'login-disable',state:'completed',input:json({subjectId:original}),result:json({disabled:true}),...dates});
 await put('operations_management_login_fences_v1',{endpoint,issuer,external_subject:original,revoked_before:at});
 const role=randomUUID(),ai=randomUUID();
 await put('operations_business_roles_v1',{id:role,endpoint,name:'Independent AI reader',enabled:true,version:1,permissions:['workbench.read'],created_by:operator,updated_by:operator,...dates});populated.delete('operations_business_roles_v1');
 await put('operations_ai_work_accounts_v1',{id:ai,endpoint,domain:'overview',name:'Independent AI',description:'Preserved operational identity',enabled:false,version:1,authorization_version:2,...dates});
 await put('operations_ai_work_assignments_v1',{id:randomUUID(),endpoint,ai_account_id:ai,role_id:role,enabled:false,version:2,...dates});
 await put('operations_ai_work_commands_v1',{endpoint,operation_id:randomUUID(),ai_account_id:ai,domain:'overview',operator_id:operator,kind:'state-save',selection:json({subjectId:original,enabled:false}),result:json({enabled:false}),reason:'Independent operator choice',created_at:at});
 const setting=randomUUID();
 await put('operations_system_settings_versions_v1',{id:setting,endpoint,section:'mail',revision:1,configuration:json({connectionRef:'synthetic-reference'}),operator_id:operator,created_at:at});
 await put('operations_system_settings_commands_v1',{endpoint,operation_id:randomUUID(),operator_id:operator,operator_role:'administrator',section:'mail',kind:'apply',input:'{}',version_id:setting,revision:1,state:'completed',result:'{}',...dates});
 await put('operations_system_settings_heads_v1',{endpoint,section:'mail',revision:1,version_id:setting,updated_at:at});
 await put('operations_system_general_publications_v1',{endpoint,operation_id:randomUUID(),operator_id:operator,input:json({sourceSubject:original}),result:'{}',created_at:at});
 const target=randomUUID();
 await put('community_accounts',{id:target,endpoint,issuer,external_subject:target,verification_method:'email',verified_at:at,created_at:at});populated.delete('community_accounts');
 await put('account_follows_v1',{id:randomUUID(),account_id:accountId,target_account_id:target,following:true,revision:1,created_at:at,followed_at:at,updated_at:at});
 await put('account_follow_operations_v1',{account_id:accountId,operation_id:randomUUID(),request_hash:'a'.repeat(64),result:json({following:true}),created_at:at});
 // The migration127 account INSERT trigger creates these reservations. Keep
 // their UID and source authority, even when a linked local ID is erased.
 assert.equal((await db.query('SELECT 1 FROM official_account_registrations_v1 WHERE account_id=$1',[accountId])).rows.length,1);populated.add('official_account_registrations_v1');
 const delegation=randomUUID();
 await put('operations_ai_role_delegations_v1',{id:delegation,endpoint,source_ai_account_id:ai,version:1,enabled:false,target_ai_account_ids:[],grantable_permissions:['workbench.read'],allowed_management_actions:['read'],created_by:operator,updated_by:operator,...dates});
 await put('operations_ai_role_delegation_events_v1',{endpoint,operation_id:randomUUID(),delegation_id:delegation,version:1,actor_kind:'business-operator',actor_id:original,kind:'config-save',selection:'{}',result:'{}',created_at:at});
 await put('operations_ai_duty_operations_v1',{operation_id:randomUUID(),endpoint,task_id:randomUUID(),ai_account_id:ai,kind:'synthetic-review',request:json({subjectId:original}),proposal:'{}',binding:'{}',state:'completed',result:'{}',...dates});
 const config=randomUUID(),task=randomUUID(),event=randomUUID(),call=randomUUID(),strategyVersion=randomUUID();
 await put('operations_autonomy_runtime_v1',{endpoint,revision:1,configuration:'{}',updated_by:original,updated_at:at});
 await put('operations_autonomy_runtime_versions_v1',{endpoint,revision:1,configuration:'{}',operator_id:original,created_at:at});
 await put('operations_autonomy_configs_v1',{id:config,endpoint,domain:'overview',revision:1,enabled:false,configuration:'{}',prompt_version:1,plan_version:1,updated_by:original,...dates});
 await put('operations_autonomy_versions_v1',{config_id:config,revision:1,configuration:'{}',prompt_version:1,plan_version:1,operator_id:original,created_at:at});
 await put('operations_autonomy_tasks_v1',{id:task,endpoint,config_id:config,config_revision:1,ai_account_id:ai,domain:'overview',source:'workbench',source_key:'synthetic-source',title:'Independent completed operation',mode:'code',state:'completed',model_state:'not-required',business_state:'completed',configuration:'{}',prompt_version:1,plan_version:1,session_id:randomUUID(),target_type:'account',target_id:original,due_at:at,...dates});
 await put('operations_autonomy_events_v1',{id:event,endpoint,domain:'overview',event_key:'synthetic-event',event_type:'synthetic-review',target_type:'account',target_id:original,created_at:at,available_at:at,task_id:task});
 await put('operations_autonomy_receipts_v1',{id:randomUUID(),endpoint,task_id:task,operation_id:randomUUID(),action:'synthetic-review',target_type:'account',target_id:original,state:'completed',basis:'Independent operator history',details:'{}',created_at:at});
 await put('operations_autonomy_tool_calls_v1',{endpoint,task_id:task,call_id:call,tool:'synthetic-read',arguments:json({subjectId:original}),operation_id:randomUUID(),state:'completed',...dates});
 await put('operations_autonomy_commands_v1',{endpoint,operation_id:randomUUID(),operator_id:original,kind:'synthetic-stop',input:'{}',result:'{}',created_at:at});
 await put('operations_autonomy_decisions_v1',{endpoint,task_id:task,call_id:call,operation_id:randomUUID(),decision_operation_id:randomUUID(),operator_id:original,decision:'no-action',created_at:at});
 await put('operations_autonomy_workbench_runs_v1',{endpoint,task_id:task,turn_operation_id:randomUUID(),native_run_id:'synthetic-completed',model_state:'completed',state:'completed',...dates});
 await put('operations_autonomy_health_v1',{endpoint,started_at:at,checked_at:at,last_tick_at:at});
 await put('operations_p13_strategy_versions_v1',{id:strategyVersion,endpoint,version:1,configuration:'{}',created_by:original,created_at:at});populated.delete('operations_p13_strategy_versions_v1');
 await put('operations_autonomy_strategy_schedules_v1',{endpoint,strategy_id:randomUUID(),version_id:strategyVersion,next_due_at:at});
 await put('operations_autonomy_event_consumers_v1',{endpoint,event_id:event,strategy_id:randomUUID(),task_id:task});
 assert.equal(populated.size,39,'all 39 formerly unclassified tables contain independent records');
 const snapshots={};for(const table of populated)snapshots[table]=(await db.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
 return snapshots;
}
export async function assertIndependentServiceFacts(db,snapshots){
 for(const [table,rows]of Object.entries(snapshots))assert.deepEqual((await db.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows,rows,table+' independent authority or history changed during local ID deletion');
}
