import {createChildRPC} from './child-rpc.mjs';
const failure=code=>Object.assign(Error(code),{code});
const resultValid=value=>value&&typeof value==='object'&&(Array.isArray(value.content)||value.resultType==='input_required'&&typeof value.requestState==='string'&&value.inputRequests&&typeof value.inputRequests==='object');

// onInputRequest must be an actual foreground host UI callback. When absent,
// preserve the original requestState for a caller's explicit UI continuation.
export function createGoRuntimeBridge({configPath=process.env.GALAXY_NATIVE_CONFIG,executable=process.env.GALAXY_NATIVE_EXECUTABLE,dataDirectory,requestTimeoutMs=30000,onInputRequest,onDiagnostic}={}){
 const localOnly=!configPath;
 const rpc=createChildRPC({executable,configPath,dataDirectory:localOnly?dataDirectory:undefined,requestTimeoutMs,command:localOnly?'integration-mcp':'native',onDiagnostic});
 let starting,closed=false;
 const lifetime=new AbortController();
 const context={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'galaxy-opencode-native',version:'1'},'io.modelcontextprotocol/clientCapabilities':{elicitation:{form:{}}}};
 async function start(){
  if(closed)throw failure('native_bridge_closed');
  return starting??=(async()=>{
   const discovered=await rpc.request('server/discover',{_meta:context});
   if(!discovered?.supportedVersions?.includes('2026-07-28'))throw failure('native_bridge_protocol_unsupported');
  })().catch(async cause=>{await rpc.close();throw cause;});
 }
 async function call(name,args={},options={}){
  options={...options,signal:options.signal?AbortSignal.any([options.signal,lifetime.signal]):lifetime.signal};
  if(options.signal.aborted)throw failure(closed?'native_bridge_closed':'native_bridge_cancelled');
  await start();
  let params={name,arguments:args,_meta:context,...(options.requestState?{requestState:options.requestState,inputResponses:options.inputResponses}:{})};
  for(let round=0;round<16;round++){
   const result=await rpc.request('tools/call',params,options);
   if(!resultValid(result))throw failure('native_bridge_result_invalid');
   if(result.resultType!=='input_required'||!onInputRequest)return result;
   const inputResponses={};
   for(const[key,input]of Object.entries(result.inputRequests)){
    if(input.method!=='elicitation/create')throw failure('native_bridge_input_unsupported');
    const response=await onInputRequest(input.params,{signal:options.signal});
    if(closed||options.signal?.aborted)throw failure(closed?'native_bridge_closed':'native_bridge_cancelled');
    if(!response||!['accept','decline','cancel'].includes(response.action))throw failure('native_bridge_input_invalid');
    inputResponses[key]=response;
   }
   params={name,arguments:args,_meta:context,requestState:result.requestState,inputResponses};
  }
  throw failure('native_bridge_input_limit');
 }
 async function sessionComplete({galaxyId,host,sessionId}={}){
  if(localOnly)throw failure('native_bridge_host_notification_unavailable');
  if(![galaxyId,host,sessionId].every(value=>typeof value==='string'&&value.length>0&&value.length<=512))throw failure('native_bridge_host_notification_invalid');
  await start();
  await rpc.notify({jsonrpc:'2.0',method:'notifications/galaxy/host-session-complete',params:{galaxyId,host,sessionId}});
  return {state:'submitted',completionConfirmed:false};
 }
 return Object.freeze({call,sessionComplete,close(){closed=true;lifetime.abort();return rpc.close();}});
}
