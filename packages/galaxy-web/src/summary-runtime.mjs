import {openPersonalSummaryStore,createPersonalSummaryLocal} from '../../galaxy-official/src/personal-summary-local.mjs';
import {createPersonalSummaryClient} from '../../galaxy-official/src/personal-summary-client.mjs';
import {createChatSharedSummaryClient,prepareRoomSummaryShare,sharedSummaryRequestHash} from '../../galaxy-official/src/chat-shared-summary-client.mjs';
import {checkedSummaryDraft,replaceSummaryDraft,retainFilteredSummaryDraft} from './summary-composer-state.mjs';
const runtimes=new WeakMap();
export async function getSummaryRuntime(runtime,subjectId,{openStore=openPersonalSummaryStore,now=()=>Math.floor(Date.now()/1000)}={}){
 if(!runtime||!subjectId)throw new Error('请先建立或选择本机银河身份。');
 let subjects=runtimes.get(runtime);if(!subjects){subjects=new Map();runtimes.set(runtime,subjects);}
 if(!subjects.has(subjectId))subjects.set(subjectId,(async()=>{
  const store=await openStore(),client=createPersonalSummaryClient({call:runtime.api.call}),shared=createChatSharedSummaryClient({call:runtime.api.call});
  const endpoint=runtime.api.endpoint;
  const connection=()=>{const s=runtime.api.snapshot();return runtime.api.endpoint===endpoint&&s?.subjectId===subjectId?{...s,client,generation:[s.bindingId,s.generation,s.expiresAt,s.control?.epoch].join(':')}:null;};
  const sourceCheck=async ref=>{if(!connection())throw new Error('connection_required');return(await client.sources({roomId:ref.roomId,refs:[{messageId:ref.messageId,revision:ref.revision}]})).items[0];};
  const local=createPersonalSummaryLocal({subjectId,store,getConnection:connection,sourceCheck});
  const pendingKey=roomId=>'summary-share:'+roomId;
  const historyKey=roomId=>'summary-share-receipts:'+roomId;
  const tag=()=>{const s=runtime.api.snapshot();return JSON.stringify([runtime.api.endpoint,s?.subjectId??null,s?.bindingId??null,s?.generation??null,s?.control?.epoch??null]);};
  let queue=Promise.resolve(),activeFence=null;
  function fence(){const selected=tag(),guard=runtime.api.snapshot()?runtime.receiptStatus?.captureLease?.():null;
   return{check(){guard?.assertCurrent();if(tag()!==selected)throw new Error('summary_binding_changed');}};}
  async function owner(){activeFence?.check();if(runtime.api.endpoint!==endpoint||(await runtime.status()).identity?.subjectId!==subjectId)throw new Error('当前身份已改变，请重新打开摘要。');activeFence?.check();}
  async function readPending(roomId){await owner();const result=await runtime.getLocal(pendingKey(roomId),subjectId);await owner();return result;}
  async function updateLocal(key,change){await owner();let result;
   let updated=false;
   if(runtime.updateLocal)try{result=await runtime.updateLocal(key,change,subjectId);updated=true;}catch(error){if(error.message!=='local_atomic_update_unavailable')throw error;}
   if(!updated){const current=await runtime.getLocal(key,subjectId);await owner();result=change(current);await runtime.putLocal(key,result,subjectId);}
   await owner();return result;
  }
  async function writePending(roomId,value,expectedShareId){return updateLocal(pendingKey(roomId),current=>{
   if(expectedShareId!==undefined&&(current?.shareId??null)!==expectedShareId)throw new Error('summary_original_replaced');return value;
  });}
  const locator=p=>({roomId:p.roomId,shareId:p.shareId,requestHash:p.requestHash,phase:p.phase,endpoint,subjectId});
  async function remember(p,r=null){if(!p.requestHash)return;
   const value={...locator(p),...(r?{receiptState:r.state,noticeCleanupState:r.noticeCleanupState??null,checkedAt:now()}:{}),
    ...(p.blockedReason?{reason:p.blockedReason}:{})};
   await updateLocal(historyKey(p.roomId),rows=>{const all=Array.isArray(rows)?rows:[],prior=all.find(row=>row.shareId===p.shareId),merged={...prior,...value};
    if(['retracted','expired'].includes(prior?.receiptState)&&['pending','published'].includes(r?.state)){
     merged.receiptState=prior.receiptState;merged.noticeCleanupState=prior.noticeCleanupState;
    }
    return[merged,...all.filter(row=>row.shareId!==p.shareId)];});
  }
  const serial=action=>{const original=fence(),run=async()=>{original.check();activeFence=original;try{await owner();return await action();}finally{activeFence=null;}};
   const result=queue.then(run,run);queue=result.catch(()=>{});return result;};
  async function original(roomId){const p=await readPending(roomId);if(!p)return null;
   if(p.roomId!==roomId||p.endpoint&&p.endpoint!==endpoint||p.subjectId&&p.subjectId!==subjectId)throw new Error('summary_share_original_scope_changed');
   // Earlier journals kept the complete request but not its canonical hash.
   // Recover that hash before any source filtering or dropping retry material.
   if(!p.requestHash&&p.request){p.requestHash=await sharedSummaryRequestHash(p.request);await writePending(roomId,p,p.shareId);}
   return p;
  }
  const stopped=p=>['stopped-local','retraction-pending','sources-changed'].includes(p.phase);
  const canStartNew=p=>stopped(p)||['authorization-expired','original-retention-unavailable','original-retention-changed'].includes(p.blockedReason);
  async function pending(roomId){return serial(async()=>{const p=await original(roomId);return p?{...locator(p),reason:p.blockedReason??(stopped(p)?'stopped-local':null),
   canRetry:!!p.request&&!!p.requestHash&&!!connection()&&!stopped(p)&&!canStartNew(p),canStartNewSelection:canStartNew(p)}:null;});}
  async function receipt(p){await owner();if(!connection())throw new Error('connection_required');
   if(!p.requestHash)return{state:'unknown',roomId:p.roomId,shareId:p.shareId,reason:'legacy-request-hash-unavailable',currentAccessGranted:false,contentReturned:false};
   const r=await shared.receipt({roomId:p.roomId,shareId:p.shareId,requestHash:p.requestHash});await owner();return r;
  }
  async function finish(p,r){
   await remember(p,r);
   try{
    if(['published','expired'].includes(r.state)||r.state==='retracted'&&r.noticeCleanupState!=='pending')await writePending(p.roomId,null,p.shareId);
    else if(r.state==='retracted')await writePending(p.roomId,{...locator(p),phase:'retraction-pending'},p.shareId);
   }catch(error){if(error.message!=='summary_original_replaced')throw error;}
   return r;
  }
  async function sendOriginal(p){await owner();if(!connection())throw new Error('connection_required');
   if(!p.request||stopped(p))throw new Error('原分享只保留回执引用，不能重新发布。');
   if(await sharedSummaryRequestHash(p.request)!==p.requestHash)throw new Error('shared_summary_request_conflict');
   // Receipt lookup deliberately precedes these current-permission checks on
   // retries. Leaving a room must not hide an already accepted original write.
   const room=await runtime.api.call('/v2/chat/rooms/'+p.roomId+'/read',{});await owner();
   if(room.roomId!==p.roomId||room.memberRevision!==p.request.expectedMemberRevision)throw new Error('shared_summary_audience_changed');
   const refs=[...p.request.content.fragments.flatMap(f=>f.sourceRefs),...p.request.content.keyMessageRefs];
   for(const ref of refs){const current=await sourceCheck({roomId:p.roomId,...ref});if(!current?.available)throw new Error('shared_summary_sources_unavailable');}
   await owner();p.phase='awaiting-receipt';p.businessAttempted=true;await writePending(p.roomId,p,p.shareId);
   const result=await shared.publish(p.request);await owner();
   if(result?.shareId!==p.shareId||result?.roomId!==p.roomId||!['pending','published','retracted','expired'].includes(result.state))throw new Error('shared_summary_receipt_mismatch');
   return finish(p,result);
  }
  async function reconcileOriginal(roomId,{retry=false,automatic=false}={}){const p=await original(roomId);if(!p)return null;
   const r=await receipt(p);
   if(r.state==='conflict')throw new Error('shared_summary_request_conflict');
   if(['published','retracted','expired'].includes(r.state))return finish(p,r);
   if(!retry||r.state==='unknown')return r;
   if(!['pending','absent'].includes(r.state))throw new Error('shared_summary_receipt_mismatch');
   if(automatic){
    const blocked=async reason=>{p.blockedReason=reason;await writePending(roomId,p,p.shareId);return{...r,reason};};
    if(stopped(p)||!p.request)return{...r,reason:'stopped-local'};
    // A registered pending row already freezes its service expiry. An absent
    // original must still be within the locally recorded sharing decision and
    // the selected room retention; legacy hash-only locators never publish.
    if(r.state==='absent'){
     if(!Number.isSafeInteger(p.requestedAt)||!Number.isSafeInteger(p.retentionDays)||p.retentionDays<1||p.retentionDays>365)
      return blocked('original-retention-unavailable');
     if(p.requestedAt+p.retentionDays*86400<=now())return blocked('authorization-expired');
     const room=await runtime.api.call('/v2/chat/rooms/'+roomId+'/read',{});await owner();
     if(room.retentionDays!==p.retentionDays)return blocked('original-retention-changed');
    }
   }
   return sendOriginal(p);
  }
  const reconcile=(roomId,options)=>serial(()=>reconcileOriginal(roomId,options));
  const resumePending=roomId=>serial(()=>reconcileOriginal(roomId,{retry:true,automatic:true}));
  const previousShares=roomId=>serial(async()=>{await owner();const rows=await runtime.getLocal(historyKey(roomId),subjectId);await owner();
   return(Array.isArray(rows)?rows:[]).filter(row=>row.roomId===roomId&&row.endpoint===endpoint&&row.subjectId===subjectId).map(row=>({...locator(row),
    receiptState:row.receiptState??null,noticeCleanupState:row.noticeCleanupState??null,reason:row.reason??null,checkedAt:row.checkedAt??null}));});
  const reconcilePrevious=(roomId,shareId)=>serial(async()=>{const rows=await runtime.getLocal(historyKey(roomId),subjectId);await owner();
   const p=(Array.isArray(rows)?rows:[]).find(row=>row.roomId===roomId&&row.shareId===shareId&&row.endpoint===endpoint&&row.subjectId===subjectId);
   if(!p)throw new Error('summary_original_locator_unavailable');const r=await receipt(p);await remember(p,r);return r;
  });
  const share=input=>{const selection=structuredClone(input);return serial(async()=>{const prior=await original(selection.room.roomId);
   if(prior){const r=await receipt(prior);if(r.state==='conflict')throw new Error('shared_summary_request_conflict');
    if(['published','retracted','expired'].includes(r.state))await finish(prior,r);
    const active=await original(selection.room.roomId);
    if(active){if(!canStartNew(active))throw new Error('请先处理这间房的上一次分享。');
     // A fresh explicit selection owns a different request. Preserve the old
     // exact receipt without reviving its body or claiming a server withdrawal.
     await remember(active,r);await writePending(active.roomId,null,active.shareId);
    }
   }
   const prepared=await prepareRoomSummaryShare({local,...selection}),p={roomId:selection.room.roomId,shareId:prepared.request.shareId,requestHash:prepared.requestHash,request:prepared.request,phase:'prepared',endpoint,subjectId,businessAttempted:false,
    requestedAt:now(),retentionDays:selection.room.retentionDays};
   await writePending(p.roomId,p,null);return sendOriginal(p);
  });};
  const cancelPending=roomId=>serial(async()=>{const p=await original(roomId);if(!p)return;
   let prior=null;try{prior=await receipt(p);}catch{/* Keep the exact locator when the receipt service is unavailable. */}
   await owner();if(prior?.state==='conflict')throw new Error('shared_summary_request_conflict');
   if(prior?.state==='expired'||prior?.state==='retracted'&&prior.noticeCleanupState!=='pending'){await finish(p,prior);return{localRetryStopped:true,serverRetractionConfirmed:prior.state==='retracted',expired:prior.state==='expired',shareId:p.shareId};}
   const retained={roomId,shareId:p.shareId,requestHash:p.requestHash,phase:'stopped-local',endpoint,subjectId};
   // Stop local retries even if withdrawal loses its response; the historical
   // exact receipt remains readable without granting room/source access.
   await remember(retained,prior);await writePending(roomId,retained,p.shareId);
   try{const result=await shared.retract({roomId,shareId:p.shareId});await owner();
    if(result?.shareId!==p.shareId||result.retracted!==true)throw new Error('shared_summary_receipt_mismatch');
    await remember({...retained,phase:result.noticeCleanupPending?'retraction-pending':'stopped-local'},{state:'retracted',noticeCleanupState:result.noticeCleanupPending?'pending':'complete'});
    if(result.noticeCleanupPending)await writePending(roomId,{...retained,phase:'retraction-pending'},p.shareId);else await writePending(roomId,null,p.shareId);
    return{localRetryStopped:true,serverRetractionConfirmed:true,noticeCleanupPending:result.noticeCleanupPending===true,shareId:p.shareId};
   }catch{await owner();return{localRetryStopped:true,serverRetractionConfirmed:false,shareId:p.shareId};}
  });
  const draftKey=roomId=>`draft:${subjectId}:${endpoint}:${roomId}`;
  async function readDraft(roomId){const guard=fence();await owner();guard.check();const draft=checkedSummaryDraft(await store.read(draftKey(roomId)));await owner();guard.check();if(!draft?.content)return draft;let blockedSources=false,permanent=false,temporary=false;
   const check=async ref=>{try{return await sourceCheck({roomId,...ref});}catch{return{available:false,temporarilyUnavailable:true};}};
   const result=structuredClone(draft),retained=structuredClone(draft),visible=[],saved=[];
   for(const fragment of result.content.fragments){let ok=true,remove=false;for(const ref of fragment.sourceRefs){const s=await check(ref);if(!s.available){ok=false;if(!s.temporarilyUnavailable)remove=true;else temporary=true;}}
    if(ok)visible.push(fragment);else blockedSources=true;if(!remove)saved.push(fragment);else permanent=true;}
   const keys=[],savedKeys=[];for(const ref of result.content.keyMessageRefs){const s=await check(ref);if(s.available)keys.push(ref);else{blockedSources=true;if(s.temporarilyUnavailable)temporary=true;}if(s.available||s.temporarilyUnavailable)savedKeys.push(ref);else permanent=true;}
   result.content.fragments=visible;result.content.keyMessageRefs=keys;result.blockedSources=blockedSources;result.sourcesTemporarilyUnavailable=temporary;if(blockedSources)result.content.coverage.complete=false;
   await owner();guard.check();
   if(permanent){retained.content.fragments=saved;retained.content.keyMessageRefs=savedKeys;retained.content.coverage.complete=false;let changed=false;
    const latest=await store.update(draftKey(roomId),current=>{guard.check();const next=retainFilteredSummaryDraft(current,draft,retained);changed=next.changed;return next.value;});
    await owner();guard.check();if(!changed)throw Error('summary_draft_conflict');result.draftRevision=latest?.draftRevision;
   }
   return result;
  }
  /** @param {string} roomId @param {unknown} value @param {{expectedRevision:string|null}} options */
  async function saveDraft(roomId,value,{expectedRevision}){const guard=fence();await owner();guard.check();
   const result=await store.update(draftKey(roomId),current=>{guard.check();return replaceSummaryDraft(current,value,expectedRevision);});
   await owner();guard.check();return result;
  }
  async function summaryIdForRoom(roomId){const key=`room-summary:${subjectId}:${runtime.api.endpoint}:${roomId}`;return store.update(key,id=>id??crypto.randomUUID());}
  return{local,client,shared,sourceCheck,pending,reconcile,resumePending,share,previousShares,reconcilePrevious,cancelPending,readDraft,saveDraft,summaryIdForRoom,close:()=>store.close()};
 })().catch(e=>{subjects.delete(subjectId);throw e;}));
 return subjects.get(subjectId);
}
export function closeSummaryRuntime(runtime){const subjects=runtimes.get(runtime);if(!subjects)return;runtimes.delete(runtime);for(const promise of subjects.values())promise.then(x=>x.close()).catch(()=>{});}
