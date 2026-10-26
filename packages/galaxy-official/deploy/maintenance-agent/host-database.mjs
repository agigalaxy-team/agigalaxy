import pg from 'pg';
import {mkdir,chown} from 'node:fs/promises';
import {migrate} from '../../src/database.mjs';
import {postgresSqlArguments,noSymlinkPath} from '../operations-stack/host.mjs';
import {replayNativeCurrentFacts} from './current-facts.mjs';
import {replayDeletionRecoveryContribution} from './deletion-contribution.mjs';

const fail=code=>Object.assign(Error(code),{code});
const sqlName=value=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(value))throw fail('maintenance_database_name_invalid');return '"'+value+'"';};
const roleName=value=>{if(!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(value))throw fail('maintenance_database_owner_unknown');return '"'+value+'"';};
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
export function restoredDatabaseNames(context,config){
 const names=[];if(context.intent.moduleIds.some(x=>['business','messaging'].includes(x)))names.push(config.postgres.find(x=>x.id==='business').database);
 if(context.intent.moduleIds.includes('agentos')){
  const source=context.point.manifest.maintenance?.moduleDatabaseBindings?.agentos,current=context.footprint.moduleDatabaseBindings?.agentos;
  if(source?.state!=='available'||current?.state!=='available'||source.stanza!=='business'||source.database!==current.database||source.schema!==current.schema)throw fail('maintenance_agentos_database_binding_changed');
  names.push(source.database);
 }
 return[...new Set(names)].map(name=>(sqlName(name),name));
}
export class MaintenanceHostDatabase{
 constructor({config,run,controlDirectory,connect=options=>new pg.Pool({...options,max:1,connectionTimeoutMillis:5000,statement_timeout:60000,application_name:'galaxy-maintenance-recovery'})}){Object.assign(this,{config,run,controlDirectory,connect});}
 business(){const value=this.config.postgres.find(x=>x.id==='business');if(!value)throw fail('maintenance_business_cluster_unknown');return value;}
 async prepare(context,{reconcileNative=null,captureObjects=null,reconcileObjects=null}={}){
  const live=this.business(),clone=context.artifacts.databases.find(x=>x.stanza==='business');
  if(!clone?.socketDirectory||clone.network!=='none'||clone.ports.length)throw fail('maintenance_private_recovery_socket_required');
  const database=this.connect({host:clone.socketDirectory,user:live.administrator,database:live.database,port:5432});
  try{
   await migrate(database,{roles:['api','worker','deletion-review','content-publisher']});
   await database.query("INSERT INTO recovery_state(singleton,recovery_id,snapshot_id,status) VALUES(true,$1,$2,'quarantined') ON CONFLICT(singleton) DO UPDATE SET recovery_id=EXCLUDED.recovery_id,snapshot_id=EXCLUDED.snapshot_id,status='quarantined'",[context.intent.operationId,context.intent.pointId]);
   // Preserve exact point-owned storage pointers before the original SQL
   // deletion replay can minimize a row. Never recover ownership from an S3 key.
   let objectPointers=null;if(context.intent.moduleIds.includes('objects')){
    if(typeof captureObjects!=='function'||typeof reconcileObjects!=='function')throw fail('maintenance_object_deletion_contribution_not_connected');
    objectPointers=await captureObjects(database);
   }
   context.artifacts.security=await replayNativeCurrentFacts({database,contribution:context.currentFacts.current,controlDirectory:this.controlDirectory,endpoint:context.authority.endpoint,recoveryId:context.intent.operationId});
   context.artifacts.deletion=await replayDeletionRecoveryContribution({database,contribution:context.currentFacts.deletion,recoveryId:context.intent.operationId,endpoint:context.authority.endpoint,executorRef:'maintenance-native-fixed',controlDirectory:this.controlDirectory});
   // Run native body receipts and the original chat room-transition rules on
   // this quarantine BEFORE pg_dump seals the database transferred to live.
   if(context.intent.moduleIds.includes('chat')){
    if(typeof reconcileNative!=='function')throw fail('maintenance_prosody_reconciliation_not_connected');
    context.artifacts.prosodySecurity=await reconcileNative(database);
   }
   if(context.intent.moduleIds.includes('objects'))context.artifacts.objectDeletionPlan=await reconcileObjects(database,objectPointers);
  }finally{await database.end();}
  if(context.intent.moduleIds.includes('agentos')){
   const native=context.footprint.moduleDatabaseBindings.agentos;
   // The fixed Agno 3.1.7 native queue is durable. Point-in-time queued/running
   // tickets cannot automatically restart model calls or tools after recovery.
   // HITL history stays at the point; continuation still needs current Galaxy
   // execution authority and fresh source checks.
   const schema=sqlName(native.schema),sql=`DO $restore$ BEGIN
    IF to_regclass('${schema}.agno_jobs') IS NOT NULL THEN
     UPDATE ${schema}.agno_jobs SET status='cancelled',attempt=attempt+1,locked_by=NULL,locked_at=NULL,updated_at=extract(epoch FROM now())::bigint,completed_at=extract(epoch FROM now())::bigint WHERE status IN ('queued','running');
    END IF;
    IF to_regclass('${schema}.agno_runs') IS NOT NULL THEN
     UPDATE ${schema}.agno_runs SET status='CANCELLED',run_data=jsonb_set(run_data,'{status}','"CANCELLED"'),updated_at=extract(epoch FROM now())::bigint WHERE status IN ('PENDING','RUNNING');
    END IF;
   END $restore$;`;
   await this.run(this.config.tools.docker,postgresSqlArguments({...live,container:clone.container,socketPath:clone.socketPath,database:native.database},sql),{timeout:60000,maxOutput:1024});
  }
  const prefix='gr_'+context.intent.operationId.replaceAll('-','').slice(0,16),directory=context.artifacts.directory+'/database-transfer';
  await noSymlinkPath(directory);await mkdir(directory,{mode:0o700});
  const transfers=[];
  for(const name of restoredDatabaseNames(context,this.config)){
   // Application roles/passwords live in the current cluster; pg_dump transfers
   // a database, never the point's pg_authid or old role passwords.
   const query="SELECT json_build_object('owner',pg_get_userbyid(datdba),'encoding',pg_encoding_to_char(encoding),'provider',datlocprovider,'locale',datcollate,'ctype',datctype,'allowConnections',datallowconn,'acl',(SELECT coalesce(json_agg(json_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]'::json) FROM aclexplode(COALESCE(datacl,acldefault('d',datdba))) a)) FROM pg_database WHERE datname="+literal(name);
   const metadata=JSON.parse((await this.run(this.config.tools.docker,postgresSqlArguments({...live,database:'postgres'},query),{maxOutput:4096})).stdout.trim());
   if(!metadata?.owner||!/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(metadata.owner))throw fail('maintenance_database_owner_unknown');
   const candidate=(prefix+'_'+name).slice(0,63),previous=(prefix+'_before_'+name).slice(0,63),dumpPath=directory+'/'+name+'.dump';
   sqlName(candidate);sqlName(previous);
   const inClone='/var/lib/postgresql/.galaxy-'+context.intent.operationId+'-'+name+'.dump';
   await this.run(this.config.tools.docker,['exec','--user','postgres',clone.container,'pg_dump','--host',clone.socketPath,'--username',live.administrator,'--dbname',name,'--format=custom','--file',inClone],{timeout:14400000,maxOutput:1024});
   await this.run(this.config.tools.docker,['cp',clone.container+':'+inClone,dumpPath],{timeout:14400000,maxOutput:1024});
   const exists=(await this.run(this.config.tools.docker,postgresSqlArguments({...live,database:'postgres'},'SELECT count(*) FROM pg_database WHERE datname IN ('+literal(candidate)+','+literal(previous)+')'),{maxOutput:1024})).stdout.trim();
   if(exists!=='0')throw fail('maintenance_database_candidate_already_exists');
   // CREATE DATABASE cannot run in a transaction. Fixed identifiers are derived
   // from the approved operation; an existing candidate is never overwritten.
   if(metadata.allowConnections!==true)throw fail('maintenance_current_database_not_open');
   if(metadata.provider!=='c')throw fail('maintenance_database_locale_provider_not_supported');
   if(!Array.isArray(metadata.acl)||metadata.acl.some(x=>!['CONNECT','CREATE','TEMPORARY'].includes(x.privilege)||typeof x.grantable!=='boolean'||x.role!=='PUBLIC'&&!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(x.role)))throw fail('maintenance_current_database_acl_unknown');
   await this.run(this.config.tools.docker,postgresSqlArguments({...live,database:'postgres'},'CREATE DATABASE '+sqlName(candidate)+' WITH TEMPLATE template0 OWNER '+roleName(metadata.owner)+' ENCODING '+literal(metadata.encoding)+' LC_COLLATE '+literal(metadata.locale)+' LC_CTYPE '+literal(metadata.ctype)),{timeout:60000,maxOutput:1024});
   await this.run(this.config.tools.docker,postgresSqlArguments({...live,database:'postgres'},'REVOKE ALL PRIVILEGES ON DATABASE '+sqlName(candidate)+' FROM PUBLIC,'+roleName(metadata.owner)),{timeout:15000,maxOutput:1024});
   const inLive='/var/lib/postgresql/.galaxy-import-'+context.intent.operationId+'-'+name+'.dump';
   await this.run(this.config.tools.docker,['cp',dumpPath,live.container+':'+inLive],{timeout:14400000,maxOutput:1024});
   await this.run(this.config.tools.docker,['exec','--user','postgres',live.container,'pg_restore','--exit-on-error','--host',live.socketPath,'--username',live.administrator,'--dbname',candidate,inLive],{timeout:14400000,maxOutput:1024});
   await this.run(this.config.tools.docker,postgresSqlArguments({...live,database:'postgres'},'ALTER DATABASE '+sqlName(candidate)+' ALLOW_CONNECTIONS false'),{timeout:15000,maxOutput:1024});
   transfers.push({name,candidate,previous,owner:metadata.owner,acl:metadata.acl});
  }
  return transfers;
 }
 async activate(context){
  const live=this.business(),transfers=context.artifacts.transfers??[];
  if(!transfers.length)return{accepted:true,databases:0};
  const commands=[];
  for(const row of transfers){
   // A connected current control plane is deliberately drained before rename.
   // Current auth facts/plans were already merged into the candidate.
   commands.push('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('+literal(row.name)+','+literal(row.candidate)+') AND pid<>pg_backend_pid()');
   commands.push('ALTER DATABASE '+sqlName(row.name)+' ALLOW_CONNECTIONS false');
   commands.push('ALTER DATABASE '+sqlName(row.name)+' RENAME TO '+sqlName(row.previous));
   commands.push('ALTER DATABASE '+sqlName(row.candidate)+' RENAME TO '+sqlName(row.name));
   commands.push('ALTER DATABASE '+sqlName(row.name)+' ALLOW_CONNECTIONS true');
   // Use current database grants. Do not assume PUBLIC was enabled,
   // and do not import the point's older authentication/connection policy.
   for(const acl of row.acl)commands.push('GRANT '+acl.privilege+' ON DATABASE '+sqlName(row.name)+' TO '+(acl.role==='PUBLIC'?'PUBLIC':roleName(acl.role))+(acl.grantable?' WITH GRANT OPTION':''));
  }
  await this.run(this.config.tools.docker,postgresSqlArguments({...live,database:'postgres'},'BEGIN; '+commands.join('; ')+'; COMMIT;'),{timeout:60000,maxOutput:2048});
  const business=transfers.find(x=>x.name===live.database);
  if(business){
   const sql="UPDATE recovery_state SET status='ready' WHERE singleton=true AND recovery_id="+literal(context.intent.operationId)+"::uuid AND status='quarantined' RETURNING recovery_id";
   const changed=(await this.run(this.config.tools.docker,postgresSqlArguments(live,sql),{maxOutput:1024})).stdout.trim();
   if(changed!==context.intent.operationId)throw fail('maintenance_exact_quarantine_required');
  }
  return{accepted:true,databases:transfers.length};
 }
 async validate(context){
  if(!context.artifacts.security?.authorityPreserved||!context.artifacts.security?.outbound?.submittedNotRetried||!context.artifacts.deletion?.quarantined)throw fail('maintenance_current_recovery_facts_incomplete');
  const live=this.business();
  const result=(await this.run(this.config.tools.docker,postgresSqlArguments(live,"SELECT json_build_object('schema',(SELECT max(version) FROM schema_migrations),'recovery',(SELECT row_to_json(r) FROM recovery_state r WHERE singleton=true),'invalidSessions',(SELECT count(*) FROM operations_operator_sessions_v1))"),{maxOutput:8192})).stdout.trim();
  const row=JSON.parse(result);
  if(context.activated&&restoredDatabaseNames(context,this.config).includes(live.database)&&(row.recovery?.recovery_id!==context.intent.operationId||row.recovery?.status!=='ready'))throw fail('maintenance_database_consistency_unconfirmed');
  return{schema:row.schema,ready:true};
 }
}
