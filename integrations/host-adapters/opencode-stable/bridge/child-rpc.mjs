import {spawn} from 'node:child_process';
const failure=code=>Object.assign(Error(code),{code});

// JSONL child ownership is shared by MCP and the private host persistence client.
// Neither client opens a network port or invokes a shell or model provider.
export function createChildRPC({executable,command,configPath,requestTimeoutMs=30000,maxMessageBytes=16*1024*1024,onDiagnostic}){
 if(typeof executable!=='string'||!executable)throw failure('native_bridge_executable_required');
 if(!Number.isSafeInteger(requestTimeoutMs)||requestTimeoutMs<=0)throw failure('native_bridge_timeout_invalid');
 let child,closed=false,failed=false,sequence=0,buffer='',closing;
 const pending=new Map();
 const fail=code=>{failed=true;for(const entry of pending.values())entry.finish(failure(code));};
 const send=message=>new Promise((resolve,reject)=>{
  if(!child||child.stdin.destroyed)return reject(failure('native_bridge_closed'));
  child.stdin.write(JSON.stringify(message)+'\n',cause=>cause?reject(failure('native_bridge_send_failed')):resolve());
 });
 function start(){
  if(closed||failed)throw failure('native_bridge_closed');
  if(child)return;
  child=spawn(executable,[command,...(configPath?['--config',configPath]:[])],{stdio:['pipe','pipe',onDiagnostic?'pipe':'ignore'],windowsHide:true,shell:false});
  if(onDiagnostic){let diagnostic='';child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-8192);let end;while((end=diagnostic.indexOf('\n'))!==-1){const line=diagnostic.slice(0,end);diagnostic=diagnostic.slice(end+1);const code=line.match(/\bcode=(native_connection_selection_changed|native_host_request_invalid)\b/)?.[1];if(code&&line.includes('host session notification rejected')){try{onDiagnostic({code});}catch{/* Diagnostic consumers cannot alter the transport. */}}}});}
  child.on('error',()=>fail('native_bridge_start_failed'));
  child.on('exit',()=>fail(closed?'native_bridge_closed':'native_bridge_process_exited'));
  child.stdin.on('error',()=>fail('native_bridge_send_failed'));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
   buffer+=chunk;
   let index;
   while((index=buffer.indexOf('\n'))!==-1){
    const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;
    if(Buffer.byteLength(line)>maxMessageBytes){fail('native_bridge_message_too_large');child.kill();return;}
    let message;try{message=JSON.parse(line);}catch{fail('native_bridge_protocol_invalid');child.kill();return;}
    if(command==='native'&&message.jsonrpc!=='2.0'){fail('native_bridge_protocol_invalid');child.kill();return;}
    // Sampling, roots and unsolicited elicitation receive no host capability.
    if(message.method&&message.id!==undefined){void send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unsupported host request'}}).catch(()=>{});continue;}
    const entry=pending.get(message.id);if(!entry)continue;
    if(message.error)entry.finish(failure(command==='host'&&typeof message.error.code==='string'?message.error.code:'native_bridge_request_rejected'));
    else if(Object.hasOwn(message,'result'))entry.finish(null,message.result);
    else entry.finish(failure('native_bridge_protocol_invalid'));
   }
   if(Buffer.byteLength(buffer)>maxMessageBytes){fail('native_bridge_message_too_large');child.kill();}
  });
 }
 function request(method,params={}, {signal}={}){
  try{start();}catch(cause){return Promise.reject(cause);}
  if(signal?.aborted)return Promise.reject(failure('native_bridge_cancelled'));
  const id=command==='host'?String(++sequence):++sequence;
  return new Promise((resolve,reject)=>{
   let timer;
   const finish=(cause,value)=>{if(!pending.delete(id))return;clearTimeout(timer);signal?.removeEventListener('abort',cancel);cause?reject(cause):resolve(value);};
   const notifyCancel=reason=>{if(command==='native')void send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id,reason}}).catch(()=>{});};
   const cancel=()=>{notifyCancel('host request cancelled');finish(failure('native_bridge_cancelled'));};
   pending.set(id,{finish});signal?.addEventListener('abort',cancel,{once:true});
   timer=setTimeout(()=>{notifyCancel('host deadline exceeded');finish(failure('native_bridge_response_unknown'));},requestTimeoutMs);
   const message={...(command==='native'?{jsonrpc:'2.0'}:{}),id,method,params};
   if(Buffer.byteLength(JSON.stringify(message))>maxMessageBytes){finish(failure('native_bridge_message_too_large'));return;}
   void send(message).catch(cause=>finish(cause));
  });
 }
 function close(){
  if(closing)return closing;
  closed=true;fail('native_bridge_closed');
  closing=(async()=>{
   if(!child||child.exitCode!==null||child.signalCode!==null)return;
   await new Promise(resolve=>{
    const timer=setTimeout(()=>child.kill(),1500);
    child.once('exit',()=>{clearTimeout(timer);resolve();});
    child.once('error',()=>{clearTimeout(timer);resolve();});
    child.stdin.end();
   });
  })();return closing;
 }
 return Object.freeze({request,notify:send,close});
}
