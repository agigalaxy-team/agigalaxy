import { randomUUID } from 'node:crypto';
import { AgentCard,GetTaskRequest } from '@a2a-js/sdk';
import { ClientFactory,JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { A2AError } from '@a2a-js/sdk/errors';
import { fetchPublicJson,postA2aJson,validatePublicUrl } from "../infrastructure/public-fetch.mjs";
import { digest } from "../shared/digest.mjs";

export function builderProbeTarget(value){
  if(!value||value.protocol!=='a2a/1.0'||value.transport!=='JSONRPC'||typeof value.tenant!=='string')throw new Error('A2A probe target required');
  return {protocol:value.protocol,transport:value.transport,endpoint:validatePublicUrl(value.endpoint).href,cardUrl:validatePublicUrl(value.cardUrl).href,tenant:value.tenant};
}

// The registered Node approves both URLs. The SDK only gets the exact selected
// interface, a fresh unrelated task ID, and no credentials or user content.
export async function observeBuilderEndpoint(input,{get=fetchPublicJson,post=postA2aJson,now=()=>Math.floor(Date.now()/1000),signal}={}){
  const target=builderProbeTarget(input),started=performance.now(),checkedAt=now();
  const deadline=AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])]);
  let cardRetrieved=false,cardHash,stage='card',endpointReachable=null,protocolResponded=false,authenticationRequired=false;
  const finish=(status,reason)=>({version:1,status,reason,checkedAt,validUntil:checkedAt+300,durationMs:Math.round(performance.now()-started),
    stage,cardRetrieved,...(cardHash?{cardHash}:{}),endpointReachable,protocolResponded,authenticationRequired,
    authority:'registry-worker-public-observation',endpointControlVerified:false,capabilityVerified:false});
  try{
    const document=await get(target.cardUrl,{signal:deadline,timeoutMs:5000,maxBytes:65536});
    cardRetrieved=true;cardHash=digest(JSON.stringify(document));
    const card=AgentCard.fromJSON(document);
    const selected=card.supportedInterfaces.find(item=>item.url===target.endpoint&&item.tenant===target.tenant&&item.protocolVersion==='1.0'&&item.protocolBinding==='JSONRPC');
    if(!selected)return finish('protocol-mismatch','selected-interface-not-advertised');
    card.supportedInterfaces=[selected];stage='rpc';
    const taskId=randomUUID();
    const fetchImpl=async(input,init)=>{
      const request=new Request(input,init);
      if(request.url!==target.endpoint||request.method!=='POST'||request.headers.get('A2A-Version')!=='1.0')throw new Error('Probe left selected interface');
      const bodyJson=await request.text(),body=JSON.parse(bodyJson);
      if(body.method!=='GetTask'||body.params?.id!==taskId||(body.params?.tenant??'')!==target.tenant)throw new Error('Read-only probe required');
      let reply;
      try{reply=await post(target.endpoint,{bodyJson,signal:deadline,timeoutMs:5000,maxBytes:65536});}
      catch(error){if(error?.code==='GALAXY_REMOTE_REJECTED'){authenticationRequired=true;endpointReachable=true;}throw error;}
      endpointReachable=true;
      return new Response(JSON.stringify(reply),{status:200,headers:{'Content-Type':'application/json'}});
    };
    const client=await new ClientFactory({transports:[new JsonRpcTransportFactory({fetchImpl})],preferredTransports:['JSONRPC']}).createFromAgentCard(card);
    try{
      const task=await client.getTask(GetTaskRequest.fromJSON({id:taskId,tenant:target.tenant,historyLength:0}),{signal:deadline});
      if(task.id!==taskId)return finish('protocol-mismatch','unexpected-task-response');
      protocolResponded=true;return finish('reachable','task-read-response');
    }catch(error){
      if(error instanceof A2AError){
        protocolResponded=true;
        if(error.reason==='TASK_NOT_FOUND')return finish('reachable','task-not-found-response');
        return finish('protocol-mismatch','other-a2a-error');
      }
      throw error;
    }
  }catch(error){
    if(error?.code==='GALAXY_REMOTE_REJECTED')authenticationRequired=true;
    if(authenticationRequired)return finish('authentication-required',stage==='card'?'card-authentication-required':'rpc-authentication-required');
    if(endpointReachable===true)return finish('protocol-mismatch','invalid-rpc-response');
    if(stage==='rpc')endpointReachable=false;
    return finish('unavailable','public-read-unavailable');
  }
}
