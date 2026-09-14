import {openPersonalSummaryStore,createPersonalSummaryLocal} from '../../galaxy-official/src/personal-summary-local.mjs';
import {createPersonalSummaryClient} from '../../galaxy-official/src/personal-summary-client.mjs';
import {createChatSharedSummaryClient,prepareRoomSummaryShare} from '../../galaxy-official/src/chat-shared-summary-client.mjs';
const runtimes=new WeakMap();
export async function getSummaryRuntime(runtime,subjectId,{openStore=openPersonalSummaryStore}={}){
 if(!runtime||!subjectId)throw new Error('请先建立或选择本机银河身份。');
 let subjects=runtimes.get(runtime);if(!subjects){subjects=new Map();runtimes.set(runtime,subjects);}
 if(!subjects.has(subjectId))subjects.set(subjectId,(async()=>{
  const store=await openStore(),client=createPersonalSummaryClient({call:runtime.api.call}),shared=createChatSharedSummaryClient({call:runtime.api.call});
  const connection=()=>{const s=runtime.api.snapshot();return s?.subjectId===subjectId?{...s,client,generation:[s.bindingId,s.expiresAt,s.control?.epoch].join(':')}:null;};
  const sourceCheck=async ref=>{if(!connection())throw new Error('connection_required');return(await client.sources({roomId:ref.roomId,refs:[{messageId:ref.messageId,revision:ref.revision}]})).items[0];};
  const local=createPersonalSummaryLocal({subjectId,store,getConnection:connection,sourceCheck});
  const pendingKey=roomId=>'summary-share:'+roomId;
  async function owner(){if((await runtime.status()).identity?.subjectId!==subjectId)throw new Error('当前身份已改变，请重新打开摘要。');}
  async function readPending(roomId){await owner();const result=await runtime.getLocal(pendingKey(roomId));await owner();return result;}
  async function writePending(roomId,value){await owner();await runtime.putLocal(pendingKey(roomId),value);await owner();}
  async function pending(roomId){const p=await readPending(roomId);if(!p)return null;
   if(!p.request||!connection()||p.phase==='stopped-local')return{...p,request:undefined,canRetry:false};
   const refs=[...p.request.content.fragments.flatMap(f=>f.sourceRefs),...p.request.content.keyMessageRefs];let transient=false;
   for(const ref of refs){let status;try{status=await sourceCheck({roomId,...ref});}catch{status={available:false,temporarilyUnavailable:true};}if(!status.available){if(status.temporarilyUnavailable)transient=true;else{
    const safe={shareId:p.shareId,roomId,phase:'sources-changed'};await writePending(roomId,safe);return{...safe,canRetry:false};}}}
   return{...p,request:transient?undefined:p.request,canRetry:!transient};
  }
  async function reconcile(roomId,{retry=false}={}){const p=await pending(roomId);if(!p)return null;
   let result;try{result=await shared.get({roomId,shareId:p.shareId});}catch(e){if(e.message!=='shared_summary_unavailable')throw e;}
   if(result&&result.state!=='pending'){await writePending(roomId,null);return result;}
   if(!retry)return result??{state:'not-found',shareId:p.shareId};
   if(!p.canRetry)throw new Error('原分享来源已变化或暂时不可用，请先查看原操作。');
   result=await shared.publish(p.request);if(result.state!=='pending')await writePending(roomId,null);return result;
  }
  async function share(selection){if(await readPending(selection.room.roomId))throw new Error('请先处理这间房的上一次分享。');
   const prepared=await prepareRoomSummaryShare({local,...selection});
   await writePending(selection.room.roomId,{roomId:selection.room.roomId,shareId:prepared.request.shareId,request:prepared.request,phase:'pending'});
   return reconcile(selection.room.roomId,{retry:true});
  }
  async function cancelPending(roomId){const p=await readPending(roomId);if(!p)return;
   try{await shared.retract({roomId,shareId:p.shareId});}catch(e){if(e.message!=='shared_summary_unavailable')throw e;
    // A publish can still be in flight. Keep its stable locator after dropping
    // the local retry payload; absence is not a server cancellation receipt.
    await writePending(roomId,{roomId,shareId:p.shareId,phase:'stopped-local'});return{localRetryStopped:true,serverRetractionConfirmed:false,shareId:p.shareId};}
   await writePending(roomId,null);
   return{localRetryStopped:true,serverRetractionConfirmed:true,shareId:p.shareId};
  }
  const draftKey=roomId=>`draft:${subjectId}:${runtime.api.endpoint}:${roomId}`;
  async function readDraft(roomId){const draft=await store.read(draftKey(roomId));if(!draft?.content)return draft;let blockedSources=false,permanent=false,temporary=false;
   const check=async ref=>{try{return await sourceCheck({roomId,...ref});}catch{return{available:false,temporarilyUnavailable:true};}};
   const result=structuredClone(draft),retained=structuredClone(draft),visible=[],saved=[];
   for(const fragment of result.content.fragments){let ok=true,remove=false;for(const ref of fragment.sourceRefs){const s=await check(ref);if(!s.available){ok=false;if(!s.temporarilyUnavailable)remove=true;else temporary=true;}}
    if(ok)visible.push(fragment);else blockedSources=true;if(!remove)saved.push(fragment);else permanent=true;}
   const keys=[],savedKeys=[];for(const ref of result.content.keyMessageRefs){const s=await check(ref);if(s.available)keys.push(ref);else{blockedSources=true;if(s.temporarilyUnavailable)temporary=true;}if(s.available||s.temporarilyUnavailable)savedKeys.push(ref);else permanent=true;}
   result.content.fragments=visible;result.content.keyMessageRefs=keys;result.blockedSources=blockedSources;result.sourcesTemporarilyUnavailable=temporary;if(blockedSources)result.content.coverage.complete=false;
   if(permanent){retained.content.fragments=saved;retained.content.keyMessageRefs=savedKeys;retained.content.coverage.complete=false;await store.update(draftKey(roomId),()=>retained);}
   return result;
  }
  const saveDraft=(roomId,value)=>store.update(draftKey(roomId),()=>structuredClone(value));
  async function summaryIdForRoom(roomId){const key=`room-summary:${subjectId}:${runtime.api.endpoint}:${roomId}`;return store.update(key,id=>id??crypto.randomUUID());}
  return{local,client,shared,sourceCheck,pending,reconcile,share,cancelPending,readDraft,saveDraft,summaryIdForRoom,close:()=>store.close()};
 })().catch(e=>{subjects.delete(subjectId);throw e;}));
 return subjects.get(subjectId);
}
export function closeSummaryRuntime(runtime){const subjects=runtimes.get(runtime);if(!subjects)return;runtimes.delete(runtime);for(const promise of subjects.values())promise.then(x=>x.close()).catch(()=>{});}
