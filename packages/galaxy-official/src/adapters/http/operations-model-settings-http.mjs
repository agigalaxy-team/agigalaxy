import {ServiceError} from '../../shared/service-error.mjs';
import {body,recordBodyBytes} from './request.mjs';
const root='/v1/operations/model-settings',internal='/v1/internal/models/authorize',uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const writes=new Map([['draft',{method:'saveDraft',action:'models.configure'}],['apply',{method:'apply',action:'models.apply'}],['credentials',{method:'provisionCredential',action:'models.configure'}]]);
async function internalInput(request,native){
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket?.remoteAddress))throw new ServiceError('model_settings_service_denied',401);
 const context=native.verifyService(request);
 if(request.headers['content-type']!=='application/json'||request.headers['content-encoding'])throw new ServiceError('unsupported_media_type',415);
 const chunks=[];let bytes=0;
 for await(const chunk of request){bytes+=chunk.length;recordBodyBytes(request,chunk.length);if(bytes>65536)throw new ServiceError('request_too_large',413);chunks.push(chunk);}
 let raw;try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks));}catch{throw new ServiceError('invalid_json',400);}
 native.verifyBody(context,raw);
 try{return JSON.parse(raw);}catch{throw new ServiceError('invalid_json',400);}
}
export async function dispatchOperationsModelSettings({operationsModelSettings,modelSettingsNative,authorizeOperator,request,response,requestId,url,send}){
 if(url.pathname===internal){
  if(request.method!=='POST'||url.search)throw new ServiceError('not_found',404);
  if(!operationsModelSettings||!modelSettingsNative)throw new ServiceError('model_settings_native_not_configured',503);
  const input=await internalInput(request,modelSettingsNative);response?.setHeader('Cache-Control','no-store');send(200,await operationsModelSettings.authorizeNative(input));return true;
 }
 if(url.pathname!==root&&!url.pathname.startsWith(root+'/'))return false;
 const part=url.pathname.slice(root.length+1),write=request.method==='POST',operationId=part.startsWith('operations/')&&uuid.test(part.slice(11))?part.slice(11).toLowerCase():null;
 const target=write?writes.get(part):request.method==='GET'&&(['overview','history','usage'].includes(part)||operationId)?{method:operationId?'operation':part,action:'models.read'}:null;
 if(!target)throw new ServiceError('not_found',404);
 const keys=part==='history'?['after','limit']:part==='usage'?['days']:[],query={};
 if(url.search.length>2048||write&&url.search)throw new ServiceError('invalid_model_settings_request',400);
 for(const[key,value]of url.searchParams){if(!keys.includes(key)||Object.hasOwn(query,key))throw new ServiceError('invalid_model_settings_request',400);query[key]=['days','limit'].includes(key)?Number(value):value;}
 if(!operationsModelSettings||typeof authorizeOperator!=='function')throw new ServiceError('model_settings_unavailable',503);
 const actor=await authorizeOperator(request,{write,requestId,action:target.action});response?.setHeader('Cache-Control','no-store');response?.setHeader('Referrer-Policy','no-referrer');
 const result=await operationsModelSettings[target.method](actor,write?await body(request,undefined,{maxBytes:65536}):operationId??query,write?{authorize:()=>authorizeOperator(request,{write:true,requestId})}:undefined);
 send(200,result);return true;
}

