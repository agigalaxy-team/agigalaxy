import {lstat,readFile,mkdir,chmod,chown,writeFile,unlink} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createHmac} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {atomicWrite,noSymlinkPath,runCommand} from '../operations-stack/host.mjs';
import {createOperationsSmtpTransport} from '../../src/operations-smtp-transport.mjs';
import {systemSettingsMailConfigurationSchema,systemSettingsMailConnectionSchema,systemSettingsCredentialSchema,parseSystemSettings,safeSystemSettingsError} from '../../src/operations/system-settings/schema.mjs';
import {operationsMailMetadataSchema,operationsMailReceiptSchema,operationsMailReceiptFiles,operationsMailConfiguration} from '../../src/operations/system-settings/mail-consumer.mjs';
import {operationsSmtpCredentialAlias} from '../../src/operations/system-settings/smtp-credentials.mjs';

const failure=code=>Object.assign(Error(code),{code});
const realms=['galaxy','galaxy-operations'];
const units=Object.freeze({worker:'galaxy-worker@pilot.service',api:'galaxy-api@pilot.service',alerts:'galaxy-alertmanager.service'});
const owners=Object.freeze({api:985,worker:984});
const phasesFor={operations:['operations-worker','operations-api'],'account-authentication':['website-authentication','management-authentication'],'runtime-alerts':['runtime-alerts']};
const phase=(target,state,versionId=null,code=null)=>({target,state,adoptedVersionId:state==='completed'?versionId:null,code});
const stateOf=phases=>phases.length&&phases.every(x=>x.state==='completed')?'completed':phases.some(x=>x.state==='unknown')?'unknown':phases.some(x=>x.state==='completed')?'partial':'failed';
const integer=value=>Number.isInteger(Number(value))&&Number(value)>0?Number(value):null;
const privatePath=path=>isAbsolute(path??'')&&path.startsWith('/etc/galaxy/');
const smtpBinding=connection=>({id:connection.id,host:connection.host,port:connection.port,tls:connection.tls});
const completeTransport=connection=>connection.host&&connection.port&&['implicit','starttls'].includes(connection.tls);
const refPattern=/^system-key:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

async function privateJson(file,{metadata=false}={}){
 await noSymlinkPath(file);const info=await lstat(file);
 if(!info.isFile()||info.isSymbolicLink()||info.size>1048576||process.platform!=='win32'&&(info.uid!==0||(info.mode&(metadata?0o022:0o027))))throw failure('system_settings_private_configuration_invalid');
 let body,value;try{body=await readFile(file,'utf8');value=JSON.parse(body);}catch{throw failure('system_settings_private_configuration_invalid');}return{file,info,body,value};
}
async function writePrivate(file,value,previous=null,{metadata=false}={}){
 await noSymlinkPath(file);const mode=previous?.info?.mode&0o777|| (metadata?0o644:0o600);
 await atomicWrite(file,typeof value==='string'?value:JSON.stringify(value)+'\n',mode);
 if(process.platform!=='win32'){await chown(file,previous?.info?.uid??0,previous?.info?.gid??0);await chmod(file,mode);}
}

/** Reuses the three existing mail consumers. Null bindings preserve a purpose;
 * an explicit connection applies only its transport, never identities/routes. */
export class UnifiedMailAdapter{
 constructor({control,bridge,keycloak,resolveCredential,retainCredential=null,referenceKey,run=runCommand,transport=createOperationsSmtpTransport(),fetchImpl=fetch,
  fileReader=privateJson,fileWriter=writePrivate,receiptReader=null,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=()=>Math.floor(Date.now()/1000)}){
  if(typeof referenceKey!=='string'||referenceKey.length<32)throw failure('system_settings_control_not_configured');
  Object.assign(this,{control,bridge,keycloak,resolveCredential,retainCredential,referenceKey,run,transport,fetchImpl,fileReader,fileWriter,receiptReader,pause,now});
  this.capabilities={canTest:true,canApply:!!bridge&&!!keycloak};
 }
 stable(value){const h=createHmac('sha256',this.referenceKey).update(JSON.stringify(value)).digest('hex').slice(0,32).split('');h[12]='5';h[16]='a';const s=h.join('');return[s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join('-');}
 connection(target,values,credential,source){
  const id=this.stable([this.control.endpoint,'mail',target]),configuration=systemSettingsMailConnectionSchema.parse({id,name:target,...values,credentialRef:null});
  if(!credential)return{configuration,row:null};
  const reference='system-key:'+this.stable([this.control.endpoint,'mail-legacy',target,source]);
  const binding=smtpBinding(configuration),intent={operationId:reference.slice(11),expectedRevision:0,section:'mail',connectionId:id,binding,credential};
  if(!systemSettingsCredentialSchema.safeParse(intent).success)return{configuration,row:null};
  return{configuration:{...configuration,credentialRef:reference},row:{version:1,reference,section:'mail',connectionId:id,binding,credential}};
 }
 nullable(values={}){return{host:null,port:null,tls:null,connectionTimeoutMs:null,greetingTimeoutMs:null,socketTimeoutMs:null,maxConnections:null,rateLimit:null,rateWindowSeconds:null,dkimSelector:null,...values};}
 async operationalSource(){
  const current=await this.bridge.request('mail',{kind:'operations-overview'}),configuration=current.configuration;
  if(!configuration||!configuration.host)return null;
  const source=await this.fileReader(this.control.operationsCredentialFiles.api);
  if(source.value.version!==1||source.value.endpoint!==this.control.endpoint||!Array.isArray(source.value.credentials))throw failure('system_settings_private_configuration_invalid');
  const item=source.value.credentials.find(row=>row.ref===configuration.credentialRef&&row.host===configuration.host&&row.port===configuration.port&&row.tls===configuration.tls);
  const {enabled:_enabled,credentialRef:_credentialRef,...values}=configuration;
  return this.connection('operations',values,item?{user:item.user,password:item.password}:null,[current.version,source.body]);
 }
 async nativeSource(realm){
  const smtp=await this.keycloak.read(realm);if(!smtp.host)return null;
  const tls=smtp.ssl==='true'?'implicit':smtp.starttls==='true'?'starttls':null;
  return this.connection(realm==='galaxy'?'website-authentication':'management-authentication',this.nullable({host:smtp.host,port:integer(smtp.port),tls,
   connectionTimeoutMs:integer(smtp.connectionTimeout),socketTimeoutMs:integer(smtp.timeout)}),smtp.auth==='true'&&smtp.user&&smtp.password?{user:smtp.user,password:smtp.password}:null,smtp);
 }
 async alertSource(){
  const source=await this.fileReader(this.control.alertmanagerConfigFile),mail=this.alertEmails(source.value)[0];if(!mail)return null;
  const match=/^([a-zA-Z0-9.-]+):([0-9]+)$/.exec(mail.smarthost??'');if(!match)return null;
  return this.connection('runtime-alerts',this.nullable({host:match[1],port:integer(match[2]),tls:mail.force_implicit_tls===true?'implicit':mail.require_tls===true?'starttls':null}),
   mail.auth_username&&mail.auth_password?{user:mail.auth_username,password:mail.auth_password}:null,[source.info.dev,source.info.ino,source.info.size,source.info.mtimeMs,source.info.ctimeMs]);
 }
 async observed(){
  const connections=[],rows=[],bindings={operations:null,'account-authentication':null,'runtime-alerts':null},items=[];
  const add=(purpose,target,result,source)=>{
   if(result){connections.push(result.configuration);if(result.row)rows.push(result.row);items.push({target,id:result.configuration.id,state:'unknown',credentialConfigured:!!result.row,source});}
   else items.push({target,id:null,state:'not-configured',credentialConfigured:false,source});
   if(result&&purpose!=='account-authentication')bindings[purpose]=result.configuration.id;
  };
  for(const [purpose,target,load,source]of [
   ['operations','operations',()=>this.operationalSource(),'operations-database'],
   ['account-authentication','website-authentication',()=>this.nativeSource('galaxy'),'native-keycloak'],
   ['account-authentication','management-authentication',()=>this.nativeSource('galaxy-operations'),'native-keycloak'],
   ['runtime-alerts','runtime-alerts',()=>this.alertSource(),'native-alertmanager'],
  ])try{add(purpose,target,await load(),source);}catch{items.push({target,id:null,state:'unavailable',credentialConfigured:null,source});}
  // Two realms may currently have different transports. Show both actual
  // sources and require an explicit common selection instead of choosing one.
  return{configuration:systemSettingsMailConfigurationSchema.parse({connections,bindings}),rows,items};
 }
 async legacyCredential(reference){return(await this.observed()).rows.find(row=>row.reference===reference)??null;}
 async credential(connection){
  if(!completeTransport(connection)||!refPattern.test(connection.credentialRef??''))throw failure('system_settings_configuration_incomplete');
  const value=await this.resolveCredential(connection.credentialRef),binding=smtpBinding(connection);
  if(!value||!isDeepStrictEqual(value.binding,binding))throw failure('system_settings_credential_binding_mismatch');
  return value.credential;
 }
 configuration(input){return parseSystemSettings(systemSettingsMailConfigurationSchema,input);}
 selected(configuration,purpose){const id=configuration.bindings[purpose];return id?configuration.connections.find(row=>row.id===id):null;}
 async checkpoint(operationId,target,value){
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId)||!['galaxy','galaxy-operations','alerts','operations'].includes(target)||!isAbsolute(this.control.checkpointDirectory??''))throw failure('system_settings_control_not_configured');
  const directory=this.control.checkpointDirectory+'/'+operationId;await noSymlinkPath(directory);await mkdir(directory,{recursive:true,mode:0o700});
  const info=await lstat(directory);if(!info.isDirectory()||process.platform!=='win32'&&(info.uid!==0||(info.mode&0o077)))throw failure('system_settings_private_configuration_invalid');
  try{await writeFile(directory+'/'+target+'.json',JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
 }
 async retain(){const rows=(await this.observed()).rows;if(rows.length&&!this.retainCredential)throw failure('system_settings_credential_unavailable');for(const row of rows)await this.retainCredential(row);}
 async describe(){
  const observed=await this.observed();let current=null;
  try{const metadata=await this.fileReader(this.control.appliedMetadataFile,{metadata:true});if(metadata.value.version===1&&metadata.value.versionId&&metadata.value.configuration)current=await this.readback(metadata.value);}catch{/* No earlier application is invented. */}
  const byTarget=new Map(observed.items.map(row=>[row.target,row]));for(const row of current?.items??[])byTarget.set(row.target,row);
  if(current?.items.some(row=>row.target.startsWith('operations-')))byTarget.delete('operations');
  return{state:observed.items.some(row=>row.state!=='unavailable'&&row.state!=='not-configured')?'available':observed.items.some(row=>row.state==='unavailable')?'unavailable':'not-configured',
   observedConfiguration:current?.state==='completed'?current.configuration:observed.configuration,items:[...byTarget.values()]};
 }
 async test({configuration,connectionId}, {authorize}={}){
  const value=this.configuration(configuration),connections=value.connections.filter(row=>!connectionId||row.id===connectionId),phases=[];
  if(!connections.length)throw failure('system_settings_configuration_incomplete');
  for(const connection of connections)try{await authorize();const credentials=await this.credential(connection),result=await this.transport.verify(connection,{credentials:{user:credentials.user,pass:credentials.password},authorize});
   phases.push(phase(connection.id,result.submission==='connected'?'completed':'failed',null,result.submission==='connected'?null:'system_settings_connection_failed'));
  }catch(error){phases.push(phase(connection.id,'failed',null,safeSystemSettingsError(error,'system_settings_connection_failed')));}
  return{state:stateOf(phases),phases};
 }
 patchNative(old,connection,credential){
  if(old.from!=='account@agigalaxy.org'||old.replyTo!=='team@agigalaxy.org')throw failure('system_settings_source_changed');
  const next={...old,host:connection.host,port:String(connection.port),ssl:String(connection.tls==='implicit'),starttls:String(connection.tls==='starttls'),auth:'true',authType:'basic',user:credential.user,password:credential.password};
  if(connection.connectionTimeoutMs!==null)next.connectionTimeout=String(connection.connectionTimeoutMs);
  if(connection.socketTimeoutMs!==null)next.timeout=String(connection.socketTimeoutMs);
  return next;
 }
 async applyAuthentication(connection,versionId,{authorize,intent}){
  const credential=await this.credential(connection),phases=[];
  for(const realm of realms){const target=realm==='galaxy'?'website-authentication':'management-authentication';
   try{await authorize();const old=await this.keycloak.read(realm),next=this.patchNative(old,connection,credential);await this.checkpoint(intent.operationId,realm,old);
    await authorize();await this.keycloak.apply(realm,next);const current=await this.keycloak.read(realm);
    phases.push(phase(target,isDeepStrictEqual(current,next)?'completed':'unknown',versionId,isDeepStrictEqual(current,next)?null:'system_settings_adoption_unconfirmed'));
   }catch(error){phases.push(phase(target,'unknown',null,safeSystemSettingsError(error,'system_settings_apply_unknown')));}
  }return phases;
 }
 alertEmails(value){const receivers=value?.receivers?.filter(row=>row.name==='management');if(receivers?.length!==1||!Array.isArray(receivers[0].email_configs)||!receivers[0].email_configs.length)throw failure('system_settings_configuration_incomplete');return receivers[0].email_configs;}
 patchAlerts(old,connection,credential){
  const next=structuredClone(old);for(const mail of this.alertEmails(next)){
   if(!/(?:^|<)notice@agigalaxy[.]org>?$/.test(mail.from??'')||!(mail.headers?.['Reply-To']??'').includes('team@agigalaxy.org'))throw failure('system_settings_source_changed');
   Object.assign(mail,{smarthost:connection.host+':'+connection.port,require_tls:true,force_implicit_tls:connection.tls==='implicit',auth_username:credential.user,auth_password:credential.password});
  }return next;
 }
 async process(component){
  const result=await this.run('/usr/bin/systemctl',['show',units[component],'--no-pager','--property=MainPID,ActiveState'],{timeout:10000,maxOutput:4096});
  const row=Object.fromEntries(result.stdout.trim().split('\n').map(value=>value.split('='))),pid=Number(row.MainPID);
  if(row.ActiveState!=='active'||!Number.isSafeInteger(pid)||pid<1)throw failure('system_settings_consumer_not_configured');return pid;
 }
 async applyAlerts(connection,versionId,{authorize,intent}){
  if(!privatePath(this.control.alertmanagerConfigFile)||this.control.amtool!=='/opt/galaxy/runtime/alertmanager-0.34.1.linux-amd64/amtool')throw failure('system_settings_control_not_configured');
  const source=await this.fileReader(this.control.alertmanagerConfigFile),credential=await this.credential(connection),next=this.patchAlerts(source.value,connection,credential),pid=await this.process('alerts');
  await this.checkpoint(intent.operationId,'alerts',source.value);
  const candidate=this.control.alertmanagerConfigFile+'.system-settings-'+intent.operationId;
  try{
   await this.fileWriter(candidate,next);await this.run(this.control.amtool,['check-config',candidate],{timeout:15000,maxOutput:65536});
   await authorize();await this.fileWriter(source.file,next,source);await authorize();
   try{await this.run('/usr/bin/systemctl',['restart',units.alerts],{timeout:60000,maxOutput:4096});}catch{}
   return this.alertReadback(connection,versionId,pid);
  }finally{await unlink(candidate).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 }
 async alertReadback(connection,versionId,previousPid=null){
  try{
   const pid=await this.process('alerts');if(previousPid===pid)throw Error();
   const current=await this.fileReader(this.control.alertmanagerConfigFile),loaded=await this.fileReader('/run/credentials/'+units.alerts+'/alertmanager.json'),credential=await this.credential(connection);
   if(!isDeepStrictEqual(current.value,loaded.value)||!isDeepStrictEqual(current.value,this.patchAlerts(current.value,connection,credential)))throw Error();
   const response=await this.fetchImpl('http://127.0.0.1:9093/-/ready',{redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error();
   return phase('runtime-alerts','completed',versionId);
  }catch{return phase('runtime-alerts','unknown',null,'system_settings_adoption_unconfirmed');}
 }
 async installOperationalCredential(connection,credential){
  for(const file of new Set(Object.values(this.control.operationsCredentialFiles??{}))){
   if(!privatePath(file))throw failure('system_settings_control_not_configured');
   const source=await this.fileReader(file);if(source.value.version!==1||source.value.endpoint!==this.control.endpoint||!Array.isArray(source.value.credentials))throw failure('system_settings_private_configuration_invalid');
   const alias=operationsSmtpCredentialAlias(connection.credentialRef),entry={ref:alias,label:connection.name,host:connection.host,port:connection.port,tls:connection.tls,
    purposes:['account','notice','community','updates','team'],user:credential.user,password:credential.password},old=source.value.credentials.find(row=>row.ref===alias);
   if(old&&!isDeepStrictEqual(old,entry))throw failure('system_settings_credential_binding_mismatch');
   if(!old){if(source.value.credentials.length>=32)throw failure('system_settings_private_configuration_invalid');await this.fileWriter(file,{...source.value,credentials:[...source.value.credentials,entry]},source);}
  }
 }
 async applyOperations(connection,versionId,{authorize,intent}){
  // Validate the complete existing operations configuration before any write.
  operationsMailConfiguration(connection);const credential=await this.credential(connection),previous={};for(const component of ['worker','api'])previous[component]=await this.process(component);
  await authorize();await this.installOperationalCredential(connection,credential);
  await this.checkpoint(intent.operationId,'operations',await this.bridge.request('mail',{kind:'operations-overview'}));
  await authorize();const saved=await this.bridge.request('mail',{kind:'operations-apply',intent});
  if(saved.state!=='completed')return phasesFor.operations.map(target=>phase(target,'unknown',null,'system_settings_adoption_unconfirmed'));
  await this.fileWriter(this.control.mailConsumerMetadataFile,operationsMailMetadataSchema.parse({version:1,versionId,connection}),null,{metadata:true});
  for(const component of ['worker','api']){try{await authorize();}catch{return this.operationsReadback(connection,versionId,previous);}try{await this.run('/usr/bin/systemctl',['restart',units[component]],{timeout:60000,maxOutput:4096});}catch{}}
  for(let attempt=0;attempt<30;attempt++){const result=await this.operationsReadback(connection,versionId,previous);if(result.every(row=>row.state==='completed'))return result;if(attempt<29)await this.pause(1000);else return result;}
 }
 async operationsReadback(connection,versionId,previous=null){
  const result=[];
  for(const component of ['worker','api'])try{
   const pid=await this.process(component);if(pid===previous?.[component])throw Error();
   let receipt;
   if(this.receiptReader)receipt=await this.receiptReader(component);
   else{const file=operationsMailReceiptFiles[component];await noSymlinkPath(file);const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>32768||process.platform!=='win32'&&(s.uid!==owners[component]||(s.mode&0o777)!==0o600))throw Error();receipt=JSON.parse(await readFile(file,'utf8'));}
   const value=operationsMailReceiptSchema.parse(receipt),credential=await this.credential(connection),source=await this.fileReader(this.control.operationsCredentialFiles[component]),entry=source.value.credentials.find(row=>row.ref===operationsSmtpCredentialAlias(connection.credentialRef));
   if(value.pid!==pid||value.component!==component||value.versionId!==versionId||value.credentialFile!==this.control.operationsCredentialFiles[component]||!value.credentialConfigured||!isDeepStrictEqual(value.configuration,operationsMailConfiguration(connection))||!entry||entry.user!==credential.user||entry.password!==credential.password)throw Error();
   result.push(phase('operations-'+component,'completed',versionId));
  }catch{result.push(phase('operations-'+component,'unknown',null,'system_settings_adoption_unconfirmed'));}
  return result;
 }
 async apply({versionId,configuration},{authorize,intent}={}){
  const value=this.configuration(configuration),phases=[];if(!Object.values(value.bindings).some(Boolean))throw failure('system_settings_configuration_incomplete');
  if(typeof authorize!=='function'||!intent?.operationId)throw failure('system_settings_authorization_unavailable');
  await authorize();await this.retain();
  for(const purpose of ['account-authentication','runtime-alerts','operations']){
   const connection=this.selected(value,purpose);if(!connection)continue;
   try{await authorize();const options={authorize,intent};
    if(purpose==='account-authentication')phases.push(...await this.applyAuthentication(connection,versionId,options));
    else if(purpose==='runtime-alerts')phases.push(await this.applyAlerts(connection,versionId,options));
    else phases.push(...await this.applyOperations(connection,versionId,options));
   }catch(error){phases.push(...phasesFor[purpose].map(target=>phase(target,'unknown',null,safeSystemSettingsError(error,'system_settings_apply_unknown'))));}
  }
  await this.fileWriter(this.control.appliedMetadataFile,{version:1,versionId,configuration:value},null,{metadata:true});
  return{state:stateOf(phases),phases};
 }
 async readback({versionId,configuration}){
  const value=this.configuration(configuration),phases=[],items=[];
  for(const purpose of ['account-authentication','runtime-alerts','operations']){
   const connection=this.selected(value,purpose);if(!connection)continue;
   if(purpose==='operations')phases.push(...await this.operationsReadback(connection,versionId));
   else if(purpose==='runtime-alerts')phases.push(await this.alertReadback(connection,versionId));
   else for(const realm of realms){const target=realm==='galaxy'?'website-authentication':'management-authentication';
    try{const credential=await this.credential(connection),actual=await this.keycloak.read(realm);if(!isDeepStrictEqual(actual,this.patchNative(actual,connection,credential)))throw Error();phases.push(phase(target,'completed',versionId));}
    catch{phases.push(phase(target,'unknown',null,'system_settings_adoption_unconfirmed'));}
   }
   for(const target of phasesFor[purpose]){const actual=phases.find(row=>row.target===target);items.push({target,id:connection.id,state:actual?.state==='completed'?'available':'unknown',
    credentialConfigured:actual?.state==='completed'?true:null,adoptedVersionId:actual?.adoptedVersionId??null,source:purpose==='operations'?'consumer-ack':purpose==='account-authentication'?'native-keycloak':'native-alertmanager'});}
  }
  return{state:stateOf(phases),configuration:value,phases,items};
 }
}
