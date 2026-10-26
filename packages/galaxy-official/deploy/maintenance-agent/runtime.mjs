import {statfs,lstat,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {posix} from 'node:path';
import {runCommand,resticEnvironment,withJobLock} from '../operations-stack/host.mjs';
import {createProductBackup} from '../operations-stack/backup.mjs';
import {readBackupStatus} from '../../src/operations/backup-status.mjs';
import {normalizeOperationalRecord} from '../operations-stack/log-record.mjs';
import {maintenanceModules,maintenanceOpeningConditions} from '../../src/operations-maintenance-catalog.mjs';
import {maintenanceNativeCommandSchema} from '../../src/shared/operations-maintenance-schema.mjs';
import {maintenanceRequestSignature} from '../../src/operations-maintenance-native.mjs';
import {resolveMaintenanceFootprint,maintenanceCaptureConfiguration,maintenanceCaptureContext} from './footprint.mjs';
import {MaintenanceControlJournal} from './journal.mjs';
import {MaintenanceRestoreExecutor} from './restore-executor.mjs';
import {createHostRestoreAdapters} from './host-restore.mjs';
import {createMaintenanceProsodyProbe} from './prosody-live-client.mjs';
import {readMaintenanceComponentStatus} from './component-status.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const iso=seconds=>seconds==null?null:new Date(seconds*1000).toISOString();
const snapshotId=/^[a-f0-9]{64}$/;
const captureId=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const knownState=value=>['active','inactive','failed'].includes(value)?value:'unknown';
const status=row=>row?{...row,startedAt:iso(row.startedAt),finishedAt:iso(row.finishedAt),lastSuccessAt:iso(row.lastSuccessAt)}:null;
const periodSeconds={'15m':900,'1h':3600,'24h':86400};
const commandView=operation=>{if(!operation)return null;const{intent,intentDigest,approval,backupDiagnostic,...safe}=operation;return safe;};

export class MaintenanceNativeRuntime{
 constructor({configuration,run=runCommand,now=()=>new Date(),journal=null,restoreAdapters=null,fetchImpl=fetch,footprint=resolveMaintenanceFootprint,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  Object.assign(this,{configuration,config:configuration.operations,run,now,fetchImpl,resolveFootprint:footprint,pause});
  this.journal=journal??new MaintenanceControlJournal({directory:configuration.controlDirectory,now});
  this.restoreExecutor=new MaintenanceRestoreExecutor({journal:this.journal,adapters:restoreAdapters??createHostRestoreAdapters({config:this.config,run,controlDirectory:configuration.controlDirectory,productionEnabled:configuration.production?.enabled===true,fetchImpl,prosodyProbe:configuration.production?.enabled===true?createMaintenanceProsodyProbe({configuration,fetchImpl}):null}),now});this.tasks=new Map();
 }
 async footprint({captureProof=false}={}){return this.resolveFootprint(this.config,{run:this.run,captureProof});}
 async restic(args,{timeout=30000,maxOutput=8388608}={}){
  if(!this.config.tools.restic)throw fail('maintenance_repository_not_configured');
  return this.run(this.config.tools.restic,['--no-cache',...args],{env:await resticEnvironment(this.config),timeout,maxOutput});
 }
 async snapshots(){
  const result=await this.restic(['--no-lock','snapshots','--json','--host',this.config.backup.resticHost,'--tag','galaxy-product']);
  const rows=JSON.parse(result.stdout);if(!Array.isArray(rows)||rows.length>100000)throw fail('maintenance_catalog_response_invalid');
  return rows.filter(x=>snapshotId.test(x.id??'')&&Array.isArray(x.paths)&&x.paths.length===1&&(x.tags??[]).includes('galaxy-product'))
   .sort((a,b)=>String(b.time).localeCompare(String(a.time))||b.id.localeCompare(a.id));
 }
 async snapshot(id){if(!snapshotId.test(id))throw fail('maintenance_point_invalid');const row=(await this.snapshots()).find(x=>x.id===id);if(!row)throw fail('maintenance_backup_not_found');return row;}
 async manifest(snapshot){
  const id=(snapshot.tags??[]).filter(x=>/^capture:/.test(x)).map(x=>x.slice(8));
  if(id.length!==1||!captureId.test(id[0])||snapshot.paths[0]!==this.config.directories.captures+'/'+id[0])throw fail('maintenance_capture_metadata_invalid');
  const result=await this.restic(['--no-lock','dump',snapshot.id,snapshot.paths[0]+'/capture.json'],{maxOutput:1048576});
  const row=JSON.parse(result.stdout);
  if(row.version!==1||row.id!==id[0]||!Array.isArray(row.databases)||!Array.isArray(row.files)||row.files.length>1000)throw fail('maintenance_capture_metadata_invalid');
  return row;
 }
 coverage(manifest){
  if(manifest.maintenance?.version===1&&Array.isArray(manifest.maintenance.coverage))return manifest.maintenance.coverage;
  const sources=new Set(manifest.files.map(x=>x.id)),stanzas=new Set(manifest.databases.map(x=>x.id));
  const fileModules={chat:'prosody',objects:'garage',website:'website-release',configuration:'configuration'};
  return maintenanceModules.map(module=>{
   const database=['business','accounts'].includes(module.id)&&stanzas.has(module.id);
   const source=fileModules[module.id],file=source&&sources.has(source);
   // An old cluster capture does not prove a later-added database existed at
   // its recovery point. Do not retroactively claim Agno or messaging coverage.
   const unknown=['agentos','messaging'].includes(module.id)&&stanzas.has('business');
   return{id:module.id,state:database||file?'covered':unknown?'unknown':'uncovered',sourceIds:file?[source]:[],postgresStanzas:database?[module.id]:[],method:database?'pgbackrest-cluster':file?'selected-files':null,reasonCodes:database||file?[]:[unknown?'maintenance_module_existence_at_point_unknown':'maintenance_module_not_in_capture']};
  });
 }
 async pointFromSnapshot(snapshot){
  let manifest=null;try{manifest=await this.manifest(snapshot);}catch{/* The snapshot remains listed; metadata failure is not disappearance. */}
  const verified=await this.journal.verification(snapshot.id);
  const point={id:snapshot.id,createdAt:snapshot.time,captureId:manifest?.id??null,logicalBytes:snapshot.summary?.total_bytes_processed??null,logicalFileCount:snapshot.summary?.total_files_processed??null,
   integrity:{state:verified?'verified':'not-verified',checkedAt:verified?.checkedAt??null},coverage:manifest?this.coverage(manifest):[],
   capture:{state:manifest?'available':'unavailable',startedAt:iso(manifest?.captureStartedAt),finishedAt:iso(manifest?.captureFinishedAt),consistency:manifest?'named-pg-points-and-bounded-quiesced-files':null},
   productionRestore:{available:false,blockers:['maintenance_production_adapter_unavailable']}};
  return{point,manifest,snapshot};
 }
 async point(id){return this.pointFromSnapshot(await this.snapshot(id));}
 async timer(){
  try{const out=await this.run(this.config.tools.systemctl,['show','galaxy-operations-backup.timer','--no-pager','--property=ActiveState,UnitFileState,NextElapseUSecRealtime,LastTriggerUSec'],{timeout:5000});
   const x=Object.fromEntries(out.stdout.trim().split('\n').map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
   const time=v=>{const d=new Date(v);return Number.isFinite(d.getTime())?d.toISOString():null;};
   return{state:knownState(x.ActiveState),enabled:x.UnitFileState==='enabled'?true:['disabled','static'].includes(x.UnitFileState)?false:null,nextAt:time(x.NextElapseUSecRealtime),lastAt:time(x.LastTriggerUSec)};
  }catch{return{state:'unknown',enabled:null,nextAt:null,lastAt:null};}
 }
 async policy(){
  let repositoryLocation='unknown';
  try{const info=await lstat(this.config.backup.repositoryFile);if(info.isFile()&&!info.isSymbolicLink()&&!(info.mode&0o077)){const value=(await readFile(this.config.backup.repositoryFile,'utf8')).trim();if(value.startsWith('/'))repositoryLocation='same-host';else if(/^(?:s3|b2|azure|gs|sftp|rest|rclone):/.test(value))repositoryLocation='unknown';}}catch{/* No raw repository location enters a DTO or log. */}
  const lastCreate=await readBackupStatus(this.config.directories.status,'create').catch(()=>null);
  return{calendar:this.config.backup.calendar,retention:this.config.backup.retention,timer:await this.timer(),repository:{location:repositoryLocation,encrypted:repositoryLocation==='unknown'?null:true},pauseLimitSeconds:this.config.backup.maxPauseSeconds,lastCreate:status(lastCreate),lastVerification:null};
 }
 async catalog(query={limit:25}){
  const all=await this.snapshots();let offset=0;if(query.after){offset=all.findIndex(x=>x.id===query.after)+1;if(!offset)throw fail('maintenance_catalog_changed');}
  const selected=all.slice(offset,offset+query.limit),items=[];for(const snapshot of selected)items.push((await this.pointFromSnapshot(snapshot)).point);
  const footprint=await this.footprint();
  return{items,total:all.length,nextAfter:offset+items.length<all.length?items.at(-1)?.id??null:null,policy:await this.policy(),coverage:footprint.coverage,capabilities:{backupCreate:footprint.coverage.every(x=>x.state==='covered'),backupVerify:true}};
 }
 async fetchJson(url){const response=await this.fetchImpl(url,{signal:AbortSignal.timeout(5000)});if(!response.ok)throw fail('maintenance_native_read_failed');const text=await response.text();if(Buffer.byteLength(text)>4194304)throw fail('maintenance_native_response_limit');return JSON.parse(text);}
 async overview(){
  const footprint=await this.footprint(),at=this.now().toISOString();
  const components=await readMaintenanceComponentStatus(this.config,{footprint,run:this.run,fetchImpl:this.fetchImpl,now:this.now});
  const storage=[];
  for(const [id,path] of [['host-filesystem','/'],['backup-staging-filesystem',this.config.directories.captures]]){
   try{const s=await statfs(path),capacity=s.blocks*s.bsize,available=s.bavail*s.bsize,free=s.bfree*s.bsize;storage.push({id,availability:{state:'available'},capacityBytes:capacity,availableBytes:available,usedBytes:capacity-free,observedAt:at});}catch{storage.push({id,availability:{state:'unavailable',code:'maintenance_filesystem_read_failed'},capacityBytes:null,availableBytes:null,usedBytes:null,observedAt:at});}
  }
  let errors={availability:{state:'unavailable',code:'maintenance_log_counter_unavailable'},count:null};
  try{const query='sum(count_over_time({environment='+JSON.stringify(this.config.environment)+',level="error"}[1h]))';const v=await this.fetchJson('http://127.0.0.1:'+this.config.loki.port+'/loki/api/v1/query?query='+encodeURIComponent(query));const rows=v.data?.result;
   if(v.status==='success'&&Array.isArray(rows)){const count=rows.reduce((sum,x)=>sum+Number(x.value?.[1]??NaN),0);if(Number.isFinite(count)&&count>=0)errors={availability:{state:'available'},count};}
  }catch{}
  return{availability:{state:'available'},components,storage,coverage:footprint.coverage,errors};
 }
 async logs(query){
  const components=[...new Set([...this.config.logs,...this.config.journals,...this.config.dockerLogs].map(x=>x.component))].sort();
  if(query.component&&!components.includes(query.component))throw fail('maintenance_log_component_unknown');
  const nowNs=BigInt(this.now().getTime())*1000000n;
  const endNs=query.before?(/^[0-9]{16,20}$/.test(query.before)?BigInt(query.before):BigInt(Date.parse(query.before))*1000000n):nowNs;if(endNs>nowNs)throw fail('maintenance_log_window_invalid');
  const startNs=endNs-BigInt(periodSeconds[query.period])*1000000000n;
  const selectors=['environment='+JSON.stringify(this.config.environment)];if(query.component)selectors.push('component='+JSON.stringify(query.component));if(query.level!=='all')selectors.push('level='+JSON.stringify(query.level));
  const expression='{'+selectors.join(',')+'}',url='http://127.0.0.1:'+this.config.loki.port+'/loki/api/v1/query_range?'+new URLSearchParams({query:expression,start:startNs.toString(),end:endNs.toString(),direction:'backward',limit:String(query.limit)});
  const response=await this.fetchJson(url);if(response.status!=='success'||response.data?.resultType!=='streams'||!Array.isArray(response.data.result))throw fail('maintenance_native_response_invalid');
  const items=[];
  for(const stream of response.data.result){if(!components.includes(stream.stream?.component))continue;for(const pair of stream.values??[]){if(!Array.isArray(pair)||!/^[0-9]{16,20}$/.test(pair[0]))continue;const at=new Date(Number(BigInt(pair[0])/1000000n)).toISOString();items.push({...normalizeOperationalRecord(pair[1],{time:at}),component:stream.stream.component,at,cursor:pair[0]});}}
  items.sort((a,b)=>BigInt(a.cursor)>BigInt(b.cursor)?-1:BigInt(a.cursor)<BigInt(b.cursor)?1:0);return{items:items.slice(0,query.limit).map(({cursor,...item})=>item),components,nextBefore:items.length>=query.limit?(BigInt(items[query.limit-1].cursor)-1n).toString():null};
 }
 async preview(pointId,moduleIds){
  const source=await this.point(pointId),{point,manifest}=source,footprint=await this.footprint(),caps=this.restoreExecutor.capabilities(moduleIds),blockers=[...caps.blockers];
  if(!manifest)blockers.push('maintenance_capture_metadata_invalid');
  if(moduleIds.some(id=>point.coverage.find(x=>x.id===id)?.state!=='covered'))blockers.push('maintenance_point_coverage_incomplete');
  if(point.integrity.state!=='verified')blockers.push('maintenance_point_not_verified');
  if(typeof this.restoreExecutor.adapters?.inspect==='function')blockers.push(...(await this.restoreExecutor.adapters.inspect({point:source,footprint,moduleIds})).blockers);
  point.productionRestore={available:blockers.length===0,blockers:[...new Set(blockers)]};
  return{point,moduleIds,footprintDigest:footprint.digest,...caps,blockers:[...new Set(blockers)]};
 }
 async apiReadinessBinding(footprint){
  const authorizationUrl=this.configuration.authorizationUrl;
  if(!/^http:\/\/127[.]0[.]0[.]1:[0-9]{1,5}\/v1\/internal\/maintenance\/authorize$/.test(authorizationUrl??''))throw fail('maintenance_authorization_not_connected');
  const api=footprint.services.filter(row=>row.id==='api');
  if(api.length!==1||api[0].state!=='available'||api[0].releasePaths.length!==1)throw fail('maintenance_api_binding_invalid');
  const directory=api[0].releasePaths[0];
  if(typeof directory!=='string'||!/^\/opt\/galaxy\/releases\/[A-Za-z0-9._-]+$/.test(directory))throw fail('maintenance_api_binding_invalid');
  const file=directory+'/service-release.json',info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>1048576)throw fail('maintenance_api_binding_invalid');
  const release=JSON.parse(await readFile(file,'utf8'));
  if(release.kind!=='galaxy-official-service-release'||release.version!==1||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(release.releaseId??'')||release.entries?.api!=='packages/galaxy-official/src/server.mjs')throw fail('maintenance_api_binding_invalid');
  return{authorizationUrl,url:new URL(authorizationUrl).origin+'/readyz',releaseId:release.releaseId};
 }
 async authorizeAfterApiReady(intent,binding,onPhase=null){
  // systemctl start acknowledges a process, not an API listener. All writers
  // have already resumed here; wait only for this captured API's local probe.
  const deadline=this.now().getTime()+90000;
  for(let attempt=0;attempt<90;attempt++){
   const remaining=deadline-this.now().getTime();if(remaining<=0)break;
   let response,text;
   try{
    response=await this.fetchImpl(binding.url,{method:'GET',headers:{'x-forwarded-for':'127.0.0.1'},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(Math.min(3000,remaining))});
    text=await response.text();
   }catch(error){
    const temporary=['AbortError','TimeoutError'].includes(error?.name)||[error?.code,error?.cause?.code].some(code=>['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(code));
    if(!temporary)throw fail('maintenance_api_readiness_failed');
   }
   if(response&&text!==undefined){
    if(response.status===401||response.status===403)throw fail('maintenance_current_authorization_denied');
    if(response.headers.get('x-galaxy-release')!==binding.releaseId)throw fail('maintenance_api_binding_changed');
    if(Buffer.byteLength(text)>8192)throw fail('maintenance_native_response_limit');
    let value;try{value=JSON.parse(text);}catch{throw fail('maintenance_api_readiness_failed');}
    if(response.status===200&&value?.status==='ready'){
     if(this.configuration.authorizationUrl!==binding.authorizationUrl)throw fail('maintenance_api_binding_changed');
     // No retry of this authority decision or of the original backup command.
     if(onPhase)await onPhase('current-authorization');
     return this.authorize(intent);
    }
    if(response.status!==503||value?.status!=='unavailable')throw fail('maintenance_api_readiness_failed');
   }
   const delay=deadline-this.now().getTime();if(delay<=0)break;
   if(attempt<89)await this.pause(Math.min(1000,delay));
  }
  throw fail('maintenance_api_readiness_timeout');
 }
 async authorize(intent){
  const url=this.configuration.authorizationUrl;
  if(!/^http:\/\/127[.]0[.]0[.]1:[0-9]{1,5}\/v1\/internal\/maintenance\/authorize$/.test(url??''))throw fail('maintenance_authorization_not_connected');
  const data={operationId:intent.operationId,operatorId:intent.operatorId,kind:intent.kind,...(intent.kind==='backup-verify'?{pointId:intent.pointId}:{}),...(intent.kind==='restore-execute'?{planId:intent.planId,revision:intent.revision,planDigest:intent.planDigest,pointId:intent.pointId,moduleIds:intent.moduleIds,footprintDigest:intent.footprintDigest,openingConditions:intent.openingConditions,approvedAt:intent.approvedAt}:{})};
  const body=JSON.stringify(data),id=randomUUID(),at=String(Math.floor(this.now().getTime()/1000));
  const response=await this.fetchImpl(url,{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'127.0.0.1','x-galaxy-service-key':this.configuration.serviceKey,'x-galaxy-request-id':id,'x-galaxy-request-at':at,'x-galaxy-service-signature':maintenanceRequestSignature(this.configuration.serviceKey,{id,at,body})},body,signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw fail('maintenance_current_authorization_denied');const text=await response.text();if(Buffer.byteLength(text)>8192)throw fail('maintenance_native_response_limit');const value=JSON.parse(text);
  if(value.authorized!==true||value.operationId!==intent.operationId||value.operatorId!==intent.operatorId||value.kind!==intent.kind)throw fail('maintenance_current_authorization_denied');
  return value;
 }
 async start(intent){
  await this.authorize(intent);const started=await this.journal.begin(intent);if(!started.created)return commandView(started.row);
  const promise=this.perform(intent,started).catch(async error=>{try{return await this.journal.finish(started.row,error);}catch{return null;}}).finally(()=>{this.tasks.delete(intent.operationId);this.journal.active.delete(intent.operationId);});this.tasks.set(intent.operationId,promise);
  return commandView(started.row);
 }
 async perform(intent,started){
  const row=started.row;
  try{
   if(intent.kind==='backup-create'){
    const phase=value=>this.journal.backupPhase(row,value);
    await this.authorize(intent);const footprint=await this.footprint({captureProof:true}),binding=await this.apiReadinessBinding(footprint),configuration=maintenanceCaptureConfiguration(this.config,footprint);
    const receipt=await createProductBackup(configuration,{run:this.run,now:this.now,captureContext:()=>maintenanceCaptureContext(this.config,footprint,{run:this.run,resolve:()=>this.footprint({captureProof:true})}),onPhase:phase,beforeTransfer:async()=>{await phase('api-readiness');return this.authorizeAfterApiReady(intent,binding,phase);}});
    row.pointId=receipt.snapshotId;await phase('complete');return this.journal.finish(row);
   }
   if(intent.kind==='backup-verify'){
    await withJobLock(this.config,async()=>{await this.snapshot(intent.pointId);await this.authorize(intent);await this.restic(['check','--read-data',intent.pointId],{timeout:14400000,maxOutput:1048576});await this.snapshot(intent.pointId);await this.journal.verify(intent.pointId,intent.operationId);});
    return this.journal.finish(row);
   }
   if(intent.kind==='restore-execute'){
    const current=await this.preview(intent.pointId,intent.moduleIds);if(current.blockers.length||current.footprintDigest!==intent.footprintDigest)throw fail('maintenance_plan_changed');
    const point=await this.point(intent.pointId),footprint=await this.footprint();
    return await withJobLock(this.config,()=>this.restoreExecutor.execute(intent,{point,footprint,started,authorize:()=>this.authorize(intent)}));
   }
   throw fail('maintenance_native_command_unknown');
  }catch(error){return this.journal.finish(row,error);}
 }
 async call(input){
  const parsed=maintenanceNativeCommandSchema.safeParse(input);if(!parsed.success)throw fail('maintenance_native_request_invalid');const x=parsed.data;
  if(x.kind==='overview')return this.overview();if(x.kind==='catalog')return this.catalog(x.query??{limit:25});if(x.kind==='logs')return this.logs(x.query);
  if(x.kind==='point')return{point:(await this.point(x.pointId)).point};
  if(x.kind==='restore-preview')return this.preview(x.pointId,x.moduleIds);
  if(x.kind==='operation')return commandView(await this.journal.read(x.operationId));
  return this.start(x);
 }
}
