import {transaction} from '../database.mjs';

const fail=code=>Object.assign(Error(code),{code});
const quote=name=>{if(!/^[a-z][a-z0-9_]*$/.test(name))throw fail('maintenance_recovery_identifier_invalid');return '"'+name+'"';};
const normalize=value=>JSON.parse(JSON.stringify(value));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const recoveryAuthorityTables=Object.freeze([
 'subjects','subject_control_events','subject_control_heads','device_authorizations','recovery_authorizations','identity_control_operations',
 'binding_challenges','bindings','consents','external_identity_links','community_accounts','community_account_links','official_account_profiles_v1','official_account_type_history_v1',
 'chat_rooms','chat_memberships','chat_participants_v3','chat_decisions','chat_agent_grants',
 'operations_operator_principals_v1','operations_permission_authority_v1','operations_business_roles_v1','operations_role_assignments_v1','operations_automation_grants_v1','operations_permission_events_v1',
 'operations_maintenance_plans_v1','operations_maintenance_events_v1',
 'operations_model_settings_state_v1','operations_model_settings_versions_v1','operations_model_settings_operations_v1',
 'operations_smtp_settings_v1','operations_smtp_commands_v1','operations_smtp_events_v1','operations_smtp_tests_v1',
 'operations_agentos_executions_v1','operations_agentos_source_refs_v1','operations_agentos_commands_v1','operations_agentos_tool_calls_v1',
]);
export const recoveryOutboundTables=Object.freeze([
 'operations_notices_v1','account_operations_notices_v1','operations_messaging_plans_v1','operations_messaging_versions_v1','operations_messaging_commands_v1',
 'operations_messaging_events_v1','operations_messaging_runs_v1','operations_messaging_recipients_v1','operations_messaging_attempts_v1','operations_messaging_announcements_v1',
]);
// These are current grants/visibility facts, not a new read permission. Private
// governance records stay in a protected restoration artifact, never in API DTOs
// or a model prompt. Their original source/revision/deadline remains unchanged.
export const recoveryGovernanceTables=Object.freeze([
 'forum_permissions_v1','forum_reports_v1','forum_governance_events_v1','account_chat_reports_v1','account_chat_governance_events_v1','account_chat_governance_materials_v1',
 'operations_chat_message_visibility_v1','operations_content_visibility_v1','forum_operations_events_v1',
]);
const sourceGates=Object.freeze({
 forum_posts_v1:['state','current_version_id','head_version','erased_at'],
 forum_versions_v1:['state','permission_id','payload_hash','published_until','erased_at'],
 forum_replies_v1:['state','permission_id','payload_hash','published_until','erased_at','revision'],
 chat_rooms:['state','revision','member_revision','owner_subject_id'],
 chat_memberships:['left_at','dismissed_revision','controller_ref'],
 chat_participants_v3:['state','left_at','revision'],
 chat_message_refs:['state','revision','payload_hash','archive_id','expires_at','retracted_at','purge_pending'],
 chat_agent_grants:['revoked_at','expires_at'],
 chat_attachments:['state','expires_at','revoked_at','purged_at','purge_pending','sha256','message_id'],
 forum_attachments_v1:['state','expires_at','revoked_at','purged_at','purge_pending','sha256'],
 feedback_attachments_v1:['state','expires_at','revoked_at','purge_pending','sha256'],
 outcome_materials_v2:['state','expires_at','purged_at','purge_pending','sha256','revision','approval_id'],
 task_materials_v1:['erased_at','expires_at','text_hash'],
 room_shared_summaries:['state','retracted_at','expires_at','notice_hash'],
 personal_summary_versions:['state'],choice_snapshot_versions:['state'],
});
const metadata=async db=>{
 const columns=(await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
 const primary=(await db.query(`SELECT r.relname AS table_name,a.attname AS column_name FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.num WHERE c.contype='p' AND n.nspname='public' ORDER BY r.relname,k.ord`)).rows;
 return{columns:Map.groupBy(columns,x=>x.table_name),primary:Map.groupBy(primary,x=>x.table_name)};
};
const keysFor=(schema,table)=>(schema.primary.get(table)??[]).map(x=>x.column_name);
const keyWhere=(keys,row,start=1)=>({sql:keys.map((key,i)=>quote(key)+' IS NOT DISTINCT FROM $'+(start+i)).join(' AND '),values:keys.map(key=>row[key])});
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
const jsonObject=entries=>Array.from({length:Math.ceil(entries.length/40)},(_,i)=>'jsonb_build_object('+entries.slice(i*40,(i+1)*40).join(',')+')').join('||')||"'{}'::jsonb";
export function currentRecoveryFactsCaptureSql(endpoint){
 if(new URL(endpoint).origin!==endpoint||!endpoint.startsWith('https://'))throw fail('maintenance_recovery_endpoint_invalid');
 const full=[...recoveryAuthorityTables,...recoveryOutboundTables,...recoveryGovernanceTables,'lifecycle_erasure_records'];
 const pk=table=>`(SELECT jsonb_agg(a.attname ORDER BY k.ord) FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.num WHERE c.contype='p' AND n.nspname='public' AND r.relname=${literal(table)})`;
 const tables=full.map(table=>literal(table)+`,jsonb_build_object('keys',${pk(table)},'rows',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM ${quote(table)} t))`);
 const gates=Object.entries(sourceGates).map(([table,fields])=>{
  const cols=`(SELECT coalesce(jsonb_agg(column_name ORDER BY ordinal_position),'[]'::jsonb) FROM information_schema.columns WHERE table_schema='public' AND table_name=${literal(table)} AND column_name=ANY(ARRAY[${fields.map(literal)}]::text[]))`;
  return literal(table)+`,jsonb_build_object('keys',${pk(table)},'columns',${cols},'rows',(SELECT coalesce(jsonb_agg((SELECT jsonb_object_agg(c,to_jsonb(t)->c) FROM jsonb_array_elements_text(${pk(table)}||${cols}) c)),'[]'::jsonb) FROM ${quote(table)} t))`;
 });
 return `BEGIN; LOCK TABLE ${[...new Set([...full,...Object.keys(sourceGates)])].map(quote).join(',')} IN SHARE MODE; SELECT jsonb_build_object('version',1,'endpoint',${literal(endpoint)},'capturedAt',floor(extract(epoch FROM transaction_timestamp()))::bigint,'schema',(SELECT max(version) FROM schema_migrations),'tables',(${jsonObject(tables)}),'gates',(${jsonObject(gates)})); COMMIT;`;
}

export async function captureCurrentRecoveryFacts(database,{endpoint,now=()=>Math.floor(Date.now()/1000),maxBytes=20*1024*1024}={}){
 if(new URL(endpoint).origin!==endpoint||!endpoint.startsWith('https://'))throw fail('maintenance_recovery_endpoint_invalid');
 return transaction(database,async db=>{
  const schema=await metadata(db),full=[...recoveryAuthorityTables,...recoveryOutboundTables,...recoveryGovernanceTables,'lifecycle_erasure_records'];
  const gates=Object.keys(sourceGates),tables=[...new Set([...full,...gates])];
  if(tables.some(table=>!schema.columns.has(table)||!keysFor(schema,table).length))throw fail('maintenance_recovery_schema_not_supported');
  await db.query('LOCK TABLE '+tables.map(quote).join(',')+' IN SHARE MODE');
  const capturedAt=now(),facts={version:1,endpoint,capturedAt,tables:{},gates:{},schema:(await db.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version};let bytes=0;
  const add=value=>{bytes+=Buffer.byteLength(JSON.stringify(value));if(bytes>maxBytes)throw fail('maintenance_recovery_facts_limit');return value;};
  for(const table of full){const keys=keysFor(schema,table),rows=normalize((await db.query('SELECT to_jsonb(t) AS row FROM '+quote(table)+' t ORDER BY '+keys.map(quote).join(','))).rows.map(x=>x.row));if(rows.length>100000)throw fail('maintenance_recovery_facts_limit');facts.tables[table]=add({keys,rows});}
  for(const table of gates){const available=new Set(schema.columns.get(table).map(x=>x.column_name)),keys=keysFor(schema,table),columns=sourceGates[table].filter(x=>available.has(x));
   const rows=normalize((await db.query('SELECT '+[...new Set([...keys,...columns])].map(quote).join(',')+' FROM '+quote(table)+' ORDER BY '+keys.map(quote).join(','))).rows);if(rows.length>100000)throw fail('maintenance_recovery_facts_limit');facts.gates[table]=add({keys,columns,rows});}
  return facts;
 });
}

async function upsertRows(db,schema,table,rows){
 const columns=(schema.columns.get(table)??[]).map(x=>x.column_name),keys=keysFor(schema,table),changed=columns.filter(x=>!keys.includes(x));
 if(!columns.length||!keys.length)throw fail('maintenance_recovery_schema_not_supported');
 for(const row of rows){if(Object.keys(row).some(x=>!columns.includes(x))||keys.some(x=>row[x]===undefined))throw fail('maintenance_recovery_facts_invalid');
  await db.query('INSERT INTO '+quote(table)+'('+columns.map(quote).join(',')+') OVERRIDING SYSTEM VALUE SELECT '+columns.map(quote).join(',')+' FROM jsonb_populate_record(NULL::'+quote(table)+',$1::jsonb) ON CONFLICT('+keys.map(quote).join(',')+') '+(changed.length?'DO UPDATE SET '+changed.map(x=>quote(x)+'=EXCLUDED.'+quote(x)).join(','):'DO NOTHING'),[JSON.stringify(row)]);
 }
}
async function copyCurrentTables(db,schema,facts,tables){
 let pending=tables.flatMap(table=>facts.tables[table].rows.map(row=>({table,row})));
 for(let pass=0;pending.length;pass++){
  const retry=[];let progress=0;
  for(const item of pending){await db.query('SAVEPOINT maintenance_current_row');try{await upsertRows(db,schema,item.table,[item.row]);await db.query('RELEASE SAVEPOINT maintenance_current_row');progress++;}catch(error){await db.query('ROLLBACK TO SAVEPOINT maintenance_current_row');await db.query('RELEASE SAVEPOINT maintenance_current_row');if(error.code==='23503')retry.push(item);else throw error;}}
  if(retry.length&&!progress)throw fail('maintenance_current_reference_not_restored');pending=retry;
 }
}
export async function pauseRestoredStrategyRuns(db,at){
 // P13 configuration is ordinary point data, not a fresh execution grant.
 // Older supported schemas have neither table. Do not invent 112 on them.
 const available=(await db.query("SELECT to_regclass('public.operations_p13_strategy_heads_v1') IS NOT NULL AS heads,to_regclass('public.operations_p13_strategy_runs_v1') IS NOT NULL AS runs")).rows[0];
 if(!available.heads&&!available.runs)return{applied:false};if(!available.heads||!available.runs)throw fail('maintenance_recovery_schema_changed');
 await db.query('UPDATE operations_p13_strategy_heads_v1 SET paused=true,updated_at=$1',[at]);
 const result=await db.query("UPDATE operations_p13_strategy_runs_v1 SET state='blocked',code='restore-current-authorization-required',updated_at=$1 WHERE state NOT IN ('completed','no-action') RETURNING id",[at]);
 return{applied:true,blocked:result.rows.length};
}
async function seedFoundation(db,schema,facts){
 // Preserve the current security authority. Disabled/deleted grants from after
 // the recovery point cannot be resurrected by old rows or old command ACKs.
 for(const table of ['bindings','consents'])await db.query('UPDATE '+quote(table)+' SET revoked_at=COALESCE(revoked_at,$1)',[new Date(facts.capturedAt*1000)]);
 await db.query("UPDATE device_authorizations SET status='revoked',revoked_at=COALESCE(revoked_at,$1)",[new Date(facts.capturedAt*1000)]);
 await db.query("UPDATE recovery_authorizations SET status='replaced' WHERE status='active'");
 await db.query('UPDATE chat_memberships SET left_at=COALESCE(left_at,$1)',[new Date(facts.capturedAt*1000)]);
 await db.query('UPDATE chat_agent_grants SET revoked_at=COALESCE(revoked_at,$1)',[new Date(facts.capturedAt*1000)]);
 await db.query('UPDATE external_identity_links SET revoked_at=COALESCE(revoked_at,$1)',[new Date(facts.capturedAt*1000)]);
 for(const table of ['operations_business_roles_v1','operations_role_assignments_v1','operations_automation_grants_v1'])await db.query('UPDATE '+quote(table)+' SET enabled=false');
 // Temporary names only exist inside this recovery transaction, avoiding a
 // legitimate old/current role-name permutation colliding during row upserts.
 await db.query("UPDATE operations_business_roles_v1 SET name='recovery-'||id::text");
 // These current configuration versions and credential references must agree
 // with the current protected host configuration. An empty current table must
 // not leave a point's formerly enabled provider or pending apply behind.
 for(const table of ['operations_model_settings_state_v1','operations_model_settings_versions_v1','operations_model_settings_operations_v1','operations_smtp_settings_v1','operations_smtp_commands_v1','operations_smtp_events_v1','operations_smtp_tests_v1'])await db.query('DELETE FROM '+quote(table));
 await copyCurrentTables(db,schema,facts,recoveryAuthorityTables);
 await db.query("UPDATE operations_agentos_executions_v1 SET state='paused',updated_at=$1 WHERE state='active'",[new Date(facts.capturedAt*1000)]);
 await pauseRestoredStrategyRuns(db,new Date(facts.capturedAt*1000));
 for(const table of ['official_account_sessions_v1','official_account_logins_v1','operations_operator_sessions_v1','operations_operator_logins_v1','oidc_login_transactions_v1'])await db.query('DELETE FROM '+quote(table));
 await db.query('UPDATE access_credentials SET revoked_at=COALESCE(revoked_at,$1)',[new Date(facts.capturedAt*1000)]);
}
async function reconcileGates(db,schema,facts){
 let changed=0;const unresolved=[];
 for(const [table,entry]of Object.entries(facts.gates)){
  if(!Object.hasOwn(sourceGates,table)||!same(entry.keys,keysFor(schema,table)))throw fail('maintenance_recovery_facts_invalid');
  for(const source of entry.rows){const where=keyWhere(entry.keys,source),old=(await db.query('SELECT * FROM '+quote(table)+' WHERE '+where.sql,where.values)).rows[0];if(!old)continue;
   const values={};for(const col of entry.columns){if(!sourceGates[table].includes(col))throw fail('maintenance_recovery_facts_invalid');if(!same(normalize(old[col]??null),source[col]??null))values[col]=source[col];}
   if(!Object.keys(values).length)continue;
   // A newer source revision is not included by merely restoring its locator.
   // Keep no pointer to an older transport body under that newer revision.
   if(table==='chat_message_refs'&&source.revision!==old.revision)values.archive_id=null;
   for(const col of ['expires_at','published_until'])if(values[col]&&old[col]&&Date.parse(values[col])>Date.parse(old[col]))delete values[col];
   // Missing newer FK bodies are withheld by a null pointer, never fetched as
   // an extension of the approved recovery scope.
   for(const [col,target]of [['current_version_id','forum_versions_v1'],['permission_id','forum_permissions_v1']])if(values[col]&&!((await db.query('SELECT 1 FROM '+quote(target)+' WHERE id=$1',[values[col]])).rows.length))values[col]=null;
   if(recoveryAuthorityTables.includes(table))continue;
   if(Object.keys(values).length){const columns=Object.keys(values);await db.query('UPDATE '+quote(table)+' SET '+columns.map((x,i)=>quote(x)+'=$'+(i+1)).join(',')+' WHERE '+keyWhere(entry.keys,source,columns.length+1).sql,[...columns.map(x=>values[x]),...where.values]);changed++;}
  }
 }
 return{changed,unresolved:[...new Set(unresolved)]};
}
async function reconcileOutbound(db,schema,facts){
 const at=new Date(facts.capturedAt*1000);
 // Records missing from the current ledger must not become a live notice from
 // the older recovery point. No already submitted message is retracted.
 await db.query("UPDATE operations_notices_v1 SET state='withdrawn' WHERE state IN ('queued','delivering','delivered')");
 await db.query('UPDATE operations_messaging_announcements_v1 SET withdrawn_at=COALESCE(withdrawn_at,$1)',[at]);
 await copyCurrentTables(db,schema,facts,recoveryOutboundTables);
 await db.query("UPDATE operations_messaging_plans_v1 SET state='paused',updated_at=$1 WHERE state='active'",[at]);
 await db.query("UPDATE operations_messaging_runs_v1 SET state='paused',updated_at=$1 WHERE state='running'",[at]);
 await db.query("UPDATE operations_messaging_recipients_v1 SET state='unknown',retryable=false,error_code='smtp_submission_unknown',lease_until=NULL,retry_at=NULL,updated_at=$1 WHERE channel='email' AND state='submitting'",[at]);
 await db.query("UPDATE operations_messaging_attempts_v1 SET state='unknown',error_code='smtp_submission_unknown',finished_at=COALESCE(finished_at,$1) WHERE state='submitting'",[at]);
 await db.query("UPDATE galaxy_jobs.job SET state='cancelled',completed_on=COALESCE(completed_on,now()) WHERE name=ANY($1::text[]) AND state IN ('created','retry','active')",[['account-notice','messaging-run','messaging-delivery','content-publication','retention-cleanup']]);
 return{submittedNotRetried:true,activePlansPaused:true,inFlightEmail:'unknown',alreadySentNotRetracted:true};
}

export async function reconcileCurrentRecoveryFacts(database,facts,{endpoint,recoveryId}={}){
 if(facts?.version!==1||facts.endpoint!==endpoint||!Number.isSafeInteger(facts.capturedAt))throw fail('maintenance_recovery_facts_invalid');
 return transaction(database,async db=>{
  const quarantine=(await db.query('SELECT recovery_id,status FROM recovery_state WHERE singleton=true')).rows[0];if(quarantine?.status!=='quarantined'||quarantine.recovery_id!==recoveryId)throw fail('maintenance_exact_quarantine_required');
  const schema=await metadata(db);if(Number((await db.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version)!==Number(facts.schema))throw fail('maintenance_recovery_schema_changed');
  await seedFoundation(db,schema,facts);
  // Current forum grants are independent of the point's body. Chat case heads
  // require their current report/event FK chain; unrelated post-point bodies
  // are not imported merely to satisfy a recovery reference.
  const skipped=[];
  await db.query('DELETE FROM operations_chat_message_visibility_v1');
  await db.query('DELETE FROM operations_content_visibility_v1');
  await db.query('UPDATE forum_permissions_v1 SET revoked_at=COALESCE(revoked_at,$1)',[new Date(facts.capturedAt*1000)]);
  for(const table of recoveryGovernanceTables){for(const row of facts.tables[table].rows){
   if(table==='operations_chat_message_visibility_v1'&&!(await db.query('SELECT 1 FROM chat_message_refs WHERE message_id=$1',[row.message_id])).rows.length){skipped.push(table);continue;}
   try{await upsertRows(db,schema,table,[row]);}catch(error){throw fail('maintenance_governance_reconciliation_incomplete');}
  }}
  const gates=await reconcileGates(db,schema,facts);if(gates.unresolved.length)throw fail('maintenance_source_lifecycle_reconciliation_incomplete');
  await upsertRows(db,schema,'lifecycle_erasure_records',facts.tables.lifecycle_erasure_records.rows);
  const outbound=await reconcileOutbound(db,schema,facts);
  for(const table of [...recoveryAuthorityTables,...recoveryOutboundTables,...recoveryGovernanceTables])for(const col of schema.columns.get(table)??[]){
   const seq=(await db.query('SELECT pg_get_serial_sequence($1,$2) AS name',[table,col.column_name])).rows[0]?.name;if(seq)await db.query('SELECT setval($1::regclass,GREATEST(COALESCE((SELECT max('+quote(col.column_name)+') FROM '+quote(table)+'),0),1),(SELECT count(*)>0 FROM '+quote(table)+'))',[seq]);
  }
  return{version:1,capturedAt:facts.capturedAt,authorityPreserved:true,restoredSessionsInvalidated:true,sourceGatesReconciled:true,changedSourceGates:gates.changed,outbound,unselectedPostPointHeadsSkipped:skipped.length,quarantined:true,publicActivation:false};
 });
}
