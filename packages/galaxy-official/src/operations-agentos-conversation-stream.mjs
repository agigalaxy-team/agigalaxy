import {ServiceError} from './shared/service-error.mjs';

const invalid=()=>{throw new ServiceError('operations_agentos_response_invalid',503);};
const statuses=new Set(['PENDING','RUNNING','COMPLETED','PAUSED','CANCELLED','ERROR']);
const index=value=>Number.isSafeInteger(value)&&value>=0?value:null;

// Native frames are private transport data. Nothing except this closed
// projection may be written to the browser's conversation event stream.
export function conversationStreamEvent(value,{runId,after=-1}={}){
 if(!value||typeof value!=='object')return null;
 if(value.event==='error'&&value.run_id===undefined)return{kind:'resync',eventIndex:null};
 if(value.run_id!==runId)return null;
 const eventIndex=index(value.event_index),event=value.event;
 if(eventIndex!==null&&eventIndex<=after)return null;
 if(typeof event!=='string'||event.includes('Reasoning'))return null;
 if(event==='RunContent'){
  if(typeof value.content!=='string'||value.content_type!==undefined&&value.content_type!=='str')return null;
  // Unindexed deltas cannot be safely deduplicated on reconnect. The durable
  // original result remains available; do not concatenate an uncertain replay.
  return eventIndex===null?{kind:'resync',eventIndex:null}:{kind:'text',eventIndex,text:value.content};
 }
 if(event==='ToolCallStarted')return eventIndex===null?{kind:'resync',eventIndex:null}:{kind:'reset',eventIndex,phase:'working'};
 if(['ToolCallCompleted','RunStarted','RunContentCompleted'].includes(event))return{kind:'phase',eventIndex,phase:'generating'};
 const terminal={RunCompleted:'COMPLETED',RunCancelled:'CANCELLED',RunError:'ERROR',RunPaused:'PAUSED'}[event];
 if(terminal)return{kind:'terminal',eventIndex,status:terminal};
 if(['replay','catch_up','subscribed','stream_expired','error'].includes(event)){
  const status=typeof value.status==='string'?value.status.toUpperCase():null;
  return{kind:event==='error'||event==='stream_expired'||status&&['COMPLETED','PAUSED','CANCELLED','ERROR'].includes(status)?'resync':'phase',eventIndex,phase:'waiting',...(statuses.has(status)?{status}:{})};
 }
 return null;
}

export function browserConversationEvent(value,operationId){
 if(!value||value.operationId!==operationId)return null;
 const eventIndex=index(value.eventIndex),lease=Number.isSafeInteger(value.readExpiresAt)?value.readExpiresAt:null;
 if(value.kind==='lease')return lease===null?null:{kind:'lease',operationId,readExpiresAt:lease,stopAvailable:value.stopAvailable===true};
 if(value.kind==='text')return eventIndex!==null&&typeof value.text==='string'?{kind:'text',operationId,eventIndex,text:value.text,...(lease===null?{}:{readExpiresAt:lease})}:null;
 if(value.kind==='reset')return{kind:'reset',operationId,eventIndex,phase:'working',...(lease===null?{}:{readExpiresAt:lease})};
 if(value.kind==='phase'&&['working','generating','waiting'].includes(value.phase))return{kind:'phase',operationId,eventIndex,phase:value.phase,...(lease===null?{}:{readExpiresAt:lease})};
 if(value.kind==='terminal'&&['COMPLETED','PAUSED','CANCELLED','ERROR'].includes(value.status))return{kind:'terminal',operationId,eventIndex,status:value.status};
 if(value.kind==='resync')return{kind:'resync',operationId,eventIndex};
 if(['blocked','context-changed'].includes(value.kind))return{kind:value.kind,operationId,eventIndex:null};
 return null;
}

// Transport batching only: every emitted batch still receives a fresh current
// authorization check by the service. Never merge across reset/tool/terminal
// events, never truncate text, and acknowledge the last native index in full.
export async function* coalescedConversationEvents(events,{windowMs=80,maxTextBytes=16384,onClose=()=>{}}={}){
 const iterator=events[Symbol.asyncIterator]();
 const read=()=>iterator.next().then(value=>({value}),error=>({error}));
 let pending=read(),buffer=null,deadline=0;
 const wait=async ms=>{let timer;try{return await Promise.race([pending,new Promise(resolve=>{timer=setTimeout(()=>resolve({flush:true}),ms);})]);}finally{clearTimeout(timer);}};
 try{
  while(true){
   const result=buffer?await wait(Math.max(0,deadline-performance.now())):await pending;
   if(result.flush){yield buffer;buffer=null;continue;}
   if(result.error)throw result.error;
   if(result.value.done){if(buffer)yield buffer;return;}
   const value=result.value.value;pending=read();
   if(value.kind==='text'){
    if(buffer)buffer={...buffer,eventIndex:value.eventIndex,text:buffer.text+value.text};
    else{buffer={...value};deadline=performance.now()+windowMs;}
    if(Buffer.byteLength(buffer.text)>=maxTextBytes){yield buffer;buffer=null;}
   }else{
    if(buffer){yield buffer;buffer=null;}
    yield value;
   }
  }
 }finally{
  onClose();await pending;try{await iterator.return?.();}catch{}
 }
}

export async function* nativeSseFrames(body,{maxFrameBytes=1024*1024}={}){
 if(!body||typeof body.getReader!=='function')invalid();
 const reader=body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',data=[],bytes=0;
 const frame=()=>{const text=data.join('\n');data=[];bytes=0;if(!text)return null;try{return JSON.parse(text);}catch{invalid();}};
 try{
  while(true){
   const chunk=await reader.read();
   try{buffer+=decoder.decode(chunk.value??new Uint8Array(),{stream:!chunk.done});}catch{invalid();}
   let newline;
   while((newline=buffer.indexOf('\n'))>=0){
    let line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(line.endsWith('\r'))line=line.slice(0,-1);
    bytes+=Buffer.byteLength(line);if(bytes>maxFrameBytes)invalid();
    if(!line){const value=frame();if(value!==null)yield value;continue;}
    if(line.startsWith(':'))continue;
    const split=line.indexOf(':'),key=split<0?line:line.slice(0,split);let value=split<0?'':line.slice(split+1);if(value.startsWith(' '))value=value.slice(1);
    if(key==='data')data.push(value);
   }
   if(Buffer.byteLength(buffer)+bytes>maxFrameBytes)invalid();
   if(chunk.done){if(buffer.trim()||data.length)invalid();break;}
  }
 }finally{
  try{await reader.cancel();}catch{}
  reader.releaseLock();
 }
}
