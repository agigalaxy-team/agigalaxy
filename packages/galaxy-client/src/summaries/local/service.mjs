import {summaryContentSchema} from "../../../../galaxy-contracts/src/personal-summary-schema.mjs";
import {clone,failure,validOrigin,uuid,equal,sameHead,draftIdentity} from './helpers.mjs';
import {validatePersonalSummaryCloudView} from './cloud-contract.mjs';

// The complete original per-owner local orchestration closure: preference, source checks, drafts, conflicts, stable queue and receipt-only reconciliation.
export function createPersonalSummaryLocal({subjectId,store,getConnection=()=>null,sourceCheck=null,now=()=>Math.floor(Date.now()/1000),crypto=globalThis.crypto}){
 if(!/^GUID[0-9A-Z]{28}$/.test(subjectId)||typeof store?.update!=='function')throw failure('invalid_summary_local_owner');
 const key='personal-summary:'+subjectId,initial=()=>({schemaVersion:1,subjectId,preference:{state:'unset',endpoint:null,roomIds:null,includeExisting:true,selectedAt:null,cloudRevision:null},summaries:{},queue:[]});
 const update=fn=>store.update(key,s=>fn(s??initial()));
 const read=async()=>await store.read(key)??initial();
 const current=()=>{const c=getConnection();return c?.subjectId===subjectId&&c.endpoint&&c.client?c:null;};
 const connectionGuard=before=>{const{client,bindingId,generation,endpoint}=before;return()=>{const n=current();if(!n||n.client!==client||n.bindingId!==bindingId||n.generation!==generation||n.endpoint!==endpoint||n.subjectId!==subjectId)throw failure('summary_binding_changed');};};
 const allowed=(p,r)=>['enabled','enabled-pending-binding'].includes(p.state)&&r.endpoint===p.endpoint&&(!p.roomIds||p.roomIds.includes(r.roomId))&&(p.includeExisting||r.createdAt>=p.selectedAt);
 async function choose({enabled,endpoint=null,roomIds=null,includeExisting=true},{confirmed=false}={}){
  if(!confirmed||typeof enabled!=='boolean'||roomIds!==null&&(!Array.isArray(roomIds)||roomIds.length>256))throw failure('summary_choice_required');
  if(enabled)validOrigin(endpoint);else if(endpoint)validOrigin(endpoint);
  return update(s=>{if(!enabled&&!endpoint)endpoint=s.preference.endpoint;const same=s.preference.endpoint===endpoint,cloudRevision=same?s.preference.cloudRevision:null;
   s.preference={state:enabled?'enabled-pending-binding':s.preference.state==='unset'?'declined':'disabled',endpoint,roomIds:clone(roomIds),includeExisting,
    selectedAt:now(),cloudRevision,needsPreferenceSync:!!endpoint};
   // New authorization gets a new stable operation only for work not yet sent.
   // In-flight/unknown operations keep their IDs until reconciled after opt-in.
   s.queue=s.queue.filter(q=>['unknown','sending','conflict'].includes(q.state));
   if(enabled)for(const r of Object.values(s.summaries))if(allowed(s.preference,r)&&!s.queue.some(q=>q.summaryId===r.summaryId))s.queue.push(queueRecord(r));
   return s;});
 }
 function queueRecord(r){return{summaryId:r.summaryId,endpoint:r.endpoint,versionId:crypto.randomUUID(),localRevision:r.localRevision,baseRevision:r.cloudRevision??0,
  roomId:r.roomId,content:clone(r.content),state:'queued',dueAt:now()+10,attempts:0};}
 async function save({summaryId=crypto.randomUUID(),roomId,endpoint=current()?.endpoint??null,expectedLocalRevision=0,content}){
  const parsed=summaryContentSchema.parse(content);if(!/^[0-9a-f-]{36}$/.test(summaryId)||!/^[0-9a-f-]{36}$/.test(roomId))throw failure('invalid_summary_id');
  if(endpoint)validOrigin(endpoint);
  const state=await update(s=>{const prev=s.summaries[summaryId];if((prev?.localRevision??0)!==expectedLocalRevision)throw failure('local_summary_conflict');
   if(prev&&(prev.roomId!==roomId||prev.endpoint!==endpoint))throw failure('summary_room_conflict');
   const r={summaryId,roomId,endpoint,content:clone(parsed),createdAt:prev?.createdAt??now(),updatedAt:now(),localRevision:expectedLocalRevision+1,
    cloudRevision:prev?.cloudRevision??0,syncState:'local',conflicts:prev?.conflicts??[],...(prev?.remoteCurrent?{remoteCurrent:clone(prev.remoteCurrent)}:{})};s.summaries[summaryId]=r;
   s.queue=s.queue.filter(q=>q.summaryId!==summaryId||['unknown','sending'].includes(q.state));
   if(allowed(s.preference,r)){s.queue.push(queueRecord(r));r.syncState='queued';}return s;});
  return clone(state.summaries[summaryId]);
 }
 async function sanitise(record){const result=clone(record);let unavailable=false,changed=false;const cache=new Map(),before=current(),checkWholeBinding=before?connectionGuard(before):null;
  const check=async ref=>{const id=ref.messageId+':'+ref.revision;if(!cache.has(id)){
   if(!sourceCheck||!record.endpoint||current()?.endpoint!==record.endpoint){unavailable=true;cache.set(id,{available:false,unchecked:true});}
   else try{const connection=current(),checkBinding=connectionGuard(connection);checkBinding();const status=await sourceCheck({roomId:record.roomId,...ref});checkBinding();if(status.temporarilyUnavailable)unavailable=true;cache.set(id,status);}catch{unavailable=true;cache.set(id,{available:false,unchecked:true});}}
   return cache.get(id);};
  async function filter(content){if(!content?.fragments)return;let modified=false;
   const fragments=[];for(const f of content.fragments){let ok=true;for(const ref of f.sourceRefs)if(!(await check(ref)).available)ok=false;if(ok)fragments.push(f);else modified=true;}
   const refs=[];for(const ref of content.keyMessageRefs)if((await check(ref)).available)refs.push(ref);else modified=true;
   content.fragments=fragments;content.keyMessageRefs=refs;if(modified){content.coverage.complete=false;changed=true;}
  }
  await filter(result.content);await filter(result.remoteCurrent?.content);
  for(const version of result.conflicts??[])await filter(version.content);
  if(cache.size&&checkWholeBinding)try{checkWholeBinding();}catch{
   unavailable=true;changed=true;
   for(const content of [result.content,result.remoteCurrent?.content,...(result.conflicts??[]).map(v=>v.content)].filter(Boolean)){
    content.fragments=content.fragments.filter(fragment=>fragment.sourceRefs.length===0);content.keyMessageRefs=[];content.coverage.complete=false;
   }
  }
  return{record:result,changed,unavailable};
 }
 async function get({summaryId}){const s=await read(),r=s.summaries[summaryId];if(!r)return null;const safe=await sanitise(r);
  // Offline cannot assert current managed-source access. Withhold such fragments
  // in the rendered result, preserving private notes and the recoverable local file.
  if(safe.changed&&!safe.unavailable)await update(t=>{const v=t.summaries[summaryId];if(JSON.stringify(v)===JSON.stringify(r)){v.content=clone(safe.record.content);v.conflicts=clone(safe.record.conflicts??[]);if(safe.record.remoteCurrent)v.remoteCurrent=clone(safe.record.remoteCurrent);v.sourceInvalidated=true;v.syncState='sources-changed';
   t.queue=t.queue.filter(q=>{if(q.summaryId!==summaryId)return true;if(!['sending','unknown'].includes(q.state))return false;
    q.receiptOnly=true;delete q.content;delete q.resolveVersionIds;return true;});}return t;});
  return{...safe.record,sourceState:safe.unavailable?'unverified-offline':safe.changed?'changed':'current',sharedToRoom:false};
 }
 async function status(){const s=await read(),c=current();return{subjectId,preference:clone(s.preference),promptNeeded:s.preference.state==='unset',
  connected:!!c,syncTargetMatches:!!c&&c.endpoint===s.preference.endpoint,queued:s.queue.length,
  pendingOperations:s.queue.filter(q=>c&&q.endpoint===c.endpoint&&['sending','unknown'].includes(q.state)).map(q=>({summaryId:q.summaryId,versionId:q.versionId,endpoint:q.endpoint,state:q.state,receiptOnly:!!q.receiptOnly})),
  summaryCount:Object.keys(s.summaries).length,modelRunning:false};}
 async function list(){const s=await read();return Object.values(s.summaries).sort((a,b)=>b.updatedAt-a.updatedAt).map(r=>({summaryId:r.summaryId,roomId:r.roomId,endpoint:r.endpoint,updatedAt:r.updatedAt,localRevision:r.localRevision,syncState:r.syncState}));}
 async function reconcile({summaryId,versionId}){
  const s=await read(),q=s.queue.find(entry=>entry.summaryId===summaryId&&entry.versionId===versionId),c=current();
  const endpoint=q?.endpoint??s.summaries[summaryId]?.endpoint;
  if(!c||c.endpoint!==endpoint)throw failure('matching_binding_required');
  if(typeof c.client.receipt!=='function')throw failure('summary_receipt_unavailable');
  const check=connectionGuard(c);check();const result=await c.client.receipt({summaryId,versionId});check();
  if(result.operationVersionId!==versionId||!['committed','absent'].includes(result.state)||result.state==='committed'&&result.operation?.summaryId!==summaryId)throw failure('summary_receipt_mismatch');
  await update(t=>{const entry=t.queue.find(x=>x.versionId===versionId&&x.summaryId===summaryId),r=t.summaries[summaryId];if(!entry||!r)return t;
   r.lastReceipt={versionId,state:result.state};
   if(result.state==='absent'){
    if(entry.receiptOnly)t.queue=t.queue.filter(x=>x.versionId!==versionId);
    else{entry.state='queued';entry.dueAt=now();}
   }else{
    const remote=result.summary;r.cloudRevision=remote?.revision??result.operation.revision;
    r.conflicts=clone(remote?.conflicts??[]);
    if(result.operation.state==='conflict'&&!entry.receiptOnly){entry.state='conflict';r.syncState='conflict';r.remoteCurrent=clone(remote?.current??null);}
    else{t.queue=t.queue.filter(x=>x.versionId!==versionId);for(const later of t.queue)if(later.summaryId===summaryId&&later.state==='queued')later.baseRevision=r.cloudRevision;
     if(result.operation.state==='deleted')r.syncState='cloud-deleted';
     else if(result.operation.state==='expired')r.syncState='cloud-expired';
     else if(result.operation.state==='superseded'){r.syncState='conflict';r.remoteCurrent=clone(remote?.current??null);}
     else if(!r.sourceInvalidated&&r.localRevision===entry.localRevision)r.syncState='synced';}
   }return t;});
  check();return{...result,newUploads:0};
 }
 async function synchronize({force=false}={}){
  let s=await read();const c=current();if(!c||c.endpoint!==s.preference.endpoint)return{state:'local',reason:'matching_binding_required'};
  validOrigin(c.endpoint);const check=connectionGuard(c);
  if(s.preference.needsPreferenceSync){const expected=JSON.stringify(s.preference);check();const remote=await c.client.preferences();check();
   if(JSON.stringify((await read()).preference)!==expected)throw failure('summary_choice_changed');
   check();
   const p=await c.client.savePreference({endpoint:c.endpoint,expectedRevision:remote.revision,enabled:['enabled','enabled-pending-binding'].includes(s.preference.state),roomIds:s.preference.roomIds,includeExisting:s.preference.includeExisting});check();
   s=await update(t=>{if(JSON.stringify(t.preference)!==expected)throw failure('summary_choice_changed');
    t.preference.cloudRevision=p.revision;t.preference.needsPreferenceSync=false;if(p.enabled)t.preference.state='enabled';return t;});
  }
  if(s.preference.state!=='enabled')return{state:s.preference.state,newUploads:0};
  // A choice made on another device is authoritative before any new upload.
  check();const latest=await c.client.preferences();check();
  if(latest.revision!==s.preference.cloudRevision){s=await update(t=>{if(t.preference.needsPreferenceSync)return t;
   t.preference.cloudRevision=latest.revision;t.preference.roomIds=latest.roomIds;t.preference.includeExisting=latest.includeExisting;
   t.preference.state=latest.enabled?'enabled':'disabled';return t;});if(s.preference.state!=='enabled')return{state:'disabled',newUploads:0};}
  let completed=0;for(const pending of s.queue){
   const live=await read();if(live.preference.state!=='enabled'||live.preference.needsPreferenceSync)break;
   let q=live.queue.find(q=>q.versionId===pending.versionId);if(!q||q.endpoint!==c.endpoint||!force&&q.dueAt>now())continue;
   if(['sending','unknown'].includes(q.state)||q.receiptOnly){
    const receipt=await reconcile({summaryId:q.summaryId,versionId:q.versionId});check();if(receipt.state==='committed'||q.receiptOnly){completed++;continue;}
    q=(await read()).queue.find(entry=>entry.versionId===q.versionId);if(!q)continue;
   }
   if(q.state==='conflict')continue;
   const prior=live.queue.find(other=>other.summaryId===q.summaryId&&['unknown','sending','conflict'].includes(other.state));if(prior&&prior.versionId!==q.versionId)continue;
   const original=live.summaries[q.summaryId];if(!original||!allowed(live.preference,original))continue;
   const checked=await sanitise({...original,content:q.content});if(checked.unavailable)continue;
   if(checked.changed){await get({summaryId:q.summaryId});continue;}
   check();const prefRevision=live.preference.cloudRevision;
   const request={versionId:q.versionId,summaryId:q.summaryId,roomId:q.roomId,baseRevision:q.baseRevision,preferenceRevision:prefRevision,content:q.content,resolveVersionIds:q.resolveVersionIds??[]};
   let ready=false;await update(t=>{const entry=t.queue.find(x=>x.versionId===q.versionId),record=t.summaries[q.summaryId];
    if(entry&&record&&t.preference.state==='enabled'&&!t.preference.needsPreferenceSync&&t.preference.cloudRevision===prefRevision
      &&JSON.stringify(t.preference)===JSON.stringify(live.preference)&&allowed(t.preference,record)){
      entry.state='sending';ready=true;
    }return t;});
   if(!ready)continue;
   try{const authorized=await read();check();
    if(authorized.preference.state!=='enabled'||authorized.preference.needsPreferenceSync||JSON.stringify(authorized.preference)!==JSON.stringify(live.preference))throw failure('summary_choice_changed');
    const dispatch=authorized.queue.find(entry=>entry.versionId===q.versionId);if(!dispatch||dispatch.receiptOnly||!dispatch.content)throw failure('summary_sources_changed');
    // IDB completion is an await boundary. Check the captured binding again
    // immediately before invoking the transport, with no further yield.
    check();const result=await c.client.put(request);check();await update(t=>{
    const entry=t.queue.find(x=>x.versionId===q.versionId),r=t.summaries[q.summaryId];if(!entry||!r)return t;
    const conflict=result.conflicts?.some(v=>v.versionId===q.versionId);
    r.cloudRevision=result.revision;r.conflicts=clone(result.conflicts??[]);
    if(conflict){entry.state='conflict';r.syncState='conflict';r.remoteCurrent=clone(result.current);}
    else{t.queue=t.queue.filter(x=>x.versionId!==q.versionId);for(const later of t.queue)if(later.summaryId===q.summaryId&&later.state==='queued')later.baseRevision=result.revision;
     if(!r.sourceInvalidated&&r.localRevision===q.localRevision)r.syncState='synced';}
    return t;});completed++;
   }catch(error){await update(t=>{const entry=t.queue.find(x=>x.versionId===q.versionId);if(entry){entry.state='unknown';entry.attempts++;entry.dueAt=now()+[5,30,120,900][Math.min(entry.attempts-1,3)];
    entry.error=typeof error.code==='string'&&/^[a-z0-9_]{1,80}$/.test(error.code)?error.code:'sync_unavailable';}return t;});
    return{state:'error',completed,retryScheduled:true};}
  }
  return{state:'checked',completed};
 }
  async function pull(input){const{summaryId,expectedRoomId,expectedDraftHead}=input;if(!uuid(summaryId))throw failure('invalid_summary_id');
   const s=await read(),c=current();if(!c)throw failure('matching_binding_required');
   // Reading an owned replica is separate from permission to upload. A fresh
   // browser and a browser that declined new uploads may both read this owner.
   const check=connectionGuard(c),before=s.summaries[summaryId],expectedLocalRevision=input.expectedLocalRevision??before?.localRevision??0;
   if(before&&before.endpoint!==c.endpoint)throw failure('summary_target_mismatch');
   if(!Number.isSafeInteger(expectedLocalRevision)||expectedLocalRevision<0||(before?.localRevision??0)!==expectedLocalRevision)throw failure('local_summary_conflict');
   check();const remote=await c.client.get({summaryId});check();
   validatePersonalSummaryCloudView(remote,{summaryId,roomId:expectedRoomId});
   if(!remote.current?.content?.fragments||remote.current.sourcesTemporarilyUnavailable||remote.conflicts?.some(v=>v.sourcesTemporarilyUnavailable))return remote;
   const parsed=summaryContentSchema.parse(remote.current.content);
   await update(t=>{check();const local=t.summaries[summaryId];if((local?.localRevision??0)!==expectedLocalRevision)throw failure('local_summary_conflict');
    if(local&&(local.roomId!==remote.roomId||local.endpoint!==c.endpoint))throw failure('summary_room_conflict');
    if(Object.hasOwn(input,'expectedDraftHead')){const entry=t.drafts?.[draftIdentity({endpoint:c.endpoint,roomId:remote.roomId,summaryId})];if(!sameHead(expectedDraftHead,entry?.head??null))throw failure('local_summary_draft_conflict');}
    if(local&&(t.queue.some(q=>q.summaryId===summaryId)||!equal(local.content,parsed)||local.syncState==='local'||local.syncState==='conflict')){
     local.remoteCurrent=clone(remote.current);local.conflicts=clone(remote.conflicts??[]);local.cloudRevision=remote.revision;local.syncState='conflict';return t;}
    t.summaries[summaryId]={summaryId,roomId:remote.roomId,endpoint:c.endpoint,content:clone(parsed),createdAt:local?.createdAt??Date.parse(remote.current.updatedAt)/1000,updatedAt:now(),
     localRevision:expectedLocalRevision+1,cloudRevision:remote.revision,syncState:'synced',conflicts:clone(remote.conflicts??[])};return t;});check();
   // Keep the existing Native MCP result shape. Web observes the adopted local
   // state separately; no tool protocol or service envelope is replaced.
   return remote;
  }
  // Drafts share the owner's atomic record with saved summaries. Receiving a
  // cloud version can therefore compare both heads before any local mutation.
  function draftView(entry){return{value:entry?.value?clone(entry.value):null,head:entry?.head?clone(entry.head):null};}
  async function migrateDraft(context,legacyKey){const id=draftIdentity(context),s=await read();if(s.drafts?.[id]||!legacyKey)return;
   const legacy=await store.read(legacyKey);if(!legacy||legacy.summaryId!==context.summaryId)return;
   if(typeof store.updateMany!=='function')throw failure('local_atomic_migration_unavailable');
   await store.updateMany([key,legacyKey],values=>{const t=values[key]??initial(),currentLegacy=values[legacyKey];
    if(t.drafts?.[id])return{values:{},result:null};if(!equal(currentLegacy,legacy))throw failure('local_summary_draft_conflict');
    t.drafts??={};t.drafts[id]={...context,head:{draftId:crypto.randomUUID(),revision:1},value:clone(legacy),updatedAt:now()};
    return{values:{[key]:t,[legacyKey]:null},result:null};});
  }
  async function readDraft(context){const id=draftIdentity(context);await migrateDraft(context,context.legacyKey);
   const s=await read(),entry=s.drafts?.[id];if(!entry?.value?.content)return draftView(entry);
   const safe=await sanitise({roomId:context.roomId,endpoint:context.endpoint,content:entry.value.content});
   const visible={...clone(entry.value),content:safe.record.content,blockedSources:safe.changed,sourcesTemporarilyUnavailable:safe.unavailable};let head=entry.head;
   if(safe.changed&&!safe.unavailable){const t=await update(state=>{
     const live=state.drafts?.[id];if(!equal(live,entry))throw failure('local_summary_draft_conflict');
     live.value={...clone(entry.value),content:clone(safe.record.content)};live.head={draftId:entry.head.draftId,revision:entry.head.revision+1};live.updatedAt=now();return state;
    });head=t.drafts[id].head;}
   return{value:visible,head:clone(head),...(safe.changed&&!safe.unavailable?{cleanedFromHead:clone(entry.head)}:{})};
  }
  async function saveDraft(context,value,{expectedHead,preserveSources=false}={}){const id=draftIdentity(context);
   if(expectedHead===undefined||expectedHead!==null&&(!uuid(expectedHead?.draftId)||!Number.isSafeInteger(expectedHead.revision)||expectedHead.revision<1))throw failure('summary_draft_head_required');
   if(value!==null){if(!value||value.summaryId!==context.summaryId)throw failure('summary_room_conflict');summaryContentSchema.parse(value.content);}
   const state=await update(t=>{const prior=t.drafts?.[id];if(!sameHead(expectedHead,prior?.head??null))throw failure('local_summary_draft_conflict');const nextValue=clone(value);
    if(preserveSources&&value!==null){const saved=t.summaries[context.summaryId],base=prior?.value?.content??(saved?.endpoint===context.endpoint&&saved.roomId===context.roomId?saved.content:null);
     if(!base)throw failure('summary_sources_retry_required');const own=fragment=>fragment.kind==='personal-note'&&fragment.sourceRefs.length===0;
     nextValue.content={...clone(base),fragments:[...base.fragments.filter(fragment=>!own(fragment)),...value.content.fragments.filter(own).map(clone)],keyMessageRefs:clone(base.keyMessageRefs)};summaryContentSchema.parse(nextValue.content);
    }
    t.drafts??={};t.drafts[id]={endpoint:context.endpoint,roomId:context.roomId,summaryId:context.summaryId,
     head:{draftId:prior?.head.draftId??crypto.randomUUID(),revision:(prior?.head.revision??0)+1},value:nextValue,updatedAt:now()};return t;});
   return draftView(state.drafts[id]);
  }
  async function listDrafts({endpoint,roomId}={}){validOrigin(endpoint);if(roomId&&!uuid(roomId))throw failure('invalid_summary_id');
   const s=await read();return Object.values(s.drafts??{}).filter(entry=>entry.endpoint===endpoint&&(!roomId||entry.roomId===roomId)&&entry.value&&(entry.value.dirty||entry.value.note||entry.value.importText))
    .map(entry=>({summaryId:entry.summaryId,roomId:entry.roomId,endpoint,updatedAt:entry.updatedAt,localRevision:s.summaries[entry.summaryId]?.localRevision??0,syncState:s.summaries[entry.summaryId]?.syncState??'draft',hasDraft:true}));}
  const roomKey=({endpoint,roomId})=>{validOrigin(endpoint);if(!uuid(roomId))throw failure('invalid_summary_id');return JSON.stringify([endpoint,roomId]);};
  async function roomSelection(context){return(await read()).roomSelections?.[roomKey(context)]??null;}
  async function selectRoomSummary(context){const index=roomKey(context),draftId=draftIdentity(context);
   return(await update(t=>{const record=t.summaries[context.summaryId],draft=t.drafts?.[draftId];
    if(!(record?.endpoint===context.endpoint&&record.roomId===context.roomId)&&!draft?.value)throw failure('summary_missing');
    t.roomSelections??={};t.roomSelections[index]=context.summaryId;return t;})).roomSelections[index];}
  async function reserveRoomSummary(context){const index=roomKey(context);return(await update(t=>{
    t.roomSelections??={};if(!t.roomSelections[index])t.roomSelections[index]=crypto.randomUUID();return t;})).roomSelections[index];}
  async function migrateRoomSelection(context,legacyKey){const index=roomKey(context),s=await read();if(s.roomSelections?.[index]||!legacyKey)return;
   const legacy=await store.read(legacyKey);if(!uuid(legacy))return;if(typeof store.updateMany!=='function')throw failure('local_atomic_migration_unavailable');
   await store.updateMany([key,legacyKey],values=>{const t=values[key]??initial();if(t.roomSelections?.[index])return{values:{},result:null};
    if(values[legacyKey]!==legacy)throw failure('local_summary_draft_conflict');const record=t.summaries[legacy];
    if(record&&(record.endpoint!==context.endpoint||record.roomId!==context.roomId))throw failure('summary_room_conflict');
    t.roomSelections??={};t.roomSelections[index]=legacy;return{values:{[key]:t,[legacyKey]:null},result:null};});
  }
 async function resolve({summaryId,expectedLocalRevision,content},{confirmed=false}={}){if(!confirmed)throw failure('summary_resolution_choice_required');
  const parsed=summaryContentSchema.parse(content);
  const state=await update(t=>{const r=t.summaries[summaryId];if(!r)throw failure('summary_missing');
   if(r.localRevision!==expectedLocalRevision)throw failure('local_summary_conflict');
   // A lost receipt may already have committed. Resolve it before replacing its
   // stable operation; an editor choice cannot cancel an in-flight upload.
   if(t.queue.some(q=>q.summaryId===summaryId&&['unknown','sending'].includes(q.state)))throw failure('summary_original_receipt_required');
    const next={...r,content:clone(parsed),localRevision:r.localRevision+1,updatedAt:now(),syncState:'local',conflicts:[]};delete next.remoteCurrent;delete next.sourceInvalidated;
   t.summaries[summaryId]=next;t.queue=t.queue.filter(q=>q.summaryId!==summaryId);
   if(allowed(t.preference,next)){const q=queueRecord(next);q.resolveVersionIds=(r.conflicts??[]).map(v=>v.versionId);t.queue.push(q);next.syncState='queued';}return t;});
  return clone(state.summaries[summaryId]);}
 async function deleteCloud({summaryId},{confirmed=false}={}){if(!confirmed)throw failure('summary_delete_choice_required');const s=await read(),c=current();if(!c||c.endpoint!==s.preference.endpoint)throw failure('matching_binding_required');
  const check=connectionGuard(c);check();const remote=await c.client.get({summaryId});check();const receipt=await c.client.delete({summaryId,expectedRevision:remote.revision});check();
  await update(t=>{t.queue=t.queue.filter(q=>{if(q.summaryId!==summaryId)return true;if(!['sending','unknown'].includes(q.state))return false;
   q.receiptOnly=true;delete q.content;delete q.resolveVersionIds;return true;});if(t.summaries[summaryId]){t.summaries[summaryId].syncState='cloud-deleted';t.summaries[summaryId].cloudRevision=remote.revision+1;}return t;});check();return receipt;}
 async function onBinding(){const before=await read(),c=current();if(!c)return{state:'local'};
  if(before.preference.state==='declined'&&!before.preference.endpoint)await update(t=>{t.preference.endpoint=c.endpoint;t.preference.needsPreferenceSync=true;return t;});
  if(before.preference.state!=='unset')return synchronize();
  validOrigin(c.endpoint);const check=connectionGuard(c),p=await c.client.preferences();check();if(!p.revision)return{state:'unset',promptNeeded:true};
  await update(t=>{if(t.preference.state!=='unset')return t;t.preference={state:p.enabled?'enabled':'declined',endpoint:c.endpoint,roomIds:p.roomIds,
   includeExisting:p.includeExisting,selectedAt:Date.parse(p.enabledSince)/1000,cloudRevision:p.revision,needsPreferenceSync:false};
    if(p.enabled)for(const r of Object.values(t.summaries))if(r.syncState==='local'&&allowed(t.preference,r)&&!t.queue.some(q=>q.summaryId===r.summaryId))t.queue.push(queueRecord(r));return t;});
  return status();
 }
  return Object.freeze({choose,save,get,list,status,synchronize,reconcile,pull,resolve,deleteCloud,onBinding,readDraft,saveDraft,listDrafts,roomSelection,selectRoomSummary,reserveRoomSummary,migrateRoomSelection});
}
