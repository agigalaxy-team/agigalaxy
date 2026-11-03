import {createHash} from 'node:crypto';
import {createHostRecorder,content} from '../shared/recorder.mjs';

// DSH session/event is post-commit and scoped by the host's Cordis context.
// Ordinary work facts do not consume seed history; explicitly selected archives
// may read the host's exact-session snapshot independently.
export function normalizeEvent(session,event) {
 if(typeof session?.id!=='string'||!Number.isSafeInteger(event?.seq)||event.seq<0)return null;
 const deliveryId='dsh-'+createHash('sha256').update(JSON.stringify([session.id,event.seq])).digest('hex');
 const base={sessionId:session.id,deliveryId,sourceId:`event:${event.seq}`,revision:event.seq,occurredAt:Number.isFinite(event.time)?new Date(event.time).toISOString():undefined};
 if(event.type==='user/message'&&event.data?.source?.kind==='user'){
  const text=event.data.content?.filter(x=>x?.type==='text'&&typeof x.text==='string').map(x=>x.text).join('\n');
  if(typeof text!=='string')return null;
  return {...base,kind:'message',source:{kind:'user-statement',messageId:event.data.id},content:content(text),details:{role:'user',completed:true}};
 }
 if(event.type==='assistant/message'){
  const m=event.data?.message,text=m?.content?.filter(x=>x?.type==='text'&&typeof x.text==='string').map(x=>x.text).join('\n');
  if(typeof text!=='string')return null;
  const model=m.source?.model,provider=m.source?.provider;
  return {...base,kind:'message',source:{kind:'model-report',messageId:m.id},content:content(text),details:{role:'assistant',completed:!event.data.interrupted,...(model?{actualModel:provider?`${provider}/${model}`:model}:{})}};
 }
 if(event.type==='tool/result'){
  const m=event.data?.message;if(!m?.toolCallId)return null;
  return {...base,kind:'tool',source:{kind:'tool-report',eventId:m.toolCallId},details:{status:m.isError?'error':'completed',workOutcome:'unknown'}};
 }
 return null;
}
// Extract only real message values; archive selection is checked separately.
export function archiveMessage(event) {
 const message=event?.type==='user/message'?event.data:
  event?.type==='assistant/message'||event?.type==='tool/result'?event.data?.message:null;
 if(typeof message?.id!=='string'||!message.id||!Array.isArray(message.content))return null;
 return {messageId:message.id,message,parts:message.content};
}
export const name='galaxy-work';
export const inject=['sessions'];
export function apply(ctx, config={}) {
 const recorder=createHostRecorder({host:'deepseek-harness',executable:config.executable,configPath:config.configPath,dataDirectory:config.dataDirectory});
 const queues=new Map(),archiveOwners=new Map();let closing=false;
 ctx.on('session/event',(session,event)=>{
  if(closing||!Number.isSafeInteger(event?.seq))return;
  const prior=queues.get(session.id)||Promise.resolve();
  const next=prior.then(async()=>{try {
   const incoming=normalizeEvent(session,event);
   if(incoming)await recorder.enqueue(incoming);
   const cursor=await recorder.sourceCursor(session.id,event.seq);if(!cursor)return;
   for(let seq=cursor.nextSeq;seq<=event.seq;seq++){
    let item=event;
    if(seq!==event.seq){
     const query=ctx.get('sessionQuery');
     if(!query?.readEvent)throw Error('host_source_recovery_unavailable');
     const window=await query.readEvent({sessionId:session.id,seq});
     if(window?.session?.id!==session.id)throw Error('host_source_recovery_unavailable');
     item=window.target;
     if(!item||item.seq!==seq)throw Error('host_source_recovery_unavailable');
    }
    const observation=normalizeEvent(session,item);
    if(observation)await recorder.record(observation);
    await recorder.advanceCursor({galaxyId:cursor.galaxyId,sessionId:session.id,seq});
   }
  } finally {
   try {
    const owner=await recorder.selectedArchiveOwner(session.id);
    if(!owner)archiveOwners.delete(session.id);
    else if(archiveOwners.get(session.id)!==owner&&ctx.get('sessionQuery')?.readSession) {
     const snapshot=await ctx.get('sessionQuery').readSession(session.id);
     if(snapshot?.session?.id!==session.id||!Array.isArray(snapshot.events))throw Error('host_archive_session_unavailable');
     for(const item of snapshot.events) {
      const message=archiveMessage(item);if(!message)continue;
      const saved=await recorder.captureSelectedMessage({sessionId:session.id,...message,expectedGalaxyId:owner});
      if(!saved?.captured&&saved?.reason!=='outside-selected-retention')throw Error('host_archive_capture_unavailable');
     }
     archiveOwners.set(session.id,owner);
    }
   } catch {ctx.logger?.warn?.('Galaxy selected conversation history unavailable');}
   const original=archiveMessage(event);
   if(original)try {await recorder.captureSelectedMessage({sessionId:session.id,...original});}
   catch {ctx.logger?.warn?.('Galaxy selected conversation capture unavailable');}
  }
  }).catch(()=>{ctx.logger?.warn?.('Galaxy local work observation or recovery unavailable');});
  queues.set(session.id,next);void next.finally(()=>{if(queues.get(session.id)===next)queues.delete(session.id);});
 });
 ctx.effect(()=>()=>{closing=true;return Promise.allSettled([...queues.values()]).then(()=>recorder.close());});
}
export default {name,inject,apply};






