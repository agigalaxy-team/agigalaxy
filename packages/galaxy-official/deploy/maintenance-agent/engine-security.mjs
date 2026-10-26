import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat,chown} from 'node:fs/promises';
import pg from 'pg';
import {transaction} from '../../src/database.mjs';
import {noSymlinkPath} from '../operations-stack/host.mjs';
import {MaintenanceGarageSecurity} from './garage-security.mjs';
import {MaintenanceGrafanaSecurity} from './grafana-security.mjs';

const fail=code=>Object.assign(Error(code),{code});
const sha=x=>createHash('sha256').update(x).digest('hex');
const name=x=>{if(!/^[a-z][a-z0-9_]*$/.test(x))throw fail('maintenance_native_security_schema_changed');return '"'+x+'"';};
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const openPanelSecurityTables=Object.freeze(['organizations','projects','users','user_totp','accounts','members','invites','project_access','clients','salts']);
export const openPanelEphemeralAuthenticationTables=Object.freeze(['sessions','two_factor_challenges','reset_password']);
export const openPanelSecurityCaptureSql='BEGIN; LOCK TABLE '+[...openPanelSecurityTables,...openPanelEphemeralAuthenticationTables].map(name).join(',')+' IN SHARE MODE; SELECT jsonb_build_object('+openPanelSecurityTables.map(table=>"'"+table+"',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM "+name(table)+' t)').join(',')+'); COMMIT;';

export async function reconcileOpenPanelSecurity(database,facts,{at=new Date(),recoveryId}={}){
 if(!facts||Object.keys(facts).length!==openPanelSecurityTables.length||openPanelSecurityTables.some(t=>!Array.isArray(facts[t])))throw fail('maintenance_native_security_facts_invalid');
 return transaction(database,async db=>{
  if(!uuid.test(recoveryId??'')||!(await db.query("SELECT to_regclass('pg_temp.galaxy_maintenance_recovery_guard') IS NOT NULL AS present")).rows[0]?.present)throw fail('maintenance_native_security_candidate_required');
  const guard=(await db.query('SELECT operation_id,private_candidate FROM pg_temp.galaxy_maintenance_recovery_guard')).rows;
  if(guard.length!==1||guard[0].operation_id!==recoveryId||guard[0].private_candidate!==true)throw fail('maintenance_native_security_candidate_required');
  const columns=(await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'")).rows;
  const keys=(await db.query("SELECT r.relname AS table_name,a.attname AS column_name FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.num WHERE c.contype='p' AND n.nspname='public' ORDER BY r.relname,k.ord")).rows;
  const insert=async(table,rows,parents=false)=>{
   const known=columns.filter(x=>x.table_name===table).map(x=>x.column_name),pk=keys.filter(x=>x.table_name===table).map(x=>x.column_name);
   if(!known.length||!pk.length)throw fail('maintenance_native_security_schema_changed');
   for(const row of rows){const cols=Object.keys(row);if(cols.some(c=>!known.includes(c))||pk.some(c=>row[c]===undefined))throw fail('maintenance_native_security_schema_changed');
    const quoted=cols.map(c=>'"'+c.replaceAll('"','""')+'"'),pks=pk.map(c=>'"'+c+'"'),changed=cols.filter(c=>!pk.includes(c));
    await db.query('INSERT INTO '+name(table)+'('+quoted.join(',')+') SELECT '+quoted.join(',')+' FROM jsonb_populate_record(NULL::'+name(table)+',$1::jsonb) ON CONFLICT('+pks.join(',')+') '+(parents||!changed.length?'DO NOTHING':'DO UPDATE SET '+changed.map(c=>'"'+c+'"=EXCLUDED."'+c+'"').join(',')),[JSON.stringify(row)]);
   }
  };
  // Authentication and project access use their real @@map names. Do not
  // restore an older password/OAuth/TOTP/client-secret/session from the point.
  for(const table of ['reset_password','two_factor_challenges','sessions','invites','project_access','members','user_totp','accounts','clients','salts'])await db.query('DELETE FROM '+name(table));
  await db.query('UPDATE users SET "deletedAt"=$1,email=\'recovery-disabled-\'||id||\'@invalid\'',[at]);
  await insert('organizations',facts.organizations,true);await insert('projects',facts.projects,true);
  for(const table of openPanelSecurityTables.filter(t=>!['organizations','projects'].includes(t)))await insert(table,facts[table]);
  return{currentUsersPreserved:true,currentPasswordsPreserved:true,currentClientsPreserved:true,currentAccessPreserved:true,sessionsInvalidated:true};
 });
}

export class MaintenanceEngineSecurity{
 constructor({config,run,controlDirectory,fetchImpl=fetch,garage=new MaintenanceGarageSecurity({config,run}),grafana=new MaintenanceGrafanaSecurity({config})}){Object.assign(this,{config,run,controlDirectory,fetchImpl,garage,grafana});}
 async inspect(context){
  if(context.intent.moduleIds.includes('objects'))await this.garage.read(context);
  if(context.intent.moduleIds.includes('configuration'))await this.grafana.capture(context);
  return{currentNativeAuthorityReadable:true};
 }
 async meili(){
  const file='/etc/galaxy/discovery/runtime.env',s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||s.uid!==0)throw fail('maintenance_private_native_key_required');
  const rows=(await readFile(file,'utf8')).split(/\r?\n/).filter(line=>line.startsWith('MEILI_MASTER_KEY='));if(rows.length!==1)throw fail('maintenance_current_native_key_unknown');
  const key=rows[0].slice('MEILI_MASTER_KEY='.length);if(key.length<16||/[\r\n\p{Cc}]/u.test(key))throw fail('maintenance_current_native_key_unknown');
  // Current deployment publishes only this loopback port. No user URL or
  // restored native key determines where this privileged request is sent.
  return{url:'http://127.0.0.1:17700',key,keyFingerprint:sha(key)};
 }
 async meiliRequest(path,{method='GET',body}={}){
  const {url,key}=await this.meili(),response=await this.fetchImpl(url+path,{method,headers:{authorization:'Bearer '+key,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
  const text=await response.text();if(Buffer.byteLength(text)>1024*1024||!response.ok)throw fail('maintenance_native_key_reconciliation_failed');return text.trim()?JSON.parse(text):null;
 }
 async capture(context){
  const facts={version:1,operationId:context.intent.operationId,openpanel:null,meili:null,garage:null,grafana:null};
  if(context.intent.moduleIds.includes('analytics')){
   const binding=context.footprint.containers.find(x=>x.id==='analytics-db'&&x.state==='available');if(!binding)throw fail('maintenance_native_security_source_unknown');
   const response=await this.run(this.config.tools.docker,['exec','--user','postgres',binding.name,'psql','--no-psqlrc','--no-password','--quiet','--tuples-only','--no-align','--set','ON_ERROR_STOP=1','--username','openpanel','--dbname','openpanel','--command',openPanelSecurityCaptureSql],{timeout:60000,maxOutput:20*1024*1024});
   facts.openpanel=JSON.parse(response.stdout.trim());
  }
  if(context.intent.moduleIds.includes('search')){
   const keys=await this.meiliRequest('/keys?limit=1000');if(!Array.isArray(keys.results)||keys.total>1000||keys.results.some(x=>!uuid.test(x.uid)))throw fail('maintenance_native_key_inventory_incomplete');
   facts.meili={keyFingerprint:(await this.meili()).keyFingerprint,keys:keys.results.map(({uid,name,description,actions,indexes,expiresAt,key})=>({uid,name,description,actions,indexes,expiresAt,key}))};
  }
  if(context.intent.moduleIds.includes('objects'))facts.garage=await this.garage.capture(context);
  if(context.intent.moduleIds.includes('configuration'))facts.grafana=await this.grafana.capture(context);
  const payload=JSON.stringify(facts),directory=this.controlDirectory+'/recovery-facts';await noSymlinkPath(directory);await mkdir(directory,{recursive:true,mode:0o700});
  const file=directory+'/'+context.intent.operationId+'-engines.json';await writeFile(file,payload,{flag:'wx',mode:0o600});
  return{operationId:context.intent.operationId,artifactPath:file,sha256:sha(payload),openpanel:!!facts.openpanel,meili:!!facts.meili,garage:!!facts.garage,grafana:!!facts.grafana};
 }
 async facts(contribution){
  const file=this.controlDirectory+'/recovery-facts/'+contribution.operationId+'-engines.json';if(!uuid.test(contribution.operationId)||file!==contribution.artifactPath)throw fail('maintenance_native_security_facts_invalid');await noSymlinkPath(file);
  const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)||info.size>20*1024*1024)throw fail('maintenance_private_native_security_required');
  const payload=await readFile(file,'utf8');if(sha(payload)!==contribution.sha256)throw fail('maintenance_native_security_facts_changed');return JSON.parse(payload);
 }
 async restoreMeili(contribution){
  const facts=(await this.facts(contribution)).meili;if(!facts)return{required:false};
  if(facts.keyFingerprint!==(await this.meili()).keyFingerprint)throw fail('maintenance_current_native_key_changed');
  const old=await this.meiliRequest('/keys?limit=1000');if(!Array.isArray(old.results)||old.total>1000||old.results.some(x=>!uuid.test(x.uid)))throw fail('maintenance_native_key_inventory_incomplete');
  for(const row of old.results)await this.meiliRequest('/keys/'+row.uid,{method:'DELETE'});
  for(const {uid,name,description,actions,indexes,expiresAt}of facts.keys)await this.meiliRequest('/keys',{method:'POST',body:{uid,name,description,actions,indexes,expiresAt}});
  const current=await this.meiliRequest('/keys?limit=1000'),project=x=>JSON.stringify([x.uid,x.actions.slice().sort(),x.indexes.slice().sort(),x.expiresAt,x.key]);
  if(current.total!==facts.keys.length||facts.keys.some(x=>!current.results.some(y=>project(x)===project(y))))throw fail('maintenance_native_key_reconciliation_unconfirmed');
  return{required:true,currentKeysPreserved:true,keyCount:facts.keys.length};
 }
 async prepareOpenPanel(context,{connect=options=>new pg.Pool({...options,max:1,connectionTimeoutMillis:3000})}={}){
  const facts=(await this.facts(context.currentFacts.engines)).openpanel;if(!facts)return{required:false};
  const binding=context.footprint.containers.find(x=>x.id==='analytics-db'),mount=binding?.mounts.find(x=>x.writable&&x.target==='/var/lib/postgresql/data');
  const transfer=context.artifacts.fileTransfers.find(x=>x.owner===binding?.name&&x.path===mount?.path);
  if(!transfer||!/^sha256:[a-f0-9]{64}$/.test(binding.image))throw fail('maintenance_native_security_volume_unknown');
  const info=await lstat(transfer.candidate),socket=context.artifacts.directory+'/openpanel-socket';await mkdir(socket,{mode:0o700});await chown(socket,info.uid,info.gid);
  await writeFile(socket+'/pg_hba.conf','local all all trust\n',{flag:'wx',mode:0o644});
  const container='galaxy-maintenance-op-'+context.intent.operationId.replaceAll('-','').slice(0,20);
  await this.run(this.config.tools.docker,['run','--detach','--name',container,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user',info.uid+':'+info.gid,
   '--tmpfs','/tmp:rw,nosuid,size=64m','--mount','type=bind,src='+transfer.candidate+',dst=/var/lib/postgresql/data','--mount','type=bind,src='+socket+',dst=/galaxy-socket',
   '--entrypoint','postgres',binding.image,'-D','/var/lib/postgresql/data','-c','listen_addresses=','-c','unix_socket_directories=/galaxy-socket','-c','hba_file=/galaxy-socket/pg_hba.conf'],{timeout:60000,maxOutput:1024});
  const database=connect({host:socket,user:'openpanel',database:'openpanel',port:5432});
  try{
   const deadline=Date.now()+60000;let ready=false;
   while(Date.now()<deadline){try{await database.query('SELECT 1');ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,500));}}
   if(!ready)throw fail('maintenance_native_security_database_not_ready');
   const settings=(await database.query("SELECT current_setting('listen_addresses') AS listen,current_setting('unix_socket_directories') AS socket,current_database() AS database")).rows[0];
   if(settings.listen!==''||settings.socket!=='/galaxy-socket'||settings.database!=='openpanel')throw fail('maintenance_private_recovery_socket_required');
   await database.query('CREATE TEMP TABLE galaxy_maintenance_recovery_guard(operation_id uuid NOT NULL,private_candidate boolean NOT NULL)');
   await database.query('INSERT INTO galaxy_maintenance_recovery_guard VALUES($1,true)',[context.intent.operationId]);
   return{required:true,...await reconcileOpenPanelSecurity(database,facts,{recoveryId:context.intent.operationId})};
  }finally{await database.end();await this.run(this.config.tools.docker,['stop','--time','30',container],{timeout:60000,maxOutput:1024});}
 }
 async prepareGrafana(context){const facts=(await this.facts(context.currentFacts.engines)).grafana;if(!facts)return{required:false};return this.grafana.prepare(context,facts);}
 async restoreGarage(context){const facts=(await this.facts(context.currentFacts.engines)).garage;if(!facts)return{required:false};return this.garage.restore(context,facts);}
 async verifyNativeAuthority(context){
  const facts=await this.facts(context.currentFacts.engines);
  if(context.intent.moduleIds.includes('objects')){if(!facts.garage)throw fail('maintenance_garage_facts_invalid');await this.garage.verify(context,facts.garage);}
  if(context.intent.moduleIds.includes('configuration')){if(!facts.grafana)throw fail('maintenance_grafana_facts_invalid');await this.grafana.verify(context,facts.grafana);}
  return{currentNativeAuthorityPreserved:true};
 }
}
