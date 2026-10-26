import {DatabaseSync} from 'node:sqlite';
import {lstat,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {noSymlinkPath} from '../operations-stack/host.mjs';

const fail=code=>Object.assign(Error(code),{code});
const quote=x=>'"'+x.replaceAll('"','""')+'"';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const stable=rows=>rows.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const encode=x=>typeof x==='bigint'?{$integer:String(x)}:x instanceof Uint8Array?{$blob:Buffer.from(x).toString('base64')}:x;
const decode=x=>x&&typeof x==='object'?Object.keys(x).length===1&&typeof x.$integer==='string'&&/^-?[0-9]+$/.test(x.$integer)?BigInt(x.$integer):Object.keys(x).length===1&&typeof x.$blob==='string'?Buffer.from(x.$blob,'base64'):(()=>{throw fail('maintenance_grafana_facts_invalid');})():x;
const number=x=>Number(decode(x));
const value=x=>String(decode(x));
const read=(db,sql,...parameters)=>{const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all(...parameters).map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,encode(v)])));};

// Real OSS 13.2.4 tables, not a second identity store. Connection rows remain
// current as a unit: a current secret must not be rebound to an older host.
export const grafanaCurrentSecurityTables=Object.freeze([
 'org','user','org_user','team','team_member','role','permission','builtin_role','user_role','team_role','seed_assignment','api_key','user_auth','temp_user',
 'signing_key','sso_setting','data_keys','secrets','secret_data_key','secret_encrypted_value','secret_keeper','secret_secure_value',
 'data_source','plugin_setting','alert_notification','alert_configuration','ngalert_configuration',
]);
export const grafanaEphemeralSecurityTables=Object.freeze(['session','user_auth_token','user_external_session','login_attempt','cache_data']);
const mapped=['dashboard_acl','dashboard_public'];
const unsupported=['dashboard_snapshot','cloud_migration_session'];
const tables=[...grafanaCurrentSecurityTables,...grafanaEphemeralSecurityTables,...mapped,'kv_store'];
const currentKv=new Set(['alertmanager','datasource','plugin.publickeys']);
const pointKv=new Set(['infra.usagestats','ngalert.migration','plugin.angularpatterns']);
const resourceTypes=new Set(['advisor.grafana.app/checktypes','dashboard.grafana.app/dashboards','folder.grafana.app/folders']);
const requiredColumns={user:['id','uid','password','salt','rands','is_admin','is_disabled','is_service_account'],user_auth:['user_id','user_uid','auth_module','auth_id'],api_key:['key','is_revoked','service_account_id'],dashboard:['id','uid','org_id'],permission:['role_id','action','scope'],role:['id','uid','org_id']};
const keyTargets={secretKeyFile:'/run/secrets/grafana_secret_key',clientSecretFile:'/run/secrets/grafana_oauth_client_secret',bootstrapPasswordFile:'/run/secrets/grafana_bootstrap_password'};
export function grafanaKeyFileAllowed(info,mount){
 // The installed OSS image runs as 472:472, and its current root-managed
 // secret mounts are 472:472/0400. They need not be re-owned or copied.
 return info.isFile()&&!info.isSymbolicLink()&&info.size>0&&info.size<=65536&&mount?.writable===false&&
  ((info.uid===0&&(info.mode&0o027)===0)||(info.uid===472&&info.gid===472&&(info.mode&0o277)===0));
}

function schema(db){
 const present=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name)),result={};
 if(tables.concat(unsupported,'dashboard','migration_log','resource','resource_history','resource_blob').some(x=>!present.has(x)))throw fail('maintenance_grafana_schema_not_supported');
 const known=new Set([...tables,...unsupported,'migration_log','secret_migration_log','dashboard','org_user']);
 for(const name of present)if(/(?:^|_)(?:auth|user|team|org|role|permission|secret|secrets|key|keys|session|token|acl)(?:_|$)/.test(name)&&!known.has(name))throw fail('maintenance_grafana_security_table_not_supported');
 for(const name of tables){result[name]=db.prepare('PRAGMA table_info('+quote(name)+')').all().map(x=>({name:x.name,type:x.type,notnull:x.notnull,pk:x.pk}));if(!result[name].length)throw fail('maintenance_grafana_schema_not_supported');}
 for(const [name,columns]of Object.entries(requiredColumns)){const actual=db.prepare('PRAGMA table_info('+quote(name)+')').all().map(x=>x.name);if(columns.some(x=>!actual.includes(x)))throw fail('maintenance_grafana_schema_not_supported');}
 return result;
}
function supported(db){
 for(const table of unsupported)if(db.prepare('SELECT count(*) AS n FROM '+quote(table)).get().n!==0)throw fail('maintenance_grafana_external_capability_not_supported');
 for(const table of ['resource','resource_history','resource_blob'])for(const row of db.prepare('SELECT DISTINCT "group",resource FROM '+quote(table)).all())if(!resourceTypes.has(row.group+'/'+row.resource))throw fail('maintenance_grafana_unified_authority_not_supported');
 for(const row of db.prepare('SELECT DISTINCT namespace FROM kv_store').all())if(!currentKv.has(row.namespace)&&!pointKv.has(row.namespace))throw fail('maintenance_grafana_namespace_not_supported');
}
function snapshot(db){
 const layout=schema(db);supported(db);const data={};
 for(const table of tables){const rows=read(db,'SELECT * FROM '+quote(table));if(rows.length>100000)throw fail('maintenance_grafana_facts_limit');data[table]=stable(rows);}
 data.kv_store=data.kv_store.filter(x=>currentKv.has(x.namespace));
 const facts={version:1,layout,tables:data,dashboards:read(db,'SELECT id,uid,org_id FROM dashboard'),migrations:read(db,'SELECT migration_id,success FROM migration_log ORDER BY id')};
 if(Buffer.byteLength(JSON.stringify(facts))>20*1024*1024)throw fail('maintenance_grafana_facts_limit');return facts;
}
export function captureGrafanaSecurity(database){
 database.exec('BEGIN');try{const facts=snapshot(database);database.exec('COMMIT');return facts;}catch(error){database.exec('ROLLBACK');if(error.code?.startsWith('maintenance_'))throw error;throw fail('maintenance_grafana_capture_failed');}
}
function writeRows(db,layout,table,rows){
 const columns=layout[table].map(x=>x.name),statement=db.prepare('INSERT INTO '+quote(table)+'('+columns.map(quote).join(',')+') VALUES('+columns.map(()=>'?').join(',')+')');
 for(const row of rows){if(!same(Object.keys(row).sort(),columns.slice().sort()))throw fail('maintenance_grafana_facts_invalid');statement.run(...columns.map(x=>decode(row[x])));}
}
function identitiesValid(facts){
 const users=new Map(facts.tables.user.map(x=>[value(x.id),x])),teams=new Set(facts.tables.team.map(x=>value(x.id))),roles=new Set(facts.tables.role.map(x=>value(x.id))),orgs=new Set(facts.tables.org.map(x=>value(x.id)));
 for(const row of facts.tables.org_user)if(!users.has(value(row.user_id))||!orgs.has(value(row.org_id)))throw fail('maintenance_grafana_current_reference_invalid');
 for(const row of facts.tables.user_auth)if(!users.has(value(row.user_id))||(row.user_uid!==null&&row.user_uid!==users.get(value(row.user_id)).uid))throw fail('maintenance_grafana_current_reference_invalid');
 for(const row of facts.tables.team_member)if(!users.has(value(row.user_id))||!teams.has(value(row.team_id)))throw fail('maintenance_grafana_current_reference_invalid');
 for(const row of facts.tables.user_role)if(!users.has(value(row.user_id))||!roles.has(value(row.role_id)))throw fail('maintenance_grafana_current_reference_invalid');
 for(const row of facts.tables.team_role)if(!teams.has(value(row.team_id))||!roles.has(value(row.role_id)))throw fail('maintenance_grafana_current_reference_invalid');
 for(const row of facts.tables.permission)if(!roles.has(value(row.role_id)))throw fail('maintenance_grafana_current_reference_invalid');
 for(const row of facts.tables.api_key)if(row.service_account_id!==null&&row.service_account_id!==undefined&&number(row.service_account_id)!==0&&!users.has(value(row.service_account_id)))throw fail('maintenance_grafana_current_reference_invalid');
}
function expectedMapped(db,facts){
 const point=read(db,'SELECT id,uid,org_id FROM dashboard'),lookup=new Map(point.map(x=>[value(x.org_id)+'/'+x.uid,x])),old=new Map(facts.dashboards.map(x=>[value(x.id),x]));
 const acl=[];for(const row of facts.tables.dashboard_acl){if(number(row.dashboard_id)===-1){acl.push(row);continue;}const current=old.get(value(row.dashboard_id));if(!current)throw fail('maintenance_grafana_current_acl_target_unknown');const target=lookup.get(value(current.org_id)+'/'+current.uid);if(target)acl.push({...row,dashboard_id:target.id});}
 const shared=facts.tables.dashboard_public.filter(row=>lookup.has(value(row.org_id)+'/'+row.dashboard_uid));
 return{dashboard_acl:acl,dashboard_public:shared};
}
function verifyRows(db,facts,expected){
 for(const table of grafanaCurrentSecurityTables)if(!same(stable(read(db,'SELECT * FROM '+quote(table))),facts.tables[table]))throw fail('maintenance_grafana_current_authority_unconfirmed');
 for(const table of grafanaEphemeralSecurityTables)if(db.prepare('SELECT count(*) AS n FROM '+quote(table)).get().n!==0)throw fail('maintenance_grafana_old_session_remains');
 for(const table of mapped)if(!same(stable(read(db,'SELECT * FROM '+quote(table))),stable(expected[table])))throw fail('maintenance_grafana_current_authority_unconfirmed');
 const kv=stable(read(db,'SELECT * FROM kv_store').filter(x=>currentKv.has(x.namespace)));if(!same(kv,facts.tables.kv_store))throw fail('maintenance_grafana_current_authority_unconfirmed');
}
export function reconcileGrafanaSecurity(database,facts,{operationId}={}){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId??''))throw fail('maintenance_grafana_private_candidate_required');
 try{
  const guard=database.prepare('SELECT operation_id,private_candidate FROM temp.galaxy_maintenance_recovery_guard').all();
  if(guard.length!==1||guard[0].operation_id!==operationId||guard[0].private_candidate!==1)throw fail('maintenance_grafana_private_candidate_required');
 }catch{throw fail('maintenance_grafana_private_candidate_required');}
 database.exec('BEGIN IMMEDIATE');try{
  const layout=schema(database);supported(database);
  if(facts?.version!==1||!same(layout,facts.layout)||!same(read(database,'SELECT migration_id,success FROM migration_log ORDER BY id'),facts.migrations))throw fail('maintenance_grafana_schema_changed');
  if(!same(Object.keys(facts.tables).sort(),tables.slice().sort())||Object.values(facts.tables).some(x=>!Array.isArray(x)||x.length>100000))throw fail('maintenance_grafana_facts_invalid');
  identitiesValid(facts);
  const currentUsers=new Map(facts.tables.user.map(x=>[value(x.id),x.uid]));
  for(const row of read(database,'SELECT id,uid FROM user'))if(currentUsers.has(value(row.id))&&currentUsers.get(value(row.id))!==row.uid)throw fail('maintenance_grafana_identity_id_conflict');
  const expected=expectedMapped(database,facts);
  for(const table of [...mapped,...grafanaEphemeralSecurityTables,...grafanaCurrentSecurityTables].reverse())database.exec('DELETE FROM '+quote(table));
  for(const table of grafanaCurrentSecurityTables)writeRows(database,layout,table,facts.tables[table]);
  for(const table of mapped)writeRows(database,layout,table,expected[table]);
  for(const namespace of currentKv)database.prepare('DELETE FROM kv_store WHERE namespace=?').run(namespace);
  writeRows(database,layout,'kv_store',facts.tables.kv_store);
  // sqlite_sequence must never move backwards after current rows are merged.
  const sequences=database.prepare("SELECT name FROM sqlite_sequence").all();
  for(const row of sequences)if(tables.includes(row.name)&&layout[row.name].some(x=>x.name==='id'))database.exec('UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT max(id) FROM '+quote(row.name)+'),0)) WHERE name='+"'"+row.name+"'");
  verifyRows(database,facts,expected);
  if(database.prepare('PRAGMA foreign_key_check').all().length||database.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw fail('maintenance_grafana_candidate_invalid');
  database.exec('COMMIT');return{required:true,currentUsersPreserved:true,currentPasswordsPreserved:true,currentOauthPreserved:true,currentPermissionsPreserved:true,currentKeysPreserved:true,currentConnectionsPreserved:true,sessionsInvalidated:true};
 }catch(error){database.exec('ROLLBACK');if(error.code?.startsWith('maintenance_'))throw error;throw fail('maintenance_grafana_reconciliation_failed');}
}

export class MaintenanceGrafanaSecurity{
 constructor({config}={}){this.config=config;}
 async keyBindings(context){
  const binding=this.binding(context);
  const bindings=[];
  for(const name of ['secretKeyFile','clientSecretFile','bootstrapPasswordFile']){
   const file=this.config?.grafana?.[name];if(typeof file!=='string'||!['/etc/galaxy/','/var/lib/galaxy/operations/secrets/'].some(root=>file.startsWith(root)))throw fail('maintenance_grafana_current_key_binding_required');
   const mount=binding.mounts.find(x=>x.path===file&&x.target===keyTargets[name]);
   await noSymlinkPath(file);const info=await lstat(file);if(!grafanaKeyFileAllowed(info,mount))throw fail('maintenance_grafana_current_key_binding_required');
   bindings.push({name,file,uid:info.uid,gid:info.gid,mode:info.mode&0o777,sha256:createHash('sha256').update(await readFile(file)).digest('hex')});
  }
  return bindings;
 }
 binding(context){const row=context.footprint?.containers?.find(x=>x.id==='grafana'&&x.state==='available'),mount=row?.mounts?.find(x=>x.target==='/var/lib/grafana'&&x.writable);if(row?.name!=='galaxy-operations-grafana'||!/^sha256:[a-f0-9]{64}$/.test(row.image??'')||!mount?.path)throw fail('maintenance_grafana_source_binding_required');return{...row,mount};}
 async open(file,{readOnly=true}={}){await noSymlinkPath(file);const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw fail('maintenance_grafana_database_file_required');return new DatabaseSync(file,{readOnly});}
 async capture(context){const binding=this.binding(context),keyBindings=await this.keyBindings(context),db=await this.open(binding.mount.path+'/grafana.db');try{return{...captureGrafanaSecurity(db),image:binding.image,keyBindings};}finally{db.close();}}
 async prepare(context,facts){
  const binding=this.binding(context),transfer=context.artifacts.fileTransfers.find(x=>x.owner===binding.name&&x.path===binding.mount.path&&x.candidate===x.path+'.galaxy-next-'+context.intent.operationId);
  if(!transfer||facts?.image!==binding.image)throw fail('maintenance_grafana_private_candidate_required');
  if(!same(await this.keyBindings(context),facts.keyBindings))throw fail('maintenance_grafana_current_key_binding_changed');
  const db=await this.open(transfer.candidate+'/grafana.db',{readOnly:false});
  try{db.exec('CREATE TEMP TABLE galaxy_maintenance_recovery_guard(operation_id TEXT,private_candidate INTEGER)');db.prepare('INSERT INTO temp.galaxy_maintenance_recovery_guard VALUES(?,1)').run(context.intent.operationId);return reconcileGrafanaSecurity(db,facts,{operationId:context.intent.operationId});}finally{db.close();}
 }
 async verify(context,facts){
  const binding=this.binding(context);if(facts?.image!==binding.image)throw fail('maintenance_grafana_source_binding_required');if(!same(await this.keyBindings(context),facts.keyBindings))throw fail('maintenance_grafana_current_key_binding_changed');const db=await this.open(binding.mount.path+'/grafana.db');
  try{const layout=schema(db);supported(db);if(!same(layout,facts.layout))throw fail('maintenance_grafana_schema_changed');verifyRows(db,facts,expectedMapped(db,facts));return{currentPermissionsPreserved:true,currentKeysPreserved:true};}finally{db.close();}
 }
}
