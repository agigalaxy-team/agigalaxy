import {spawn} from 'node:child_process';
const failure=code=>Object.assign(Error(code),{code});

// JSONL child ownership is shared by MCP and the private host persistence client.
// Neither client opens a network port or invokes a shell or model provider.
export function createChildRPC({executable,command,configPath,dataDirectory,env,requestTimeoutMs=30000,maxMessageBytes=16*1024*1024,onDiagnostic}){
 if(typeof executable!=='string'||!executable)throw failure('native_bridge_executable_required');
 if(!Number.isSafeInteger(requestTimeoutMs)||requestTimeoutMs<=0)throw failure('native_bridge_timeout_invalid');
 let child,closed=false,failed=false,paused=false,resumeGeneration=0,sequence=0,buffer='',closing;
 const mcp=command==='native'||command==='integration-mcp';
 const pending=new Map();
 const fail=(process,code)=>{if(child!==process)return;failed=true;for(const entry of pending.values())entry.finish(failure(code));};
 const send=(message,connection=child)=>new Promise((resolve,reject)=>{
  if(!connection||child!==connection||failed||connection.stdin.destroyed)return reject(failure('native_bridge_closed'));
  connection.stdin.write(JSON.stringify(message)+'\n',cause=>cause?reject(failure('native_bridge_send_failed')):resolve());
 });
 function start(){
  if(closed)throw failure('native_bridge_closed');
  if(paused)throw failure('native_bridge_paused');
  if(child){if(failed)throw failure('native_bridge_process_exited');return child;}
  failed=false;buffer='';
  child=spawn(executable,[command,...(configPath?['--config',configPath]:[]),...(!configPath&&dataDirectory?['--data-dir',dataDirectory]:[])],{stdio:['pipe','pipe',onDiagnostic?'pipe':'ignore'],windowsHide:true,shell:false,...(env?{env}:{})});
  const process=child,generation=resumeGeneration;
  if(onDiagnostic){let diagnostic='';child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-8192);let end;while((end=diagnostic.indexOf('\n'))!==-1){const line=diagnostic.slice(0,end);diagnostic=diagnostic.slice(end+1);const code=line.match(/\bcode=([a-zA-Z0-9_:-]{1,128})\b/)?.[1];if(code&&(line.includes('host session notification rejected')||line.includes('host session upload continuation stopped'))){try{onDiagnostic({code});}catch{/* Diagnostic consumers cannot alter the transport. */}}}});}
  child.on('error',()=>{fail(process,'native_bridge_start_failed');if(child===process&&!process.pid){child=undefined;buffer='';}});
  child.on('exit',code=>{if(code===75&&generation===resumeGeneration)paused=true;fail(process,closed?'native_bridge_closed':code===75?'native_bridge_paused':'native_bridge_process_exited');if(child===process){child=undefined;buffer='';}});
  child.on('close',code=>{if(code===75&&generation===resumeGeneration)paused=true;fail(process,closed?'native_bridge_closed':code===75?'native_bridge_paused':'native_bridge_process_exited');if(child===process){child=undefined;buffer='';}});
  child.stdin.on('error',()=>{fail(process,'native_bridge_send_failed');process.kill();});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
   if(child!==process||failed)return;
   buffer+=chunk;
   let index;
   while((index=buffer.indexOf('\n'))!==-1){
    const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;
    if(Buffer.byteLength(line)>maxMessageBytes){fail(process,'native_bridge_message_too_large');process.kill();return;}
    let message;try{message=JSON.parse(line);}catch{fail(process,'native_bridge_protocol_invalid');process.kill();return;}
    if(!message||typeof message!=='object'||Array.isArray(message)||mcp&&message.jsonrpc!=='2.0'){fail(process,'native_bridge_protocol_invalid');process.kill();return;}
    if(mcp&&message.method==='notifications/galaxy/host-diagnostic'&&message.id===undefined){const code=message.params?.code;if(typeof code==='string'&&code.length>0&&code.length<=128){try{onDiagnostic?.({code});}catch{/* Diagnostic consumers cannot alter the transport. */}}continue;}
    // Sampling, roots and unsolicited elicitation receive no host capability.
    if(message.method&&message.id!==undefined){void send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unsupported host request'}},process).catch(()=>{});continue;}
    const entry=pending.get(message.id);if(!entry)continue;
    if(message.error)entry.finish(failure(!mcp&&typeof message.error.code==='string'?message.error.code:'native_bridge_request_rejected'));
    else if(Object.hasOwn(message,'result'))entry.finish(null,message.result);
    else entry.finish(failure('native_bridge_protocol_invalid'));
   }
   if(Buffer.byteLength(buffer)>maxMessageBytes){fail(process,'native_bridge_message_too_large');process.kill();}
  });
  return process;
 }
 function request(method,params={}, {signal,connection}={}){
  if(signal?.aborted)return Promise.reject(failure('native_bridge_cancelled'));
  // An MCP continuation belongs to the discovered process. A replacement
  // process may serve a NEW request, never a replay of an interrupted action.
  try{if(connection){if(closed||failed||connection!==child)throw failure('native_bridge_connection_changed');}else connection=start();}catch(cause){return Promise.reject(cause);}
  const id=mcp?++sequence:String(++sequence);
  return new Promise((resolve,reject)=>{
   let timer;
   const finish=(cause,value)=>{if(!pending.delete(id))return;clearTimeout(timer);signal?.removeEventListener('abort',cancel);cause?reject(cause):resolve(value);};
   const notifyCancel=reason=>{if(mcp)void send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id,reason}},connection).catch(()=>{});};
   const cancel=()=>{notifyCancel('host request cancelled');finish(failure('native_bridge_cancelled'));};
   pending.set(id,{finish});signal?.addEventListener('abort',cancel,{once:true});
   timer=setTimeout(()=>{notifyCancel('host deadline exceeded');finish(failure('native_bridge_response_unknown'));},requestTimeoutMs);
   const message={...(mcp?{jsonrpc:'2.0'}:{}),id,method,params};
   if(Buffer.byteLength(JSON.stringify(message))>maxMessageBytes){finish(failure('native_bridge_message_too_large'));return;}
   void send(message,connection).catch(cause=>finish(cause));
  });
 }
 function close(){
  if(closing)return closing;
  closed=true;fail(child,'native_bridge_closed');
  closing=(async()=>{
   const process=child;
   if(!process||process.exitCode!==null||process.signalCode!==null||!process.pid)return;
   await new Promise(resolve=>{
    const timer=setTimeout(()=>process.kill(),1500);
    process.once('close',()=>{clearTimeout(timer);resolve();});
    process.stdin.end();
   });
  })();return closing;
 }
 return Object.freeze({connect:start,request,notify:send,resume(){if(!closed){resumeGeneration++;paused=false;}},close});
}
