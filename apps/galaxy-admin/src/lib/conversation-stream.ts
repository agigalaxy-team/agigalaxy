import {agentOsConversationOperationPath,type AgentOsDomain} from './agentos-client';
import {OperationsRequestError} from './operations-client';

export type ConversationStreamEvent=
 |{kind:'lease';operationId:string;readExpiresAt:number;stopAvailable:boolean}
 |{kind:'text';operationId:string;eventIndex:number;text:string;readExpiresAt?:number}
 |{kind:'reset';operationId:string;eventIndex:number;phase:'working';readExpiresAt?:number}
 |{kind:'phase';operationId:string;eventIndex:number|null;phase:'working'|'generating'|'waiting';readExpiresAt?:number}
 |{kind:'terminal';operationId:string;eventIndex:number|null;status:'COMPLETED'|'PAUSED'|'CANCELLED'|'ERROR'}
 |{kind:'resync'|'blocked'|'context-changed';operationId:string;eventIndex:number|null};
const invalid=()=>{throw new OperationsRequestError(503,'operations_agentos_response_invalid');};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const index=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
export function parseConversationStreamEvent(value:unknown,operationId:string):ConversationStreamEvent|null{
 if(!record(value)||value.operationId!==operationId)return null;
 const eventIndex=index(value.eventIndex),readExpiresAt=index(value.readExpiresAt),lease=readExpiresAt===null?{}:{readExpiresAt};
 if(value.kind==='lease')return readExpiresAt===null?null:{kind:'lease',operationId,readExpiresAt,stopAvailable:value.stopAvailable===true};
 if(value.kind==='text')return eventIndex===null||typeof value.text!=='string'?null:{kind:'text',operationId,eventIndex,text:value.text,...lease};
 if(value.kind==='reset')return eventIndex===null?null:{kind:'reset',operationId,eventIndex,phase:'working',...lease};
 if(value.kind==='phase'&&typeof value.phase==='string'&&['working','generating','waiting'].includes(value.phase))return{kind:'phase',operationId,eventIndex,phase:value.phase as 'working'|'generating'|'waiting',...lease};
 if(value.kind==='terminal'&&typeof value.status==='string'&&['COMPLETED','PAUSED','CANCELLED','ERROR'].includes(value.status))return{kind:'terminal',operationId,eventIndex,status:value.status as 'COMPLETED'|'PAUSED'|'CANCELLED'|'ERROR'};
 if(value.kind==='resync'||value.kind==='blocked'||value.kind==='context-changed')return{kind:value.kind,operationId,eventIndex};
 return null;
}

// Read only an existing turn. Event payloads never trigger POST or cancellation.
export async function* conversationEventStream(domain:AgentOsDomain,operationId:string,{after=-1,signal,fetchImpl=fetch}:{after?:number;signal:AbortSignal;fetchImpl?:typeof fetch}):AsyncGenerator<ConversationStreamEvent>{
 if(!Number.isSafeInteger(after)||after< -1)invalid();
 const path=agentOsConversationOperationPath(domain,operationId)+'/events'+(after>=0?'?after='+after:'');
 const response=await fetchImpl(path,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'text/event-stream'},signal});
 if(!response.ok){
  // Codes are closed by status here; no upstream body/text enters the view.
  throw new OperationsRequestError(response.status,response.status===401?'operations_access_denied':response.status===403?'operations_permission_denied':response.status===409?'operations_agentos_source_changed':'operations_agentos_unavailable');
 }
 const body=response.body;
 if(!response.headers.get('content-type')?.startsWith('text/event-stream')||!body)throw new OperationsRequestError(503,'operations_agentos_response_invalid');
 const reader=body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),encoder=new TextEncoder();
 let buffer='',data:string[]=[],bytes=0,cursor=after;
 const frame=()=>{
  const text=data.join('\n');data=[];bytes=0;if(!text)return null;
  let raw:unknown;try{raw=JSON.parse(text);}catch{invalid();}
  const value=parseConversationStreamEvent(raw,operationId);
  if(!value)return null;
  if('eventIndex'in value&&value.eventIndex!==null){if(value.eventIndex<=cursor)return null;cursor=value.eventIndex;}
  return value;
 };
 try{
  while(!signal.aborted){
   const chunk=await reader.read();
   try{buffer+=decoder.decode(chunk.value??new Uint8Array(),{stream:!chunk.done});}catch{invalid();}
   let newline:number;
   while((newline=buffer.indexOf('\n'))>=0){
    let line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(line.endsWith('\r'))line=line.slice(0,-1);
    bytes+=encoder.encode(line).byteLength;if(bytes>1024*1024)invalid();
    if(!line){const value=frame();if(value)yield value;continue;}
    if(line.startsWith(':'))continue;
    const split=line.indexOf(':'),key=split<0?line:line.slice(0,split);let value=split<0?'':line.slice(split+1);if(value.startsWith(' '))value=value.slice(1);
    if(key==='data')data.push(value);
   }
   if(encoder.encode(buffer).byteLength+bytes>1024*1024)invalid();
   if(chunk.done){if(buffer.trim()||data.length)invalid();break;}
  }
 }finally{
  try{await reader.cancel();}catch{}
  reader.releaseLock();
 }
}
