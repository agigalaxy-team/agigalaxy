import {lstat,readFile,chmod,chown,unlink} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {atomicWrite,noSymlinkPath,runCommand} from '../operations-stack/host.mjs';
import {serviceConnectionsConfigurationSchema,serviceConnectionSchema,serviceCredentialProvisionSchema,serviceConnectionCredentialTarget,serviceConnectionConsumerMetadataSchema,serviceConnectionConsumerReadbackSchema} from '../../../galaxy-contracts/src/operations-service-connections-schema.mjs';
import {serviceConnectionAdopted,serviceConnectionTargets,serviceConnectionReceiptFiles,serviceConnectionKinds,serviceConnectionMatches} from '../support/service-connections.mjs';
import {testServiceConnection} from './service-connections-probes.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const units=Object.freeze({api:'galaxy-api@pilot.service',worker:'galaxy-worker@pilot.service'});
const identities=Object.freeze({api:{uid:985,gid:978},worker:{uid:984,gid:977}});
const kindFile=kind=>['analysis','recommendation','search'].includes(kind)?'discovery':kind==='ai-execution'?'agentos':'attachments';
const nonsecret=view=>Object.fromEntries(Object.entries(view).filter(([key])=>!['credential','credentials','proof','proofKey','key','apiKey','clientSecret','readClientSecret','signingKey','serviceKey'].includes(key)));
const stableId=value=>{const bytes=createHash('sha256').update(JSON.stringify(value)).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;const h=bytes.toString('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);};
const rawConnection=(kind,value)=>kind==='analysis'?value.openpanel:kind==='recommendation'?value.gorse:kind==='search'?value.meilisearch:kind==='ai-execution'?value:value.scanner;
const rawCredential=(kind,raw)=>kind==='analysis'?{clientSecret:raw.clientSecret,readClientSecret:raw.readClientSecret}:kind==='recommendation'||kind==='search'?{apiKey:raw.apiKey}:kind==='ai-execution'?{signingKey:raw.signingKey,serviceKey:raw.serviceKey}:null;
const publicConnection=(kind,id,raw,credentialRef=null)=>serviceConnectionSchema.parse(kind==='analysis'?{id,kind,url:raw.url,projectId:raw.projectId,clientId:raw.clientId,readClientId:raw.readClientId,credentialRef}:
 kind==='search'?{id,kind,url:raw.url,index:raw.index??'galaxy_public_community',credentialRef}:kind==='file-scanning'?{id,kind,host:raw.host,port:raw.port,timeoutMs:raw.timeoutMs}:{id,kind,url:raw.url,credentialRef});

async function privateFile(file,{metadata=false}={}){
 if(!isAbsolute(file??''))throw fail('system_settings_private_configuration_invalid');
 await noSymlinkPath(file);const info=await lstat(file);
 if(!info.isFile()||info.isSymbolicLink()||info.size>65536||process.platform!=='win32'&&((info.mode&(metadata?0o022:0o027))||metadata&&info.uid!==0))throw fail('system_settings_private_configuration_invalid');
 const body=await readFile(file,'utf8');let value;try{value=JSON.parse(body);}catch{throw fail('system_settings_private_configuration_invalid');}
 return{info,body,value};
}
async function writePrivate(file,body,info=null,{metadata=false}={}){
 await noSymlinkPath(file);
 const mode=info?info.mode&0o777:metadata?0o644:0o600;
 await atomicWrite(file,body,mode);
 if(process.platform!=='win32'){await chown(file,info?.uid??0,info?.gid??0);await chmod(file,mode);}
}
async function removeMetadata(file){await noSymlinkPath(file);await unlink(file);}

export async function readServiceConnectionReceipt(component,{stat=lstat,read=readFile,checkPath=noSymlinkPath,platform=process.platform}={}){
 const file=serviceConnectionReceiptFiles[component],owner=identities[component];if(!file||!owner)throw fail('system_settings_adoption_unconfirmed');
 await checkPath(file);const info=await stat(file);
 if(!info.isFile()||info.isSymbolicLink()||info.size>65536||platform!=='win32'&&(info.uid!==owner.uid||(info.mode&0o777)!==0o600))throw fail('system_settings_adoption_unconfirmed');
 try{return serviceConnectionConsumerReadbackSchema.parse(JSON.parse(await read(file,'utf8')));}catch{throw fail('system_settings_adoption_unconfirmed');}
}

/** A thin adapter for the one system-settings journal. No operation ledger,
 * credential store, daemon or public filesystem/command endpoint is created.
 * control is startup-owned protected configuration, never a browser DTO. */
export class ServiceConnectionsAdapter{
 constructor({control,resolveCredential,retainCredential=null,run=runCommand,fetchImpl=fetch,scannerFactory,now=()=>Math.floor(Date.now()/1000),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),fileReader=privateFile,fileWriter=writePrivate,metadataRemover=removeMetadata,receiptReader=readServiceConnectionReceipt,monotonic=()=>performance.now()}){
  Object.assign(this,{control,resolveCredential,retainCredential,run,fetchImpl,scannerFactory,now,pause,fileReader,fileWriter,metadataRemover,receiptReader,monotonic});
 }
 legacyRow(kind,source){
  const raw=rawConnection(kind,source.value),id=stableId([this.control.endpoint,'connection',kind]),binding=publicConnection(kind,id,raw),credential=rawCredential(kind,raw);
  if(!credential)return{configuration:binding,row:null};
  const {credentialRef:_credentialRef,...target}=binding,parsed=serviceCredentialProvisionSchema.safeParse({binding:target,credential});
  if(!parsed.success)return{configuration:binding,row:null};
  // A reference denotes this observed source version, never a mutable alias
  // to whichever credential happens to be in that file on a later request.
  const reference='system-key:'+stableId([this.control.endpoint,'legacy',kind,source.file,source.info.dev,source.info.ino,source.info.size,source.info.mtimeMs,source.info.ctimeMs]);
  return{configuration:{...binding,credentialRef:reference},row:{version:1,reference,section:'service-connections',connectionId:id,binding:parsed.data.binding,credential:parsed.data.credential}};
 }
 async observed(){
  const connections=[],rows=[];
  for(const kind of serviceConnectionKinds)try{const source=await this.sourceSnapshot({kind},'api'),legacy=this.legacyRow(kind,source);connections.push(legacy.configuration);if(legacy.row)rows.push(legacy.row);}catch{/* Missing native configuration stays absent, without sample defaults. */}
  return{configuration:serviceConnectionsConfigurationSchema.parse({connections}),rows};
 }
 async legacyCredential(reference){const observed=await this.observed();return observed.rows.find(row=>row.reference===reference)??null;}
 configurations(configuration){return serviceConnectionsConfigurationSchema.parse(configuration).connections;}
 source(kind,component){const file=this.control?.files?.[kindFile(kind)]?.[component];if(!isAbsolute(file??''))throw fail('system_settings_control_not_configured');return file;}
 async credential(configuration){
  if(configuration.kind==='file-scanning')return null;
  if(!configuration.credentialRef||typeof this.resolveCredential!=='function')throw fail('system_settings_credential_unavailable');
  const result=await this.resolveCredential(configuration.credentialRef),parsed=serviceCredentialProvisionSchema.safeParse(result);
  if(!parsed.success||!isDeepStrictEqual(serviceConnectionCredentialTarget(parsed.data.binding),serviceConnectionCredentialTarget(configuration)))throw fail('system_settings_credential_binding_mismatch');
  return parsed.data.credential;
 }
 async sourceSnapshot(configuration,component){
  const file=this.source(configuration.kind,component),source=await this.fileReader(file);
  if(configuration.kind!=='file-scanning'&&source.value.endpoint!==this.control.endpoint)throw fail('system_settings_private_configuration_invalid');
  if(configuration.kind==='file-scanning'&&(!source.value.store||!source.value.scanner||!source.value.policy))throw fail('system_settings_private_configuration_invalid');
  return{file,...source};
 }
 patch(value,configuration,credential){
  const next=structuredClone(value),{id:_id,kind,credentialRef:_credentialRef,...fields}=configuration;
  if(kind==='analysis')next.openpanel={...next.openpanel,...fields,...credential};
  else if(kind==='recommendation')next.gorse={...next.gorse,...fields,...credential};
  else if(kind==='search')next.meilisearch={...next.meilisearch,...fields,...credential};
  else if(kind==='ai-execution')Object.assign(next,fields,credential);
  else next.scanner={...next.scanner,...fields};
  return next;
 }
 async test({configuration,connectionId}={}){
  const connections=this.configurations(configuration).filter(item=>!connectionId||item.id===connectionId);
  if(connectionId&&!connections.length)throw fail('system_settings_target_unavailable');
  if(!connections.length)throw fail('system_settings_configuration_incomplete');
  const items=[];
  for(const connection of connections){
   let credential,scannerPolicy=null;
   try{credential=await this.credential(connection);if(connection.kind==='file-scanning'){const current=await this.sourceSnapshot(connection,'worker');scannerPolicy={maxBytes:current.value.policy.maxFileBytes,maxSignatureAgeSeconds:current.value.scanner.maxSignatureAgeSeconds};}}
   catch{items.push({id:connection.id,kind:connection.kind,state:'unavailable',checkedAt:this.now(),checks:[],code:connection.kind==='file-scanning'?'service_connection_test_failed':'service_connection_credentials_unavailable'});continue;}
   items.push(await testServiceConnection(connection,{credential,fetchImpl:this.fetchImpl,scannerFactory:this.scannerFactory,scannerPolicy,now:this.now}));
  }
  return{state:items.every(item=>item.state==='available')?'completed':'failed',items};
 }
 async process(component){
  const result=await this.run('/usr/bin/systemctl',['show',units[component],'--no-pager','--property=MainPID,ActiveState'],{timeout:10000,maxOutput:4096});
  const values=Object.fromEntries(result.stdout.trim().split('\n').map(line=>line.split('=')));
  const pid=Number(values.MainPID);if(values.ActiveState!=='active'||!Number.isSafeInteger(pid)||pid<1)throw fail('system_settings_consumer_not_configured');return pid;
 }
 async observation(component){
  return this.receiptReader(component);
 }
 async describe({configuration=null}={}){
  const observed=await this.observed(),metadata=await this.metadata();if(!metadata)return{state:observed.configuration.connections.length?'available':'not-configured',appliedVersionId:null,observedConfiguration:observed.configuration,items:observed.configuration.connections.map(connection=>({...connection,credentialConfigured:connection.kind==='file-scanning'?null:!!connection.credentialRef,appliedVersionId:null,state:'unknown'}))};
  const selected=configuration??{connections:metadata.connections};
  const current=await this.readback({versionId:metadata.versionId,configuration:selected});
  const byKind=new Map(observed.configuration.connections.map(connection=>[connection.kind,connection]));
  if(current.state==='completed')for(const connection of metadata.connections)byKind.set(connection.kind,connection);
  return{state:current.state==='completed'?'available':'unavailable',appliedVersionId:current.state==='completed'?metadata.versionId:null,observedConfiguration:{connections:[...byKind.values()]},items:current.items,phases:current.phases};
 }
 async metadata(){
  try{const file=this.control?.consumerMetadataFile;if(!isAbsolute(file??''))throw fail('system_settings_control_not_configured');const current=await this.fileReader(file,{metadata:true});return serviceConnectionConsumerMetadataSchema.parse(current.value);}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
 }
 async readback({versionId,configuration,previousPids=null}={}){
  const connections=this.configurations(configuration),components=[...new Set(connections.flatMap(serviceConnectionTargets))],phases=[],observations=new Map();
  for(const component of components){
   try{const pid=await this.process(component);if(previousPids&&pid===previousPids[component])throw fail('system_settings_adoption_unconfirmed');
    const observation=await this.observation(component);observations.set(component,{pid,observation});
    let adopted=true;
    for(const item of connections.filter(item=>serviceConnectionTargets(item).includes(component))){
     const source=await this.sourceSnapshot(item,component),raw=rawConnection(item.kind,source.value),actual=publicConnection(item.kind,item.id,raw,item.credentialRef??null);
     if(!serviceConnectionMatches(actual,item)||item.kind!=='file-scanning'&&!isDeepStrictEqual(rawCredential(item.kind,raw),await this.credential(item))||!serviceConnectionAdopted({configuration:item,versionId,component,pid,observation}))adopted=false;
    }
    phases.push({target:component,state:adopted?'completed':'unknown',adoptedVersionId:adopted?versionId:null,code:adopted?null:'system_settings_adoption_unconfirmed'});
   }catch{phases.push({target:component,state:'unknown',adoptedVersionId:null,code:'system_settings_adoption_unconfirmed'});}
  }
  const items=connections.map(connection=>{const targets=serviceConnectionTargets(connection),adopted=targets.length>0&&targets.every(component=>{const current=observations.get(component);return current&&serviceConnectionAdopted({...current,configuration:connection,versionId,component});});
   const completed=adopted&&targets.every(target=>phases.find(phase=>phase.target===target)?.state==='completed');
   return{...nonsecret(connection),credentialConfigured:connection.kind==='file-scanning'?null:completed?true:null,state:completed?'available':'unknown',appliedVersionId:completed?versionId:null};});
  return{state:phases.length&&phases.every(phase=>phase.state==='completed')?'completed':'unknown',adoptedVersionId:phases.length&&phases.every(phase=>phase.state==='completed')?versionId:null,phases,items};
 }
 async apply({versionId,configuration}={}, {authorize}={}){
  const connections=this.configurations(configuration);if(!connections.length)throw fail('system_settings_configuration_incomplete');
  if(typeof authorize!=='function')throw fail('system_settings_authorization_unavailable');
  await authorize();
  if(!isAbsolute(this.control?.consumerMetadataFile??'')||typeof this.control?.endpoint!=='string')throw fail('system_settings_control_not_configured');
  const targets=['worker','api'].filter(component=>connections.some(connection=>serviceConnectionTargets(connection).includes(component))),previousPids={};for(const component of targets)previousPids[component]=await this.process(component);
  const files=new Map();
  for(const connection of connections){const credential=await this.credential(connection);
   for(const component of serviceConnectionTargets(connection)){const current=await this.sourceSnapshot(connection,component),pending=files.get(current.file)??{...current,next:current.value};pending.next=this.patch(pending.next,connection,credential);files.set(current.file,pending);}
  }
  const metadata=serviceConnectionConsumerMetadataSchema.parse({version:1,versionId,connections}),metadataFile=this.control.consumerMetadataFile;
  let oldMetadata=null;try{oldMetadata=await this.fileReader(metadataFile,{metadata:true});}catch(error){if(error.code!=='ENOENT')throw error;}
  // Retain only actual existing legacy bundles in the same credential store
  // before any current protected source is replaced. Never create on GET.
  const legacy=await this.observed(),retained=legacy.rows.filter(row=>connections.some(connection=>kindFile(connection.kind)===kindFile(row.binding.kind)));
  if(retained.length&&typeof this.retainCredential!=='function')throw fail('system_settings_credential_unavailable');
  await authorize();for(const row of retained)await this.retainCredential(row);
  const written=[];let metadataAttempted=false;
  await authorize();
  try{
   for(const pending of files.values()){await this.fileWriter(pending.file,JSON.stringify(pending.next)+'\n',pending.info);written.push(pending);}
   metadataAttempted=true;await this.fileWriter(metadataFile,JSON.stringify(metadata)+'\n',oldMetadata?.info??null,{metadata:true});
  }catch{
   let rollbackFailed=false;
   for(const previous of written.reverse())try{await this.fileWriter(previous.file,previous.body,previous.info);}catch{rollbackFailed=true;}
   if(metadataAttempted)try{if(oldMetadata)await this.fileWriter(metadataFile,oldMetadata.body,oldMetadata.info,{metadata:true});else await this.metadataRemover(metadataFile);}catch(error){if(error.code!=='ENOENT')rollbackFailed=true;}
   throw fail(rollbackFailed?'system_settings_apply_unknown':'system_settings_apply_failed');
  }
  // All file paths and units are fixed by startup control. No shell, arbitrary
  // service name or configuration path is accepted from a settings request.
  for(const component of targets){
   try{await authorize();}catch{return this.readback({versionId,configuration,previousPids});}
   try{await this.run('/usr/bin/systemctl',['restart',units[component]],{timeout:60000,maxOutput:4096});}catch{/* The original operation now reads actual adoption, never blindly restarts again. */}
  }
  const deadline=this.monotonic()+30000;
  for(let attempt=0;attempt<30;attempt++){const value=await this.readback({versionId,configuration,previousPids});if(value.state==='completed')return value;if(attempt>=29||this.monotonic()>=deadline)return value;await this.pause(1000);}
  return this.readback({versionId,configuration,previousPids});
 }
}
