import {once} from 'node:events';
import {browserConversationEvent} from "../../operations/agentos/conversation-stream.mjs";

// This connection observes one already-recorded turn. Disconnecting it never
// submits/cancels a run, and no native event body crosses this response.
export async function streamConversationResponse({request,response,operationId,events}){
 const controller=new AbortController(),closed=()=>controller.abort();response.once('close',closed);request.once('aborted',closed);
 const iterator=events(controller.signal)[Symbol.asyncIterator]();
 const write=async value=>{
  if(response.destroyed||controller.signal.aborted)return false;
  const frame=(Number.isSafeInteger(value.eventIndex)?'id: '+value.eventIndex+'\n':'')+'event: message\ndata: '+JSON.stringify(value)+'\n\n';
  if(!response.write(frame))await once(response,'drain',{signal:controller.signal});return true;
 };
 try{
  let next=await iterator.next();
  // Authorization and source qualification occur before committing HTTP200.
  response.statusCode=200;response.setHeader('Content-Type','text/event-stream; charset=utf-8');response.setHeader('Cache-Control','no-store, no-transform');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('X-Accel-Buffering','no');response.flushHeaders?.();
  while(!next.done&&!controller.signal.aborted){
   const value=browserConversationEvent(next.value,operationId);
   if(value&&!await write(value))break;
   if(value&&['terminal','resync'].includes(value.kind))break;
   next=await iterator.next();
  }
 }catch(error){
  if(!controller.signal.aborted){
   if(!response.headersSent)throw error;
   const kind=error.code==='operations_agentos_source_changed'?'context-changed':error.status===401||error.status===403?'blocked':'resync';
   await write({kind,operationId,eventIndex:null}).catch(()=>{});
  }
 }finally{
  controller.abort();try{await iterator.return?.();}catch{}response.off('close',closed);request.off('aborted',closed);
  if(response.headersSent&&!response.destroyed&&!response.writableEnded)response.end();
 }
}
