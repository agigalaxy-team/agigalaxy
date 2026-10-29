import {createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {noSymlinkPath,runCommand} from '../operations-stack/host.mjs';

const fail=code=>Object.assign(Error(code),{code});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
// The binary must be a verified member of the actual selected API release.
export async function recoveryExecutable(context){
 const rows=context.footprint?.services?.filter(row=>row.id==='api')??[];
 const directory=rows.length===1&&rows[0].state==='available'&&rows[0].releasePaths?.length===1?rows[0].releasePaths[0]:null;
 if(!/^\/opt\/galaxy\/releases\/[A-Za-z0-9._-]+$/.test(directory??''))throw fail('maintenance_api_binding_invalid');
 await noSymlinkPath(directory);
 const manifestPath=directory+'/go-core-artifact.json',manifestInfo=await lstat(manifestPath);
 if(!manifestInfo.isFile()||manifestInfo.isSymbolicLink()||manifestInfo.size>1048576)throw fail('maintenance_api_binding_invalid');
 const bytes=await readFile(manifestPath),value=JSON.parse(bytes.toString('utf8')),entry=value.files?.['galaxy-lifecycle'];
 if(value.version!==1||!['galaxy-go-core-release','galaxy-go-core-local-candidate'].includes(value.kind)
  ||value.component!=='hub'||value.backend!=='go'||value.target?.goos!=='linux'
  ||!['amd64','arm64'].includes(value.target?.goarch)||value.target?.cgo!==false
  ||value.entries?.['galaxy-lifecycle']!=='galaxy-lifecycle'||!entry||!/^[a-f0-9]{64}$/.test(entry.sha256??'')
  ||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value.configurationVersion??''))throw fail('maintenance_api_binding_invalid');
 const binary=directory+'/galaxy-lifecycle';await noSymlinkPath(binary);const info=await lstat(binary);
 if(!info.isFile()||info.isSymbolicLink()||info.size!==entry.bytes||digest(await readFile(binary))!==entry.sha256)throw fail('maintenance_api_binding_invalid');
 return{binary,env:{GALAXY_RELEASE_DIRECTORY:directory,GALAXY_RELEASE_SHA256:digest(bytes),GALAXY_CONFIGURATION_VERSION:value.configurationVersion}};
}
export async function recoveryCall(executable,input,run=runCommand){
 const output=await run(executable.binary,['recovery-bridge'],{env:executable.env,input:JSON.stringify(input)+'\n',timeout:120000,maxOutput:24*1024*1024});
 try{return JSON.parse(output.stdout).result;}catch{throw fail('maintenance_recovery_bridge_invalid');}
}
export function recoverySource(executable,input){
 const child=spawn(executable.binary,['recovery-bridge'],{env:executable.env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:child.stdout,crlfDelay:Infinity});let tail=Promise.resolve(),closed=false,failed=null,pending=null;
 child.stderr.resume();
 const abort=()=>{failed=fail('maintenance_recovery_bridge_unavailable');if(pending){pending.reject(failed);pending=null;}};
 child.on('error',abort);child.on('exit',abort);child.stdin.on('error',abort);
 lines.on('line',line=>{if(!pending||line.length>4*1024*1024){abort();child.kill();return;}const active=pending;pending=null;
  try{active.resolve(JSON.parse(line).result);}catch{active.reject(fail('maintenance_recovery_bridge_invalid'));}});
 return{
  load(reference){const job=tail.then(()=>new Promise((resolve,reject)=>{
   if(closed||failed)return reject(failed??fail('maintenance_recovery_bridge_unavailable'));
   const timer=setTimeout(()=>{abort();child.kill();},120000);
   pending={resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}};
   child.stdin.write(JSON.stringify({...input,mode:'source',reference})+'\n',error=>{if(error){abort();child.kill();}});
  }));tail=job.catch(()=>{});return job;},
  async close(){closed=true;await tail;child.stdin.end();lines.close();if(child.exitCode===null)child.kill();}
 };
}
export function cloneConnection(context,config){
 const clone=context.artifacts?.databases?.find(row=>row.stanza==='business'),pg=config.postgres.find(row=>row.id==='business');
 const expected=context.artifacts?.directory+'/sockets/business';
 if(context.artifacts?.directory!==config.directories?.restores+'/maintenance-'+context.intent.operationId||!clone?.socketDirectory||clone.socketDirectory!==expected||clone.network!=='none'||!Array.isArray(clone.ports)||clone.ports.length||!pg?.administrator||!pg?.database)
  throw fail('maintenance_private_recovery_socket_required');
 return{socketDirectory:clone.socketDirectory,database:pg.database,user:pg.administrator,endpoint:context.authority.endpoint,recoveryId:context.intent.operationId};
}
export async function forumPolicyReference(){
 const file='/etc/galaxy/pilot/worker.env';await noSymlinkPath(file);const info=await lstat(file);
 if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)||info.size>262144)throw fail('maintenance_runtime_reference_invalid');
 const refs=(await readFile(file,'utf8')).split(/\r?\n/).filter(line=>line.startsWith('GALAXY_FORUM_POLICY_FILE='));
 if(refs.length>1)throw fail('maintenance_runtime_reference_invalid');
 return refs[0]?.slice('GALAXY_FORUM_POLICY_FILE='.length)??'';
}
