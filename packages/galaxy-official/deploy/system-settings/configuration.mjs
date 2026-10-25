import {lstat,readFile,mkdir,open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {noSymlinkPath} from '../operations-stack/host.mjs';
import {SystemSettingsCredentialStore} from './credentials.mjs';
import {SystemSettingsRuntime,SystemSettingsControlClient} from './runtime.mjs';
import {UnifiedMailAdapter} from './mail-runtime.mjs';
import {SystemSettingsKeycloakMail} from './mail-native.mjs';
import {ServiceConnectionsAdapter} from './service-connections-runtime.mjs';
import {serviceConnectionTargets} from '../../src/operations/system-settings/service-connections.mjs';

const absolute=z.string().refine(isAbsolute),permanent=absolute.refine(value=>value.startsWith('/etc/galaxy/')||value.startsWith('/var/lib/galaxy/config/'));
const pair=z.strictObject({api:permanent,worker:permanent});
const schema=z.strictObject({
 version:z.literal(1),endpoint:z.url(),apiOrigin:z.string().regex(/^http:\/\/127[.]0[.]0[.]1:[0-9]{1,5}$/),
 journalDirectory:absolute,credentialDirectory:permanent,
 mail:z.strictObject({operationsCredentialFiles:pair,mailConsumerMetadataFile:permanent,appliedMetadataFile:permanent,
  alertmanagerConfigFile:permanent,amtool:z.literal('/opt/galaxy/runtime/alertmanager-0.34.1.linux-amd64/amtool'),
  checkpointDirectory:absolute,keycloakBootstrapFile:permanent}),
 services:z.strictObject({files:z.strictObject({discovery:pair,agentos:z.strictObject({api:permanent}),attachments:pair}),consumerMetadataFile:permanent}),
});
export async function readSystemSettingsControl(file){
 if(!isAbsolute(file??''))throw Object.assign(Error('system_settings_control_not_configured'),{code:'system_settings_control_not_configured'});
 await noSymlinkPath(file);const info=await lstat(file);
 if(!info.isFile()||info.isSymbolicLink()||info.size>32768||process.platform!=='win32'&&(info.uid!==0||(info.mode&0o077)))throw Object.assign(Error('system_settings_private_configuration_invalid'),{code:'system_settings_private_configuration_invalid'});
 try{const value=schema.parse(JSON.parse(await readFile(file,'utf8'))),origin=new URL(value.endpoint);
  if(origin.protocol!=='https:'||origin.origin!==value.endpoint||origin.username||origin.password)throw Error();return value;
 }catch{throw Object.assign(Error('system_settings_private_configuration_invalid'),{code:'system_settings_private_configuration_invalid'});}
}

/** Preserve only startup-whitelisted permanent sources before any service
 * source is replaced. The checkpoint is root-private and never public data. */
export async function checkpointServiceSources({directory,operationId,versionId,files}){
 const fail=()=>Object.assign(Error('system_settings_private_configuration_invalid'),{code:'system_settings_private_configuration_invalid'});
 const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
 if(!isAbsolute(directory??'')||!uuid.test(operationId??'')||!uuid.test(versionId??'')||!Array.isArray(files)||!files.length)throw fail();
 const selected=[...new Map(files.map(row=>[row.file,row])).values()].sort((a,b)=>a.file.localeCompare(b.file));
 if(selected.length>6||selected.some(row=>!isAbsolute(row.file??'')))throw fail();
 await noSymlinkPath(directory);await mkdir(directory,{recursive:true,mode:0o700});
 const folder=directory+'/'+operationId;await noSymlinkPath(folder);await mkdir(folder,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
 for(const path of [directory,folder]){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||process.platform!=='win32'&&(info.uid!==0||(info.mode&0o077)))throw fail();}
 const target=folder+'/service-sources.json';await noSymlinkPath(target);
 try{
  const info=await lstat(target);if(!info.isFile()||info.isSymbolicLink()||info.size>600000||process.platform!=='win32'&&(info.uid!==0||(info.mode&0o777)!==0o600))throw fail();
  const previous=JSON.parse(await readFile(target,'utf8'));
  if(previous.version!==1||previous.operationId!==operationId||previous.versionId!==versionId||JSON.stringify(previous.files?.map(row=>row.file))!==JSON.stringify(selected.map(row=>row.file)))throw fail();
  return target;
 }catch(error){if(error.code!=='ENOENT')throw fail();}
 const snapshots=[];
 for(const row of selected){
  try{await noSymlinkPath(row.file);const info=await lstat(row.file);if(!info.isFile()||info.isSymbolicLink()||info.size>65536||process.platform!=='win32'&&(info.uid!==0||(info.mode&0o022)))throw fail();
   const bytes=await readFile(row.file);if(bytes.length>65536)throw fail();
   snapshots.push({file:row.file,exists:true,uid:info.uid,gid:info.gid,mode:info.mode&0o777,bodyBase64:bytes.toString('base64')});
  }catch(error){if(error.code==='ENOENT'&&row.optional===true)snapshots.push({file:row.file,exists:false});else throw fail();}
 }
 const file=await open(target,'wx',0o600);
 try{await file.writeFile(JSON.stringify({version:1,operationId,versionId,files:snapshots})+'\n');await file.sync();}finally{await file.close();}
 if(process.platform!=='win32'){const dir=await open(folder,'r');try{await dir.sync();}finally{await dir.close();}}
 return target;
}

/** Optional construction by the existing maintenance service. No new daemon,
 * listening port, worker credential, arbitrary command or configuration key. */
export async function createSystemSettingsRuntime({configuration,control,dependencies={}}){
 const parsed=schema.parse(control);let mail,services;
 const bridge=dependencies.bridge??new SystemSettingsControlClient({origin:parsed.apiOrigin,host:new URL(parsed.endpoint).hostname,serviceKey:configuration.serviceKey,fetchImpl:dependencies.fetchImpl});
 const store=dependencies.credentialStore??new SystemSettingsCredentialStore({root:parsed.credentialDirectory,
  legacy:async reference=>await mail?.legacyCredential(reference)??await services?.legacyCredential(reference)??null});
 const retainCredential=row=>store.provision({operationId:row.reference.slice(11),expectedRevision:0,section:row.section,connectionId:row.connectionId,binding:row.binding,credential:row.credential});
 const keycloak=dependencies.keycloak??new SystemSettingsKeycloakMail({bootstrapFile:parsed.mail.keycloakBootstrapFile,fetchImpl:dependencies.fetchImpl,run:dependencies.run});
 mail=new UnifiedMailAdapter({control:{...parsed.mail,endpoint:parsed.endpoint},bridge,keycloak,
  resolveCredential:reference=>store.bundle(reference,{section:'mail'}),retainCredential,referenceKey:configuration.serviceKey,
  ...dependencies.mail});
 services=new ServiceConnectionsAdapter({control:{...parsed.services,endpoint:parsed.endpoint},resolveCredential:reference=>store.bundle(reference,{section:'service-connections'}),retainCredential,...dependencies.services});
 const serviceApply=services.apply.bind(services);
 services.apply=async(args,options)=>{
  await options.authorize();const files=[];
  for(const connection of services.configurations(args.configuration))for(const component of serviceConnectionTargets(connection))files.push({file:services.source(connection.kind,component)});
  files.push({file:services.control.consumerMetadataFile,optional:true});
  await checkpointServiceSources({directory:parsed.mail.checkpointDirectory,operationId:options.intent.operationId,versionId:args.versionId,files});
  return serviceApply(args,options);
 };
 const runtime=new SystemSettingsRuntime({directory:parsed.journalDirectory,credentialStore:store,adapters:{mail,'service-connections':services},control:bridge,serviceKey:configuration.serviceKey,...dependencies.runtime});
 await runtime.initialize();await store.initialize();return runtime;
}
