import {fail,text,number,bool,one,iso,uuid,array} from './safe-values.mjs';

const purposeKeys=['operations','account-authentication','runtime-alerts'];
const targets=[...purposeKeys,'api','worker','analysis','recommendation','search','ai-execution','file-scanning','operations-worker','operations-api','website-authentication','management-authentication'];
const sourceKinds=['operations-database','native-keycloak','native-alertmanager','protected-runtime','consumer-ack','not-connected'];
function currentConsumers(value){return array(value??[],20).map(row=>({target:one(row.target,targets),state:one(row.state,['configured','not-configured','unavailable','unknown']),adoptedVersionId:uuid(row.adoptedVersionId),connectionId:uuid(row.connectionId),source:one(row.source,sourceKinds),configured:bool(row.configured)}));}
function version(value){return value?{id:uuid(value.id),revision:number(value.revision),createdAt:iso(value.createdAt)}:null;}
function credentialConfigured(source,id){const row=Array.isArray(source.credentials)?source.credentials.find(row=>row.connectionId===id):null;return bool(row?.configured);}
function safeOrigin(value){
 if(typeof value!=='string')return null;
 try{const url=new URL(value);return !url.username&&!url.password&&!url.search&&!url.hash&&['','/'].includes(url.pathname)&&(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))?url.origin:null;}catch{return null;}
}
function common(value){if(!value)fail();return{revision:number(value.revision),version:version(value.version),configurationBasis:one(value.configurationBasis,['saved-version','observed-current','empty']),availability:{state:one(value.availability?.state,['available','unavailable','not-configured'])},current:currentConsumers(value.current),pending:value.pending?{kind:one(value.pending.kind,['save','test','apply','credential']),state:one(value.pending.state,['accepted','completed','partial','failed','unknown']),versionId:uuid(value.pending.versionId),revision:number(value.pending.revision)}:null};}
export function systemMailQuery(value){
 if(!value?.configuration)fail();
 return{section:'mail',...common(value),configuration:{connections:array(value.configuration.connections,16).map(row=>({id:uuid(row.id),name:text(row.name,100),host:text(row.host,253),port:number(row.port),tls:one(row.tls,['implicit','starttls']),credentialsConfigured:credentialConfigured(value,row.id)})),bindings:Object.fromEntries(purposeKeys.map(key=>[key,uuid(value.configuration.bindings?.[key])]))},basis:'saved-or-observed-mail-configuration-and-current-consumer-ack'};
}
export function systemConnectionsQuery(value){
 if(!value?.configuration)fail();
 return{section:'service-connections',...common(value),configuration:{connections:array(value.configuration.connections,5).map(row=>({id:uuid(row.id),kind:one(row.kind,['analysis','recommendation','search','ai-execution','file-scanning']),origin:row.kind==='file-scanning'?null:safeOrigin(row.url),index:row.kind==='search'?text(row.index,80):null,scanner:row.kind==='file-scanning'?{host:one(row.host,['127.0.0.1','::1','localhost']),port:number(row.port),timeoutMs:number(row.timeoutMs)}:null,credentialsConfigured:row.kind==='file-scanning'?null:credentialConfigured(value,row.id)}))},basis:'saved-or-observed-service-configuration-and-current-consumer-ack'};
}
export function systemAdvancedQuery(value){
 if(!value)fail();
 return{section:'advanced',revision:number(value.revision),versionId:uuid(value.versionId),connections:array(value.connections,16).map(row=>({id:uuid(row.id),name:text(row.name,100),connectionTimeoutMs:number(row.connectionTimeoutMs),greetingTimeoutMs:number(row.greetingTimeoutMs),socketTimeoutMs:number(row.socketTimeoutMs),maxConnections:number(row.maxConnections),rateLimit:number(row.rateLimit),rateWindowSeconds:number(row.rateWindowSeconds),dkimSelector:text(row.dkimSelector,63)})),source:one(value.source,['mail-configuration']),limitsScope:one(value.limitsScope,['per-worker-process']),current:currentConsumers(value.current)};
}
export function systemGeneralQuery(value){
 if(!value?.publication)fail();
 return{section:'general',publication:{id:uuid(value.publication.id),state:one(value.publication.state,['available','unavailable'])},configuration:value.publication.state==='available'&&value.configuration?{siteTitle:text(value.configuration.siteTitle,200),description:text(value.configuration.description,1600),footerLinks:array(value.configuration.footerLinks,24).map(row=>({label:text(row.label,120),href:text(row.href,2048)}))}:null,basis:'current-public-website-publication',savedDraft:{state:'not-read',configuration:null},logo:{source:'fixed-brand-asset',canReplace:false},favicon:{source:'fixed-brand-asset',canReplace:false}};
}
