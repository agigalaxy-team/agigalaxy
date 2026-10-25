import {isDeepStrictEqual} from 'node:util';
import {lstat,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {isAbsolute,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {serviceConnectionBinding,serviceConnectionSchema,serviceConnectionKinds,serviceCredentialSchemas,serviceConnectionConsumerMetadataSchema,serviceConnectionConsumerReadbackSchema} from './service-connections-schema.mjs';

export const serviceConnectionReceiptFiles=Object.freeze({api:'/var/log/galaxy/pilot/api/service-connections-adopted.json',worker:'/var/log/galaxy/pilot/worker/service-connections-adopted.json'});
const bindingFor=(kind,id,raw)=>kind==='analysis'?{id,kind,url:raw.url,projectId:raw.projectId,clientId:raw.clientId,readClientId:raw.readClientId}:
 kind==='search'?{id,kind,url:raw.url,index:raw.index??'galaxy_public_community'}:kind==='file-scanning'?{id,kind,host:raw.host,port:raw.port,timeoutMs:raw.timeoutMs}:{id,kind,url:raw.url};
const credentialFor=(kind,raw)=>kind==='analysis'?{clientSecret:raw.clientSecret,readClientSecret:raw.readClientSecret}:
 kind==='recommendation'||kind==='search'?{apiKey:raw.apiKey}:kind==='ai-execution'?{signingKey:raw.signingKey,serviceKey:raw.serviceKey}:null;
const rawFor=(kind,{discoveryRuntime,agentOsClient,attachmentConfiguration})=>{
 const client=kind==='analysis'?discoveryRuntime?.openpanel:kind==='recommendation'?discoveryRuntime?.gorse:kind==='search'?discoveryRuntime?.meili:null;
 if(kind==='analysis')return client&&client.reader?.origin===client.origin?{url:client.origin,projectId:client.projectId,clientId:client.headers?.['openpanel-client-id'],clientSecret:client.headers?.['openpanel-client-secret'],readClientId:client.reader?.headers?.['openpanel-client-id'],readClientSecret:client.reader?.headers?.['openpanel-client-secret']}:null;
 if(kind==='recommendation')return client?{url:client.origin,apiKey:client.headers?.['X-API-Key']}:null;
 if(kind==='search')return client?{url:client.origin,index:client.index,apiKey:client.headers?.Authorization?.startsWith('Bearer ')?client.headers.Authorization.slice(7):null}:null;
 return kind==='ai-execution'?agentOsClient:attachmentConfiguration?.scanner;
};

/** Construct after the actual startup loaders. No body/config submitted by a
 * browser is a runtime observation. Output contains no secret or secret proof. */
export function createServiceConnectionConsumerReadback({component,versionId,connections,discoveryRuntime=null,agentOsClient=null,attachmentConfiguration=null,pid=process.pid,now=()=>Math.floor(Date.now()/1000)}){
 if(!['api','worker'].includes(component))throw Error('system_settings_consumer_not_configured');
 const actual=[];
 for(const submitted of connections){const configuration=serviceConnectionSchema.parse(submitted),kind=configuration.kind;
  if(component==='worker'&&kind==='ai-execution')continue;
  const raw=rawFor(kind,{discoveryRuntime,agentOsClient,attachmentConfiguration});if(!raw)continue;
  const observed={...bindingFor(kind,configuration.id,raw),...(kind==='file-scanning'?{}:{credentialRef:configuration.credentialRef})};
  const parsed=serviceConnectionSchema.safeParse(observed);if(!parsed.success)continue;
  actual.push({configuration:parsed.data,credentialsConfigured:kind==='file-scanning'?null:serviceCredentialSchemas[kind].safeParse(credentialFor(kind,raw)).success});
 }
 return serviceConnectionConsumerReadbackSchema.parse({component,versionId,pid,checkedAt:now(),connections:actual});
}

export async function loadServiceConnectionConsumerReadback(file,actual){
 if(!file)return null;if(!isAbsolute(file))throw Error('system_settings_consumer_not_configured');
 const info=await lstat(file);
 // Root-owned nonsecret startup metadata may be read by both existing service
 // users; neither may replace its version/connection binding.
 if(!info.isFile()||info.isSymbolicLink()||info.size>65536||process.platform!=='win32'&&(info.uid!==0||(info.mode&0o022)))throw Error('system_settings_private_configuration_invalid');
 let metadata;try{metadata=serviceConnectionConsumerMetadataSchema.parse(JSON.parse(await readFile(file,'utf8')));}catch{throw Error('system_settings_private_configuration_invalid');}
 return createServiceConnectionConsumerReadback({...actual,versionId:metadata.versionId,connections:metadata.connections});
}

async function writeReceipt(file,receipt){
 const parent=await lstat(dirname(file));if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('system_settings_adoption_unconfirmed');
 try{const current=await lstat(file);if(!current.isFile()||current.isSymbolicLink()||process.platform!=='win32'&&(current.uid!==process.getuid()||(current.mode&0o077)))throw Error('system_settings_adoption_unconfirmed');}catch(error){if(error.code!=='ENOENT')throw error;}
 const temporary=file+'.'+randomUUID()+'.tmp';
 try{await writeFile(temporary,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});await rename(temporary,file);}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

/** Fixed files already inside each unit's existing ReadWritePaths. Reporting
 * failure cannot turn unrelated API/worker startup into a permanent outage. */
export async function reportServiceConnectionAdoption(file,actual,{write=writeReceipt}={}){
 if(!file)return{state:'not-configured'};
 try{const receipt=await loadServiceConnectionConsumerReadback(file,actual);await write(serviceConnectionReceiptFiles[actual.component],receipt);return{state:'recorded',component:receipt.component,versionId:receipt.versionId};}
 catch{return{state:'unavailable',code:'system_settings_adoption_unconfirmed'};}
}

export function serviceConnectionAdopted({observation,configuration,versionId,component,pid}){
 const parsed=serviceConnectionConsumerReadbackSchema.safeParse(observation);if(!parsed.success)return false;
 const value=parsed.data;if(value.component!==component||value.versionId!==versionId||value.pid!==pid)return false;
 const matches=value.connections.filter(row=>row.configuration.id===configuration.id&&row.configuration.kind===configuration.kind);
 return matches.length===1&&serviceConnectionMatches(matches[0].configuration,configuration)&&(configuration.kind==='file-scanning'||matches[0].credentialsConfigured===true);
}

export function describeServiceConnections({connections=[],current=[],checkedAt}){
 return{checkedAt,items:connections.map(value=>{const configuration=serviceConnectionSchema.parse(value),rows=current.filter(row=>row.id===configuration.id&&row.kind===configuration.kind),row=rows.length===1?rows[0]:null;
  return{id:configuration.id,kind:configuration.kind,configuration,credentialConfigured:configuration.kind==='file-scanning'?null:row?.credentialConfigured===true,
   appliedVersionId:row?.appliedVersionId??null,state:row?.state==='available'?'available':row?.state==='unavailable'?'unavailable':'unknown'};
 })};
}
export function serviceConnectionTargets(configuration){return configuration.kind==='ai-execution'?['api']:['api','worker'];}
export function serviceConnectionMatches(left,right){try{return isDeepStrictEqual(serviceConnectionBinding(left),serviceConnectionBinding(right));}catch{return false;}}
export {serviceConnectionKinds};
