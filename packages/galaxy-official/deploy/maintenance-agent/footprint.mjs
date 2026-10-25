import {createHash} from 'node:crypto';
import {readFile,realpath,lstat,readlink,readdir} from 'node:fs/promises';
import {posix} from 'node:path';
import {runCommand,postgresSqlArguments} from '../operations-stack/host.mjs';
import {maintenanceModules} from '../../src/operations-maintenance-catalog.mjs';
import {serviceImmutableReleasePaths,immutableReleaseSourceIds,keycloakOnlinePostgresBinding} from './online-capture-facts.mjs';

export const currentServiceBindings=Object.freeze([
 {id:'api',unit:'galaxy-api@pilot.service',module:'business',release:'api-release'},
 {id:'worker',unit:'galaxy-worker@pilot.service',module:'business',release:'worker-release'},
 {id:'publisher',unit:'galaxy-content-publisher-pilot.service',module:'messaging',release:'publisher-release'},
 {id:'admin',unit:'galaxy-admin-pilot.service',module:'configuration',release:'admin-release'},
]);
export const currentContainerBindings=Object.freeze([
 {id:'keycloak',name:'galaxy-accounts-pilot-keycloak-1',module:'accounts',writer:true},
 {id:'chat',name:'galaxy-chat-pilot-chat-1',module:'chat',writer:true},
 {id:'objects',name:'galaxy-attachment-storage',module:'objects',writer:true},
 {id:'scanner',name:'galaxy-attachment-scanner',module:'objects',writer:false,captureMutable:false},
 {id:'grafana',name:'galaxy-operations-grafana',module:'configuration',writer:true},
 {id:'analytics-api',name:'galaxy-discovery-op-api-1',module:'analytics',writer:true},
 {id:'analytics-worker',name:'galaxy-discovery-op-worker-1',module:'analytics',writer:true},
 {id:'agentos',name:'galaxy-operations-agentos',module:'agentos',writer:true},
 {id:'model-gateway',name:'galaxy-model-gateway',aliases:['galaxy-model-gateway-model-gateway-1'],module:'configuration',writer:true},
 {id:'recommendation',name:'galaxy-discovery-gorse-1',module:'recommendation',writer:true},
 {id:'search',name:'galaxy-discovery-meilisearch-1',module:'search',writer:true},
 {id:'analytics-db',name:'galaxy-discovery-op-db-1',module:'analytics',writer:true},
 {id:'analytics-cache',name:'galaxy-discovery-op-kv-1',module:'analytics',writer:true},
 {id:'analytics-events',name:'galaxy-discovery-op-ch-1',module:'analytics',writer:true},
 {id:'recommendation-db',name:'galaxy-discovery-gorse-db-1',module:'recommendation',writer:true},
 {id:'recommendation-cache',name:'galaxy-discovery-gorse-kv-1',module:'recommendation',writer:true},
]);
const releasePattern=/\/(?:opt\/galaxy\/releases|srv\/galaxy\/admin\/releases)\/[A-Za-z0-9._-]+/g;
const allowedRoots=['/opt/galaxy/releases/','/srv/galaxy/admin/releases/','/srv/galaxy/auth/releases/','/srv/galaxy/website/releases/','/opt/galaxy/operations-engines/','/var/lib/docker/volumes/','/var/lib/galaxy/','/etc/galaxy/'];
const code=message=>Object.assign(new Error(message),{code:message});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const below=(root,path)=>path.startsWith(root.endsWith('/')?root:root+'/');
export function approvedFootprintPath(path){return typeof path==='string'&&posix.normalize(path)===path&&!/[\p{Cc}\\]/u.test(path)&&allowedRoots.some(root=>below(root,path));}
function uniqueSources(sources){
 const byPath=new Map();
 for(const entry of sources){const old=byPath.get(entry.path);if(old){old.modules=[...new Set([...(old.modules??[]),...(entry.modules??[])])];continue;}byPath.set(entry.path,{...entry,modules:[...(entry.modules??[])]});}
 return [...byPath.values()].sort((a,b)=>a.id.localeCompare(b.id));
}
async function serviceFacts(config,binding,{run,fs,captureProof}){
 const properties='LoadState,ActiveState,WorkingDirectory,ExecStart,EnvironmentFiles'+(captureProof?',User,ProtectSystem,ReadWritePaths,BindPaths,TemporaryFileSystem,RootDirectory,RootImage':'');
 const value=(await run(config.tools.systemctl,['show',binding.unit,'--no-pager','--property='+properties])).stdout;
 const fields=Object.fromEntries(value.trim().split('\n').filter(x=>x.includes('=')).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
 const releases=new Set((fields.ExecStart??'').match(releasePattern)??[]),configurationPaths=new Map();
 for(const file of (fields.EnvironmentFiles??'').match(/\/etc\/galaxy\/[A-Za-z0-9._/-]+/g)??[]){
  const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>262144)throw code('maintenance_runtime_reference_invalid');
  for(const line of (await fs.readFile(file,'utf8')).split(/\r?\n/)){
   // These are path metadata. All other environment values remain unread by
   // the projection and are never returned, logged or interpolated in a shell.
   const match=/^GALAXY_RELEASE_DIRECTORY=(.*)$/.exec(line);
   if(match)for(const root of match[1].match(releasePattern)??[])releases.add(root);
   const reference=/^([A-Z][A-Z0-9_]*_FILE)=(\/[^\r\n]+)$/.exec(line);
   if(reference&&approvedFootprintPath(reference[2])){
    // This metadata is created only after an explicit operations-mail apply.
    // A different required reference to the same path must remain required.
    const optional=reference[1]==='GALAXY_SYSTEM_SETTINGS_MAIL_METADATA_FILE';
    configurationPaths.set(reference[2],optional&&configurationPaths.get(reference[2])!==false);
   }
  }
 }
 for(const root of (fields.WorkingDirectory??'').match(releasePattern)??[])releases.add(root);
 if(fields.LoadState!=='loaded')return{...binding,state:'unavailable',releasePaths:[],reason:'maintenance_service_not_loaded'};
 if(!releases.size)return{...binding,state:'unknown',releasePaths:[],reason:'maintenance_current_release_unknown'};
 const paths=[];for(const root of releases){if(!approvedFootprintPath(root))throw code('maintenance_runtime_reference_invalid');paths.push(await fs.realpath(root));}
 const releaseProtectionDigest=captureProof?digest(Object.fromEntries(['User','ProtectSystem','ReadWritePaths','BindPaths','TemporaryFileSystem','RootDirectory','RootImage'].map(key=>[key,fields[key]??'']))):null;
 return{...binding,state:'available',active:fields.ActiveState==='active',releasePaths:paths.sort(),immutableReleasePaths:captureProof?serviceImmutableReleasePaths(fields,paths):[],releaseProtectionDigest,configurationPaths:[...configurationPaths.keys()].sort(),optionalConfigurationPaths:[...configurationPaths].filter(([,optional])=>optional).map(([path])=>path),reason:null};
}
async function containerFacts(config,binding,{run}){
  if(binding.aliases?.length){
   const rows=[];for(const name of [binding.name,...binding.aliases])rows.push(await containerFacts(config,{...binding,name,aliases:[]},{run}));
   return rows.find(row=>row.state==='available'&&row.active)??rows.find(row=>row.state==='available')??rows[0];
  }
 try{
  // The template excludes environment, labels containing arbitrary values,
  // credentials, command arguments and container logs.
  const template='{"image":{{json .Image}},"state":{{json .State.Status}},"mounts":{{json .Mounts}},"composeDirectory":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}}';
  const output=await run(config.tools.docker,['inspect','--format',template,binding.name],{timeout:15000,maxOutput:262144});
  const x=JSON.parse(output.stdout);if(!Array.isArray(x.mounts)||x.mounts.length>50||!/^sha256:[a-f0-9]{64}$/.test(x.image??''))throw code('maintenance_native_response_invalid');
  const mounts=x.mounts.filter(m=>['bind','volume'].includes(m.Type)).map(m=>({type:m.Type,path:m.Source,target:m.Destination,writable:m.RW===true})).sort((a,b)=>{
   const left=JSON.stringify([a.type,a.path,a.target,a.writable]),right=JSON.stringify([b.type,b.path,b.target,b.writable]);
   return left<right?-1:left>right?1:0;
  });
  if(mounts.some(m=>!approvedFootprintPath(m.path)&&!config.backup.sources.some(source=>source.path===m.path||below(source.path,m.path))))throw code('maintenance_volume_outside_registered_roots');
  return{...binding,state:'available',active:x.state==='running',image:x.image,mounts,unprovenMounts:x.mounts.some(m=>!['bind','volume','tmpfs'].includes(m.Type)),composeDirectory:approvedFootprintPath(x.composeDirectory)?x.composeDirectory:null,reason:null};
 }catch(error){return{...binding,state:'unknown',image:null,mounts:[],composeDirectory:null,reason:error.code??'maintenance_container_unavailable'};}
}
async function agentOsDatabaseBinding(config,{run,fs}){
 try{
  const file='/etc/galaxy/agentos/runtime.env',s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>262144)throw code('maintenance_runtime_reference_invalid');
  const lines=(await fs.readFile(file,'utf8')).split(/\r?\n/),values=lines.filter(line=>line.startsWith('GALAXY_AGENTOS_DATABASE_URL='));if(values.length!==1)throw code('maintenance_runtime_reference_invalid');
  const schema=lines.find(line=>line.startsWith('GALAXY_AGENTOS_DATABASE_SCHEMA='))?.slice('GALAXY_AGENTOS_DATABASE_SCHEMA='.length)||'galaxy_agentos';
  if(!/^galaxy_agentos[a-z0-9_]{0,50}$/.test(schema))throw code('maintenance_runtime_reference_invalid');
  // Parse only the destination metadata in process. User/password/URL are
  // deliberately absent from the returned binding and the capture manifest.
  const url=new URL(values[0].slice('GALAXY_AGENTOS_DATABASE_URL='.length)),database=decodeURIComponent(url.pathname.slice(1));
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/^galaxy_[a-z0-9_]{1,55}$/.test(database))throw code('maintenance_runtime_reference_invalid');
  const port=url.port||'5432';
  for(const pg of config.postgres){
   const result=await run(config.tools.docker,['inspect','--format','{{json .NetworkSettings.Ports}}',pg.container],{timeout:10000,maxOutput:32768});
   const ports=JSON.parse(result.stdout);
   if((ports?.['5432/tcp']??[]).some(p=>['127.0.0.1','::1'].includes(p.HostIp)&&p.HostPort===port))return{state:'available',stanza:pg.id,database,schema};
  }
 }catch{/* Missing or unrecognized metadata is unknown, never another cluster. */}
 return{state:'unknown',stanza:null,database:null};
}
export async function resolveMaintenanceFootprint(config,{run=runCommand,fs={readFile,realpath,lstat,readlink,readdir},services=currentServiceBindings,containers=currentContainerBindings,captureProof=false}={}){
 const serviceRows=[];for(const binding of services)serviceRows.push(await serviceFacts(config,binding,{run,fs,captureProof}));
 const containerRows=[];for(const binding of containers)containerRows.push(await containerFacts(config,binding,{run}));
 const agentosDatabase=await agentOsDatabaseBinding(config,{run,fs});
 const sources=config.backup.sources.filter(s=>!['api-release','admin-release','website-base-release','worker-release','publisher-release'].includes(s.id)).map(s=>({...s,modules:[]}));
 for(const row of serviceRows)for(const [i,path] of row.releasePaths.entries())sources.push({id:row.release+(i?'-'+i:''),path,kind:'tree',optional:false,modules:[row.module,'configuration']});
 for(const row of serviceRows)for(const [i,path]of(row.configurationPaths??[]).entries()){
  if(sources.some(s=>s.path===path||below(s.path,path)))continue;
  const optional=serviceRows.every(other=>!other.configurationPaths?.includes(path)||other.optionalConfigurationPaths?.includes(path)===true);
  let info;try{info=await fs.lstat(path);}catch(error){if(!optional||error.code!=='ENOENT')throw error;}
  if(info&&(!info.isFile()||info.isSymbolicLink()))throw code('maintenance_runtime_reference_invalid');
  sources.push({id:row.id+'-configuration-'+i,path,kind:'file',optional,modules:['configuration'],captureMode:'current-protected-configuration'});
 }
 const writers=[...config.backup.writers];
 for(const row of containerRows){
  if(row.state!=='available')continue;
  if(row.writer&&!writers.some(w=>w.kind==='container'&&w.name===row.name))writers.push({kind:'container',name:row.name});
  for(const [i,mount] of row.mounts.entries()){
   if(mount.writable&&row.captureMutable===false)continue;
   // A live mutable volume is never represented as an online-consistent
   // file copy. Its exact owner is stopped by the bounded quiesce sequence.
   if(sources.some(s=>mount.path===s.path||below(s.path,mount.path)))continue;
   const info=await fs.lstat(mount.path);if(info.isSymbolicLink())throw code('maintenance_volume_symlink_rejected');
   sources.push({id:row.id+'-mount-'+i,path:mount.path,kind:info.isFile()?'file':'tree',optional:false,modules:[row.module],captureMode:mount.writable?'bounded-quiesced-volume':'configuration-file',owner:row.name});
  }
  if(row.composeDirectory&&!sources.some(s=>row.composeDirectory===s.path||below(s.path,row.composeDirectory)))sources.push({id:row.id+'-runtime-source',path:row.composeDirectory,kind:'tree',optional:false,modules:['configuration']});
 }
 // Current CMS output may link to a different immutable base release. Resolve
 // those release dependencies, rather than retaining a hard-coded old base.
 const website=sources.find(x=>x.id==='website-release');
 if(website){
  const root=await fs.realpath(website.path);
  for(const name of await fs.readdir(root)){
   const path=posix.join(root,name),info=await fs.lstat(path);if(!info.isSymbolicLink())continue;
   const target=await fs.realpath(path);if(!approvedFootprintPath(target))throw code('maintenance_website_dependency_outside_registered_roots');
   const release=/^\/srv\/galaxy\/website\/releases\/[^/]+/.exec(target)?.[0];
   if(release&&!sources.some(s=>s.path===release))sources.push({id:'website-dependency-'+sources.length,path:release,kind:'tree',optional:false,modules:['website','configuration']});
  }
 }
 const knownModules={business:['business'],accounts:['accounts'],agentos:['business'],messaging:['business'],chat:['prosody'],objects:['garage'],website:['website-release'],configuration:['configuration']};
 const resultSources=uniqueSources(sources);
 const immutableSources=captureProof?await immutableReleaseSourceIds(resultSources,serviceRows,containerRows,{fs}):[];
 const keycloakOnline=captureProof?await keycloakOnlinePostgresBinding(config,containerRows.find(row=>row.id==='keycloak'),{run}):{state:'not-checked',stanza:null,database:null,reason:'capture-proof-not-requested'};
 const coverage=maintenanceModules.map(module=>{
  const bindings=containerRows.filter(x=>x.module===module.id),sourceIds=resultSources.filter(x=>x.modules.includes(module.id)||(knownModules[module.id]??[]).includes(x.id)).map(x=>x.id);
  const postgresStanzas=(['business','accounts'].includes(module.id)?[module.id]:module.id==='agentos'&&agentosDatabase.state==='available'?[agentosDatabase.stanza]:module.id==='messaging'?['business']:[]).filter(id=>config.postgres.some(pg=>pg.id===id));
  const unknown=bindings.some(x=>x.state!=='available')||serviceRows.some(x=>x.module===module.id&&x.state!=='available')||(module.id==='agentos'&&agentosDatabase.state!=='available');
  const covered=!unknown&&(sourceIds.length>0||postgresStanzas.length>0);
  return{id:module.id,state:covered?'covered':unknown?'unknown':'uncovered',sourceIds,postgresStanzas,method:postgresStanzas.length?'pgbackrest-cluster':bindings.some(x=>x.mounts.some(m=>m.writable))?'bounded-quiesced-volume':'selected-files',reasonCodes:covered?[]:[unknown?'maintenance_current_footprint_unknown':'maintenance_source_not_registered'],existenceAtOlderPoint:'not-inferred'};
 });
 const sourceIdentities=[];for(const {id,path,kind,optional} of resultSources){let resolvedPath=null;try{resolvedPath=await fs.realpath(path);}catch(error){if(!optional)throw code('maintenance_source_unavailable');}sourceIdentities.push({id,path,resolvedPath,kind,optional:!!optional});}
 const moduleDatabaseBindings={agentos:agentosDatabase};
 const identity={sources:sourceIdentities,writers,moduleDatabaseBindings,...(captureProof?{immutableSources,keycloakOnline:keycloakOnline.state==='available'?keycloakOnline:null}:{}),services:serviceRows.map(({id,releasePaths,state,releaseProtectionDigest})=>({id,releasePaths,state,...(captureProof?{releaseProtectionDigest:releaseProtectionDigest??null}:{})})),containers:containerRows.map(({id,image,mounts,state,composeDirectory,unprovenMounts})=>({id,image,mounts,state,composeDirectory,...(captureProof?{unprovenMounts:unprovenMounts??null}:{})}))};
 return{version:1,digest:digest(identity),captureProof,sources:resultSources,writers,services:serviceRows,containers:containerRows,coverage,moduleDatabaseBindings,immutableSources,keycloakOnline,identity};
}

export function maintenanceCaptureConfiguration(config,footprint){
 if(footprint.captureProof!==true)throw code('maintenance_capture_proof_required');
 if(footprint.coverage.some(x=>x.state!=='covered'))throw code('maintenance_capture_coverage_incomplete');
 // Database containers are appended after application writers; quiesce resumes
 // in reverse order. Existing pgBackRest clusters remain online and create
 // their named recovery points only after application writers have stopped.
 const online=footprint.keycloakOnline?.state==='available',keycloak=footprint.containers.find(row=>row.id==='keycloak');
 return{...config,backup:{...config.backup,sources:footprint.sources.map(({modules,captureMode,owner,...s})=>s),precopySourceIds:footprint.immutableSources,
  writers:footprint.writers.filter(writer=>!(online&&keycloak&&writer.kind==='container'&&writer.name===keycloak.name))}};
}

export async function maintenanceCaptureContext(config,footprint,{run=runCommand,resolve=resolveMaintenanceFootprint}={}){
 if(footprint.captureProof!==true)throw code('maintenance_capture_proof_required');
 const current=await resolve(config,{run,captureProof:true});if(current.captureProof!==true||current.digest!==footprint.digest)throw code('maintenance_current_footprint_changed');
 if(footprint.keycloakOnline?.state==='available'&&footprint.containers.find(row=>row.id==='keycloak')?.active&&!current.containers.find(row=>row.id==='keycloak')?.active)throw code('maintenance_current_footprint_changed');
 const clusterDatabases=[];
 for(const pg of config.postgres){
  const query="SELECT coalesce(json_agg(datname ORDER BY datname),'[]'::json) FROM pg_database WHERE NOT datistemplate";
  const result=await run(config.tools.docker,postgresSqlArguments(pg,query),{timeout:10000,maxOutput:32768});
  const names=JSON.parse(result.stdout.trim());if(!Array.isArray(names)||names.some(x=>typeof x!=='string'||x.length>63))throw code('maintenance_cluster_metadata_invalid');
  clusterDatabases.push({stanza:pg.id,databases:names});
 }
 const agentos=footprint.moduleDatabaseBindings.agentos;
 if(agentos.state!=='available'||!clusterDatabases.find(x=>x.stanza===agentos.stanza)?.databases.includes(agentos.database))throw code('maintenance_agentos_database_not_in_cluster');
 if(footprint.keycloakOnline?.state==='available'&&!clusterDatabases.find(x=>x.stanza===footprint.keycloakOnline.stanza)?.databases.includes(footprint.keycloakOnline.database))throw code('maintenance_keycloak_database_not_in_cluster');
 // An absent optional source is recorded by capture.omittedSources; it is
 // not evidence that bytes were captured. Required source bindings stay exact.
 const absentOptional=new Set(footprint.identity.sources.filter(source=>source.optional&&source.resolvedPath===null).map(source=>source.id));
 const sources=footprint.sources.filter(source=>!absentOptional.has(source.id));
 const coverage=footprint.coverage.map(row=>({...row,sourceIds:row.sourceIds.filter(id=>!absentOptional.has(id))}));
 if(coverage.some(row=>row.state==='covered'&&!row.sourceIds.length&&!row.postgresStanzas.length))throw code('maintenance_capture_coverage_incomplete');
 return{version:1,footprintDigest:footprint.digest,coverage,immutableSourceIds:footprint.immutableSources,onlinePostgresBindings:footprint.keycloakOnline?.state==='available'?[{component:'keycloak',stanza:footprint.keycloakOnline.stanza,database:footprint.keycloakOnline.database}]:[],moduleDatabaseBindings:footprint.moduleDatabaseBindings,clusterDatabases,
  sourceBindings:sources.map(({id,path,kind,modules,captureMode,owner})=>({id,path,kind,modules,captureMode:captureMode??null,owner:owner??null})),
  images:footprint.containers.filter(x=>x.image).map(({id,image})=>({id,image}))};
}
