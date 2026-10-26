import {lstat,realpath,rename,mkdir,writeFile,readFile} from 'node:fs/promises';
import {posix} from 'node:path';
import {noSymlinkPath} from '../operations-stack/host.mjs';
import {approvedFootprintPath} from './footprint.mjs';
import {MaintenanceWebsitePointer} from './website-pointer.mjs';

const fail=code=>Object.assign(Error(code),{code});
const below=(root,path)=>path===root||path.startsWith(root+'/');
const protectedRoots=['/etc/galaxy','/var/lib/galaxy/config'];
const controlReleases=['api-release','worker-release','publisher-release','admin-release'];
export function maintenanceFileTransfers(context){
 const manifest=context.point.manifest,bindings=manifest.maintenance?.sourceBindings;
 if(!Array.isArray(bindings))throw fail('maintenance_point_source_bindings_not_recorded');
 const selected=new Set(context.intent.moduleIds),transfers=[];
 const currentSecrets=(context.footprint.containers??[]).flatMap(x=>x.mounts??[]).filter(x=>!x.writable&&x.target?.startsWith('/run/secrets/')).map(x=>x.path);
 if(currentSecrets.some(path=>typeof path!=='string'||!path.startsWith('/')))throw fail('maintenance_current_secret_binding_unknown');
 for(const item of manifest.files){
  const source=bindings.find(x=>x.id===item.id);if(!source||source.path!==item.path||source.kind!==item.kind||!Array.isArray(source.modules))throw fail('maintenance_point_source_bindings_invalid');
  const included=source.modules.some(id=>selected.has(id))||context.intent.moduleIds.some(id=>manifest.maintenance.coverage.find(x=>x.id===id)?.sourceIds?.includes(item.id));
  if(!included)continue;
  // Current protected configuration and the control-plane application remain
  // current. Engine data and the gateway's non-secret usage ledger are point
  // data. Never replace a key/env/config file using a directory rollback.
  if(protectedRoots.some(root=>below(root,item.path))||source.owner==='galaxy-accounts-pilot-keycloak-1'||controlReleases.some(id=>item.id===id||item.id.startsWith(id+'-'))||item.id.endsWith('-runtime-source')||source.captureMode==='current-protected-configuration')continue;
  if(source.owner&&source.captureMode!=='bounded-quiesced-volume')continue;
  if(!approvedFootprintPath(item.resolvedPath??item.path))throw fail('maintenance_restore_file_outside_registered_roots');
  const current=context.footprint.sources.find(x=>x.id===item.id);
  // Mutable data must still belong to the exact current owner/path. Immutable
  // website dependencies may live only at the point's registered release.
  if(source.owner&&(!current||current.owner!==source.owner||current.path!==item.path))throw fail('maintenance_restore_volume_binding_changed');
  const path=item.resolvedPath??item.path;
  if(path==='/etc/galaxy'||protectedRoots.some(root=>below(root,path)))continue;
  if(currentSecrets.some(file=>file===path))continue;
  if(currentSecrets.some(file=>below(path,file)))throw fail('maintenance_protected_native_configuration_in_point_transfer');
  transfers.push({sourceId:item.id,path,kind:item.kind,owner:source.owner??null,moduleIds:source.modules,preparedPath:context.artifacts.files+'/'+item.id,
   candidate:path+'.galaxy-next-'+context.intent.operationId,previous:path+'.galaxy-before-'+context.intent.operationId,existed:null});
 }
 // Do not rename both a parent and one of its descendants.
 const result=transfers.filter(row=>!transfers.some(other=>other!==row&&below(other.path,row.path)));
 if(new Set(result.map(x=>x.path)).size!==result.length)throw fail('maintenance_restore_file_binding_conflict');
 return result;
}
export class MaintenanceHostFiles{
 constructor({run,controlDirectory,website=new MaintenanceWebsitePointer()}){Object.assign(this,{run,controlDirectory,website});}
 async stage(context){
  const transfers=maintenanceFileTransfers(context);
  for(const row of transfers){
   await noSymlinkPath(row.path);await noSymlinkPath(row.candidate);await noSymlinkPath(row.previous);await noSymlinkPath(row.preparedPath);
   const source=await lstat(row.preparedPath);if(row.kind==='tree'?!source.isDirectory():!source.isFile())throw fail('maintenance_restore_file_type_changed');
   for(const path of [row.candidate,row.previous])try{await lstat(path);throw fail('maintenance_restore_candidate_already_exists');}catch(error){if(error.code!=='ENOENT')throw error;}
   try{const old=await lstat(row.path);if(row.kind==='tree'?!old.isDirectory():!old.isFile())throw fail('maintenance_restore_file_type_changed');if(await realpath(row.path)!==row.path)throw fail('maintenance_restore_target_changed');row.existed=true;}catch(error){if(error.code!=='ENOENT')throw error;row.existed=false;}
   await mkdir(posix.dirname(row.candidate),{recursive:true,mode:0o700});
   await this.run('/usr/bin/cp',['--archive','--reflink=auto','--one-file-system','--',row.preparedPath,row.candidate],{timeout:14400000,maxOutput:1024});
  }
  context.artifacts.fileTransfers=transfers;context.artifacts.website=await this.website.stage(context);
  const directory=this.controlDirectory+'/file-activations';await noSymlinkPath(directory);await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(directory+'/'+context.intent.operationId+'.json',JSON.stringify({version:1,operationId:context.intent.operationId,transfers,website:context.artifacts.website}),{flag:'wx',mode:0o600});
  return transfers;
 }
 async activate(context){
  const file=this.controlDirectory+'/file-activations/'+context.intent.operationId+'.json',saved=JSON.parse(await readFile(file,'utf8'));
  if(saved.operationId!==context.intent.operationId||JSON.stringify(saved.transfers)!==JSON.stringify(context.artifacts.fileTransfers)||JSON.stringify(saved.website)!==JSON.stringify(context.artifacts.website))throw fail('maintenance_restore_file_plan_changed');
  for(const row of saved.transfers){
   await noSymlinkPath(row.path);await noSymlinkPath(row.candidate);await noSymlinkPath(row.previous);
   if(row.existed)await rename(row.path,row.previous);await rename(row.candidate,row.path);
  }
  if(saved.website)await this.website.activate(saved.website);
  // Previous directories/databases remain owned recovery artifacts. This
  // operation never prunes them or invents a retention/physical cleanup rule.
  return{accepted:true,activated:saved.transfers.length};
 }
 validate(context){return this.website.verify(context.artifacts.website);}
}
