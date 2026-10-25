import {ServiceError} from '../../shared/service-error.mjs';
import {body,recordBodyBytes} from './request.mjs';

const root='/v1/operations/maintenance',internal='/v1/internal/maintenance/authorize',chatProbe='/v1/internal/maintenance/chat-probe';
const uuid='[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',point='[a-f0-9]{64}';
const plan=new RegExp('^restore-plans/('+uuid+')(?:/(approve|execute|cancel))?$','i');
export function maintenanceQueryKeys(part){
 return part==='logs'?['component','level','period','before','limit']:part==='backups'||part==='restore-plans'||new RegExp('^restore-plans/'+uuid+'$','i').test(part)?['after','limit']:[];
}
async function authenticatedRaw(request,native){
 // Socket locality and service authentication are checked before any body read.
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket?.remoteAddress))throw new ServiceError('maintenance_service_denied',401);
 const context=native.verifyService(request);
 if(request.headers['content-type']!=='application/json'||request.headers['content-encoding'])throw new ServiceError('unsupported_media_type',415);
 const chunks=[];let bytes=0;
 for await(const chunk of request){bytes+=chunk.length;recordBodyBytes(request,chunk.length);if(bytes>65536)throw new ServiceError('request_too_large',413);chunks.push(chunk);}
 let raw;try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks));}catch{throw new ServiceError('invalid_json',400);}
 native.verifyBody(context,raw);
 let value;try{value=JSON.parse(raw);}catch{throw new ServiceError('invalid_json',400);}
 return value;
}
export async function dispatchOperationsMaintenance({operationsMaintenance,maintenanceNative,chat,authorizeOperator,request,response,requestId,url,send}){
 if(url.pathname===internal||url.pathname===chatProbe){
  if(request.method!=='POST'||url.search)throw new ServiceError('not_found',404);
  if(!maintenanceNative||url.pathname===internal&&!operationsMaintenance)throw new ServiceError('maintenance_native_not_configured',503);
  const input=await authenticatedRaw(request,maintenanceNative);
  if(url.pathname===chatProbe){
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='kind,operationId,version'||input.version!==1||input.kind!=='prosody-current-state'||input.operationId!==null&&!new RegExp('^'+uuid+'$','i').test(input.operationId??''))throw new ServiceError('invalid_maintenance_request',400);
   if(typeof chat?.maintenanceReadiness!=='function')throw new ServiceError('maintenance_prosody_live_component_readiness_unconfirmed',503);
   let value;try{value=await chat.maintenanceReadiness();}catch(error){
    const reasons={chat_transport_unavailable:'maintenance_prosody_probe_unavailable',chat_delivery_unknown:'maintenance_prosody_probe_timeout',chat_transport_invalid_reply:'maintenance_prosody_probe_invalid_ack'};
    throw new ServiceError(reasons[error?.code]??'maintenance_prosody_live_component_readiness_unconfirmed',503);
   }
   if(value?.authenticatedGateway!==true||value?.roomsDomain!=='rooms.galaxy.internal'||value?.roundTrip!==true||value?.readOnly!==true||value?.bodyReturned!==false)throw new ServiceError('maintenance_prosody_live_component_readiness_unconfirmed',503);
   response?.setHeader('Cache-Control','no-store');send(200,{authenticatedGateway:true,roomsDomain:'rooms.galaxy.internal',roundTrip:true,readOnly:true,bodyReturned:false});return true;
  }
  response?.setHeader('Cache-Control','no-store');send(200,await operationsMaintenance.authorizeNative(input));return true;
 }
 if(url.pathname!==root&&!url.pathname.startsWith(root+'/'))return false;
 const part=url.pathname.slice(root.length+1),match=plan.exec(part),write=request.method==='POST';
 let target=null;
 if(request.method==='GET'){
  if(['overview','logs','backups'].includes(part))target={method:part,action:part==='logs'?'maintenance.logs.read':'maintenance.read'};
  else if(part==='restore-plans')target={method:'plans',action:'maintenance.read'};
  else if(new RegExp('^backups/'+point+'$').test(part))target={method:'backup',id:part.slice(8),action:'maintenance.read'};
  else if(match&&!match[2])target={method:'plan',id:match[1].toLowerCase(),action:'maintenance.read'};
  else if(new RegExp('^operations/'+uuid+'$','i').test(part))target={method:'operation',id:part.slice(11).toLowerCase(),action:'maintenance.read'};
  else if(new RegExp('^command-results/'+uuid+'$','i').test(part))target={method:'commandResult',id:part.slice(16).toLowerCase(),action:'maintenance.read'};
 }else if(write){
  if(part==='backups')target={method:'runBackup'};
  else if(part==='restore-plans')target={method:'createPlan'};
  else if(match&&match[2])target={method:match[2]+'Plan',id:match[1].toLowerCase()};
 }
 if(!target)throw new ServiceError('not_found',404);
 const input={},keys=write?[]:maintenanceQueryKeys(part);
 if(url.search.length>4096||write&&url.search)throw new ServiceError('invalid_maintenance_request',400);
 for(const[key,value]of url.searchParams){if(!keys.includes(key)||Object.hasOwn(input,key))throw new ServiceError('invalid_maintenance_request',400);input[key]=value;}
 if(!operationsMaintenance||typeof authorizeOperator!=='function')throw new ServiceError('maintenance_unavailable',503);
 const actor=await authorizeOperator(request,{write,requestId,...(target.action?{action:target.action}:{})});
 response?.setHeader('Cache-Control','no-store');response?.setHeader('Referrer-Policy','no-referrer');
 let result;
 if(write){const value=await body(request,undefined,{maxBytes:65536}),options={authorize:()=>authorizeOperator(request,{write:true,requestId})};
  result=target.id?await operationsMaintenance[target.method](actor,target.id,value,options):await operationsMaintenance[target.method](actor,value,options);
 }else result=target.id?await operationsMaintenance[target.method](actor,target.id,input):await operationsMaintenance[target.method](actor,input);
 send(200,result);return true;
}

