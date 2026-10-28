import {InMemoryTransport,PROTOCOL_VERSION_META_KEY,CLIENT_INFO_META_KEY,CLIENT_CAPABILITIES_META_KEY,isCallToolResult,isJSONRPCResultResponse,isJSONRPCErrorResponse} from '@modelcontextprotocol/server';
import {startNativeStdio} from '../../../../packages/galaxy-edge-mcp/src/native-v2/stdio.mjs';
import {nativeDiagnostics} from '../../../../packages/galaxy-edge-mcp/src/native-v2/diagnostics.mjs';

/**
 * A trusted foreground client of the actual Native MCP entry. The host owns
 * the adapter; every new data scope still uses Native's real local choice.
 * No fixture endpoint, host provider configuration, model or new identity is
 * supplied here. The selected configuration stays fixed for this activation.
 * @param {{configPath?:string,requestTimeoutMs?:number,openBrowser?:(url:string)=>Promise<unknown>}} [options]
 */
export function createNativeRuntimeBridge({configPath=process.env.GALAXY_NATIVE_CONFIG,requestTimeoutMs=30000,openBrowser}={}){
 const diagnostics=nativeDiagnostics('host-client');
 if(!Number.isSafeInteger(requestTimeoutMs)||requestTimeoutMs<=0)throw Error('native_bridge_timeout_invalid');
 let sequence=0,closed=false,starting=null,product=null,wire=null,closing=null;
 /** @type {Map<number,{resolve:(value:unknown)=>void,reject:(reason:Error)=>void,timer:ReturnType<typeof setTimeout>}>} */
 const pending=new Map();
 const context={
  [PROTOCOL_VERSION_META_KEY]:'2026-07-28',
  [CLIENT_INFO_META_KEY]:{name:'galaxy-opencode-native',version:'1'},
  [CLIENT_CAPABILITIES_META_KEY]:{},
 };
 const rejectPending=()=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(Error('native_bridge_closed'));}pending.clear();};
 /** @param {string} method @param {Record<string,unknown>} params @returns {Promise<unknown>} */
 async function request(method,params){
  if(closed||!wire)throw Error('native_bridge_closed');
  const id=++sequence;
  const response=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{pending.delete(id);reject(Error('native_bridge_response_unknown'));},requestTimeoutMs);
   pending.set(id,{resolve,reject,timer});
  });
  try{await wire.send({jsonrpc:'2.0',id,method,params});}catch(error){const request=pending.get(id);if(request){clearTimeout(request.timer);pending.delete(id);request.reject(error instanceof Error?error:Error('native_bridge_send_failed'));}}
  return response;
 }
 async function start(){
  if(closed)throw Error('native_bridge_closed');
  if(starting)return starting;
  const operation=diagnostics.run('bridge-start',async()=>{
   const[a,b]=InMemoryTransport.createLinkedPair();
   try{
    const current=await startNativeStdio({configPath,transport:a,...(openBrowser?{openBrowser}:{})});
    if(closed){await current.close();await b.close();throw Error('native_bridge_closed');}
    product=current;wire=b;
    b.onmessage=message=>{
     if(!isJSONRPCResultResponse(message)&&!isJSONRPCErrorResponse(message))return;
     if(typeof message.id!=='number')return;
     const entry=pending.get(message.id);if(!entry)return;
     pending.delete(message.id);clearTimeout(entry.timer);
     if(isJSONRPCErrorResponse(message))entry.reject(Error('native_bridge_request_rejected'));
     else entry.resolve(message.result);
    };
    b.onclose=rejectPending;
    await b.start();
    await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'galaxy-opencode-native',version:'1'}});
    await b.send({jsonrpc:'2.0',method:'notifications/initialized'});
   }catch(error){
    if(product){await product.close();product=null;}
    await b.close();wire=null;throw error;
   }
  },{event:'host_bridge',host:'opencode'});
  starting=operation;
  try{await operation;}catch(error){if(starting===operation)starting=null;throw error;}
 }
 /** @param {string} name @param {Record<string,unknown>} [args] */
 async function call(name,args={}){
  return diagnostics.run('bridge-request',async()=>{
  await start();
  const result=await request('tools/call',{name,arguments:args,_meta:context});
  if(!isCallToolResult(result))throw Error('native_bridge_result_invalid');
  return result;
  },{event:'host_bridge',host:'opencode',tool:name,resultFailed:value=>value?.isError===true});
 }
 function close(){
  closed=true;rejectPending();
  return closing??=diagnostics.run('shutdown',async()=>{
   try{await starting;}catch{ /* A missing configuration created no product. */ }
   try{await product?.close();}finally{await wire?.close();product=null;wire=null;}
  },{event:'host_bridge',host:'opencode'});
 }
 return Object.freeze({call,close});
}

