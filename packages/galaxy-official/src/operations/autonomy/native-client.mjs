import {createHmac,randomUUID} from 'node:crypto';
import {ServiceError} from '../../shared/service-error.mjs';
const enc=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
export class OperationsAutonomyNativeClient{
 constructor(client){this.client=client;}
 async request(task,suffix,{write=false}={}){
  const c=this.client;if(!c?.configured?.()||!c.serviceKey)throw new ServiceError('operations_agentos_not_configured',503);
  const at=c.now(),head=enc({alg:'HS256',typ:'JWT'}),body=enc({sub:'autonomy:'+task.id,iss:'galaxy-operations',aud:'galaxy-agentos',iat:at,exp:at+60,jti:randomUUID(),scope:'task',taskId:task.id,planId:task.config_id,accountId:task.ai_account_id,delegationVersion:task.delegation_version??null});
  const token=head+'.'+body+'.'+createHmac('sha256',c.signingKey).update(head+'.'+body).digest('base64url');
  let response;try{response=await c.fetchImpl(c.url+'/galaxy/autonomy/tasks/'+task.id+suffix,{method:write?'POST':'GET',headers:{authorization:'Bearer '+token,'x-galaxy-service-key':c.serviceKey,...(write?{'content-type':'application/json','Idempotency-Key':task.id}:{})},...(write?{body:'{}'}:{}),redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new ServiceError('operations_autonomy_result_unknown',503);}
  const bodyText=await response.text();if(bodyText.length>1024*1024)throw new ServiceError('operations_autonomy_response_invalid',503);
  let value;try{value=JSON.parse(bodyText);}catch{throw new ServiceError('operations_autonomy_response_invalid',503);}
  if(!response.ok)throw new ServiceError(response.status===403?'operations_autonomy_authority_changed':'operations_autonomy_native_unavailable',response.status===403?403:503);
  return value;
 }
 run(task){return this.request(task,'/runs',{write:true});}
 read(task){return this.request(task,'');}
 cancel(task){return this.request(task,'/cancel',{write:true});}
 continue(task){return this.request(task,'/continue',{write:true});}
}
