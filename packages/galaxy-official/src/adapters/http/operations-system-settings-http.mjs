import {ServiceError} from '../../shared/service-error.mjs';
import {body,recordBodyBytes} from './request.mjs';

const root='/v1/operations/system-settings',internal='/v1/internal/system-settings/authorize',mailInternal='/v1/internal/system-settings/mail';
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const writes={versions:['save','system.settings.configure'],test:['test','system.settings.test'],apply:['apply','system.settings.apply']};
function query(url,keys=[]){
 if(url.search.length>2048)throw new ServiceError('invalid_system_settings_request',400);const result={};
 for(const[key,value]of url.searchParams){if(!keys.includes(key)||Object.hasOwn(result,key))throw new ServiceError('invalid_system_settings_request',400);result[key]=key==='limit'?Number(value):value;}
 return result;
}
async function internalBody(request,native){
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket?.remoteAddress))throw new ServiceError('maintenance_service_denied',401);
 const context=native.verifyService(request);
 if(request.headers['content-type']!=='application/json'||request.headers['content-encoding'])throw new ServiceError('unsupported_media_type',415);
 const chunks=[];let count=0;
 for await(const chunk of request){count+=chunk.length;recordBodyBytes(request,chunk.length);if(count>65536)throw new ServiceError('request_too_large',413);chunks.push(chunk);}
 let raw;try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks));}catch{throw new ServiceError('invalid_json',400);}
 native.verifyBody(context,raw);try{return JSON.parse(raw);}catch{throw new ServiceError('invalid_json',400);}
}
export async function dispatchOperationsSystemSettings({operationsSystemSettings,systemGeneralPublications,systemSettingsOperationsMail,systemSettingsNative,authorizeOperator,request,response,requestId,url,send}){
 if(url.pathname===internal||url.pathname===mailInternal){
  if(request.method!=='POST'||url.search)throw new ServiceError('not_found',404);
  if(!operationsSystemSettings||!systemSettingsNative)throw new ServiceError('system_settings_native_not_configured',503);
  const input=await internalBody(request,systemSettingsNative);
  if(url.pathname===mailInternal){if(!systemSettingsOperationsMail)throw new ServiceError('system_settings_consumer_not_configured',503);send(200,await systemSettingsOperationsMail.call(input));}
  else send(200,await operationsSystemSettings.authorizeNative(input));return true;
 }
 if(url.pathname!==root&&!url.pathname.startsWith(root+'/'))return false;
 const part=url.pathname===root?'overview':url.pathname.slice(root.length+1),pieces=part.split('/'),write=request.method==='POST';
 let target=null;
 if(request.method==='GET'){
  if(['overview','advanced'].includes(part))target={kind:part,action:'system.settings.read'};
  else if(['mail','service-connections'].includes(part))target={kind:'read',section:part,action:'system.settings.read'};
  else if(pieces.length===2&&pieces[0]==='operations'&&uuid.test(pieces[1]))target={kind:'operation',id:pieces[1],action:'system.settings.read'};
  else if(pieces.length===2&&['mail','service-connections'].includes(pieces[0])&&pieces[1]==='history')target={kind:'history',section:pieces[0],action:'system.settings.read'};
  else if(part==='general/publication')target={kind:'general-source',action:'system.settings.read'};
  else if(pieces.length===3&&pieces[0]==='general'&&pieces[1]==='operations'&&uuid.test(pieces[2]))target={kind:'general-operation',id:pieces[2],action:'system.settings.read'};
 }else if(write){
  if(pieces.length===2&&['mail','service-connections'].includes(pieces[0])&&writes[pieces[1]])target={kind:writes[pieces[1]][0],section:pieces[0],action:writes[pieces[1]][1]};
  else if(part==='credentials')target={kind:'credential',action:'system.settings.credentials.write'};
  else if(part==='general/publish')target={kind:'general-publish',action:'system.settings.apply'};
 }
 if(!target)throw new ServiceError('not_found',404);
 if(write&&url.search)throw new ServiceError('invalid_system_settings_request',400);
 const values=query(url,target.kind==='history'?['after','limit']:[]),general=target.kind.startsWith('general-');
 if(!(general?systemGeneralPublications:operationsSystemSettings)||typeof authorizeOperator!=='function')throw new ServiceError('system_settings_native_not_configured',503);
 const actor=await authorizeOperator(request,{write,requestId,action:target.action});
 response?.setHeader('Cache-Control','no-store');response?.setHeader('Referrer-Policy','no-referrer');
 const options={authorize:()=>authorizeOperator(request,{write:true,requestId})};let result;
 if(general){
  result=target.kind==='general-source'?await systemGeneralPublications.source(actor):target.kind==='general-operation'
   ?await systemGeneralPublications.operation(actor,target.id):await systemGeneralPublications.publish(actor,await body(request,undefined,{maxBytes:65536}),options);
 }else if(target.kind==='read')result=await operationsSystemSettings.read(actor,target.section);
 else if(['overview','advanced'].includes(target.kind))result=await operationsSystemSettings[target.kind](actor);
 else if(target.kind==='history')result=await operationsSystemSettings.history(actor,target.section,values);
 else if(target.kind==='operation')result=await operationsSystemSettings.operation(actor,target.id);
 else if(target.kind==='credential')result=await operationsSystemSettings.credential(actor,await body(request,undefined,{maxBytes:65536}),options);
 else result=await operationsSystemSettings[target.kind](actor,target.section,await body(request,undefined,{maxBytes:65536}),options);
 send(200,result);return true;
}
