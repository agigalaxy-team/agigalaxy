import {summaryContentSchema} from './shared/personal-summary-schema.mjs';
const clone=x=>structuredClone(x),stamp=n=>new Date(n*1000).toISOString();
const failure=code=>Object.assign(new Error(code),{code});
const validOrigin=endpoint=>{const u=new URL(endpoint);if(u.protocol!=='https:'||u.origin!==endpoint||u.username||u.password)throw failure('invalid_summary_target');return endpoint;};

// One IDB record per identity; atomic update prevents two tabs silently replacing
// local revisions. No external requests or credentials are stored in this DB.
export async function openPersonalSummaryStore({indexedDB=globalThis.indexedDB,name='galaxy-personal-summaries-v1'}={}){
 if(!indexedDB)throw failure('indexeddb_unavailable');
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>r.result.createObjectStore('owners');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 function update(key,updater,mode='readwrite'){return new Promise((resolve,reject)=>{const tx=db.transaction('owners',mode),store=tx.objectStore('owners'),r=store.get(key);let result;
  r.onsuccess=()=>{try{const next=updater(clone(r.result));result=clone(next);if(mode==='readwrite')store.put(next,key);}catch(e){reject(e);tx.abort();}};
  tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??failure('local_summary_transaction_aborted'));
 });}
 return Object.freeze({read:key=>update(key,x=>x,'readonly'),update,close:()=>db.close()});
}

export function createPersonalSummaryLocal({subjectId,store,getConnection=()=>null,sourceCheck=null,now=()=>Math.floor(Date.now()/1000),crypto=globalThis.crypto}){
 if(!/^GUID[0-9A-Z]{28}$/.test(subjectId)||typeof store?.update!=='function')throw failure('invalid_summary_local_owner');
 const key='personal-summary:'+subjectId,initial=()=>({schemaVersion:1,subjectId,preference:{state:'unset',endpoint:null,roomIds:null,includeExisting:true,selectedAt:null,cloudRevision:null},summaries:{},queue:[]});
 const update=fn=>store.update(key,s=>fn(s??initial()));
 const read=async()=>await store.read(key)??initial();
 const current=()=>{const c=getConnection();return c?.subjectId===subjectId&&c.endpoint&&c.client?c:null;};
 const connectionGuard=before=>()=>{const n=current();if(!n||n.client!==before.client||n.bindingId!==before.bindingId||n.generation!==before.generation||n.endpoint!==before.endpoint||n.subjectId!==subjectId)throw failure('summary_binding_changed');};
 const allowed=(p,r)=>['enabled','enabled-pending-binding'].includes(p.state)&&r.endpoint===p.endpoint&&(!p.roomIds||p.roomIds.includes(r.roomId))&&(p.includeExisting||r.createdAt>=p.selectedAt);
 async function choose({enabled,endpoint=null,roomIds=null,includeExisting=true},{confirmed=false}={}){
  if(!confirmed||typeof enabled!=='boolean'||roomIds!==null&&(!Array.isArray(roomIds)||roomIds.length>256))throw failure('summary_choice_required');
  if(enabled)validOrigin(endpoint);else if(endpoint)validOrigin(endpoint);
  return update(s=>{if(!enabled&&!endpoint)endpoint=s.preference.endpoint;const same=s.preference.endpoint===endpoint,cloudRevision=same?s.preference.cloudRevision:null;
   s.preference={state:enabled?'enabled-pending-binding':s.preference.state==='unset'?'declined':'disabled',endpoint,roomIds:clone(roomIds),includeExisting,
    selectedAt:now(),cloudRevision,needsPreferenceSync:!!endpoint};
   // New authorization gets a new stable operation only for work not yet sent.
   // In-flight/unknown operations keep their IDs until reconciled after opt-in.
   s.queue=s.queue.filter(q=>q.state==='unknown');
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
 async function sanitise(record){const result=clone(record);let unavailable=false,changed=false;const cache=new Map();
  const check=async ref=>{const id=ref.messageId+':'+ref.revision;if(!cache.has(id)){
   if(!sourceCheck||!record.endpoint||current()?.endpoint!==record.endpoint){unavailable=true;cache.set(id,{available:false,unchecked:true});}
   else try{const status=await sourceCheck({roomId:record.roomId,...ref});if(status.temporarilyUnavailable)unavailable=true;cache.set(id,status);}catch{unavailable=true;cache.set(id,{available:false,unchecked:true});}}
   return cache.get(id);};
  async function filter(content){if(!content?.fragments)return;let modified=false;
   const fragments=[];for(const f of content.fragments){let ok=true;for(const ref of f.sourceRefs)if(!(await check(ref)).available)ok=false;if(ok)fragments.push(f);else modified=true;}
   const refs=[];for(const ref of content.keyMessageRefs)if((await check(ref)).available)refs.push(ref);else modified=true;
   content.fragments=fragments;content.keyMessageRefs=refs;if(modified){content.coverage.complete=false;changed=true;}
  }
  await filter(result.content);await filter(result.remoteCurrent?.content);
  for(const version of result.conflicts??[])await filter(version.content);
  return{record:result,changed,unavailable};
 }
 async function get({summaryId}){const s=await read(),r=s.summaries[summaryId];if(!r)return null;const safe=await sanitise(r);
  // Offline cannot assert current managed-source access. Withhold such fragments
  // in the rendered result, preserving private notes and the recoverable local file.
  if(safe.changed&&!safe.unavailable)await update(t=>{const v=t.summaries[summaryId];if(JSON.stringify(v)===JSON.stringify(r)){v.content=clone(safe.record.content);v.conflicts=clone(safe.record.conflicts??[]);if(safe.record.remoteCurrent)v.remoteCurrent=clone(safe.record.remoteCurrent);v.sourceInvalidated=true;v.syncState='sources-changed';
   t.queue=t.queue.filter(q=>q.summaryId!==summaryId);}return t;});
  return{...safe.record,sourceState:safe.unavailable?'unverified-offline':safe.changed?'changed':'current',sharedToRoom:false};
 }
 async function status(){const s=await read(),c=current();return{subjectId,preference:clone(s.preference),promptNeeded:s.preference.state==='unset',
  connected:!!c,syncTargetMatches:!!c&&c.endpoint===s.preference.endpoint,queued:s.queue.length,summaryCount:Object.keys(s.summaries).length,modelRunning:false};}
 async function list(){const s=await read();return Object.values(s.summaries).sort((a,b)=>b.updatedAt-a.updatedAt).map(r=>({summaryId:r.summaryId,roomId:r.roomId,endpoint:r.endpoint,updatedAt:r.updatedAt,localRevision:r.localRevision,syncState:r.syncState}));}
 async function synchronize({force=false}={}){
  let s=await read();const c=current();if(!c||c.endpoint!==s.preference.endpoint)return{state:'local',reason:'matching_binding_required'};
  validOrigin(c.endpoint);const check=connectionGuard(c);
  if(s.preference.needsPreferenceSync){check();const remote=await c.client.preferences();check();
   const p=await c.client.savePreference({endpoint:c.endpoint,expectedRevision:remote.revision,enabled:['enabled','enabled-pending-binding'].includes(s.preference.state),roomIds:s.preference.roomIds,includeExisting:s.preference.includeExisting});check();
   const expected=JSON.stringify(s.preference);s=await update(t=>{if(JSON.stringify(t.preference)!==expected)throw failure('summary_choice_changed');
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
   const q=live.queue.find(q=>q.versionId===pending.versionId);if(!q||q.endpoint!==c.endpoint||!force&&q.dueAt>now())continue;
   if(q.state==='conflict')continue;
   const prior=live.queue.find(other=>other.summaryId===q.summaryId&&['unknown','sending','conflict'].includes(other.state));if(prior&&prior.versionId!==q.versionId)continue;
   const original=live.summaries[q.summaryId];if(!original||!allowed(live.preference,original))continue;
   const checked=await sanitise({...original,content:q.content});if(checked.unavailable)continue;
   if(checked.changed){await get({summaryId:q.summaryId});continue;}
   check();const prefRevision=live.preference.cloudRevision;
   const request={versionId:q.versionId,summaryId:q.summaryId,roomId:q.roomId,baseRevision:q.baseRevision,preferenceRevision:prefRevision,content:q.content,resolveVersionIds:q.resolveVersionIds??[]};
   await update(t=>{const entry=t.queue.find(x=>x.versionId===q.versionId);if(entry)entry.state='sending';return t;});
   try{const result=await c.client.put(request);check();await update(t=>{
    const entry=t.queue.find(x=>x.versionId===q.versionId),r=t.summaries[q.summaryId];if(!entry||!r)return t;
    const conflict=result.conflicts?.some(v=>v.versionId===q.versionId);
    r.cloudRevision=result.revision;r.conflicts=clone(result.conflicts??[]);
    if(conflict){entry.state='conflict';r.syncState='conflict';r.remoteCurrent=clone(result.current);}
    else{t.queue=t.queue.filter(x=>x.versionId!==q.versionId);for(const later of t.queue)if(later.summaryId===q.summaryId&&later.state==='queued')later.baseRevision=result.revision;
     if(r.localRevision===q.localRevision)r.syncState='synced';}
    return t;});completed++;
   }catch(error){await update(t=>{const entry=t.queue.find(x=>x.versionId===q.versionId);if(entry){entry.state='unknown';entry.attempts++;entry.dueAt=now()+[5,30,120,900][Math.min(entry.attempts-1,3)];
    entry.error=typeof error.code==='string'&&/^[a-z0-9_]{1,80}$/.test(error.code)?error.code:'sync_unavailable';}return t;});
    return{state:'error',completed,retryScheduled:true};}
  }
  return{state:'checked',completed};
 }
 async function pull({summaryId}){const c=current(),s=await read();if(!c||c.endpoint!==s.preference.endpoint)throw failure('matching_binding_required');
  const check=connectionGuard(c),remote=await c.client.get({summaryId});check();if(!remote.current?.content?.fragments||remote.current.sourcesTemporarilyUnavailable||remote.conflicts?.some(v=>v.sourcesTemporarilyUnavailable))return remote;
  await update(t=>{const local=t.summaries[summaryId];if(local&&(t.queue.some(q=>q.summaryId===summaryId)||local.syncState==='local')){
   local.remoteCurrent=clone(remote.current);local.conflicts=clone(remote.conflicts??[]);local.cloudRevision=remote.revision;local.syncState='conflict';return t;}
   t.summaries[summaryId]={summaryId,roomId:remote.roomId,endpoint:c.endpoint,content:clone(remote.current.content),createdAt:Date.parse(remote.current.updatedAt)/1000,updatedAt:now(),
    localRevision:(local?.localRevision??0)+1,cloudRevision:remote.revision,syncState:'synced',conflicts:clone(remote.conflicts??[])};return t;});return remote;
 }
 async function resolve({summaryId,expectedLocalRevision,content},{confirmed=false}={}){if(!confirmed)throw failure('summary_resolution_choice_required');
  const parsed=summaryContentSchema.parse(content);
  const state=await update(t=>{const r=t.summaries[summaryId];if(!r)throw failure('summary_missing');
   if(r.localRevision!==expectedLocalRevision)throw failure('local_summary_conflict');
   // A lost receipt may already have committed. Resolve it before replacing its
   // stable operation; an editor choice cannot cancel an in-flight upload.
   if(t.queue.some(q=>q.summaryId===summaryId&&['unknown','sending'].includes(q.state)))throw failure('summary_original_receipt_required');
   const next={...r,content:clone(parsed),localRevision:r.localRevision+1,updatedAt:now(),syncState:'local'};
   t.summaries[summaryId]=next;t.queue=t.queue.filter(q=>q.summaryId!==summaryId);
   if(allowed(t.preference,next)){const q=queueRecord(next);q.resolveVersionIds=(r.conflicts??[]).map(v=>v.versionId);t.queue.push(q);next.syncState='queued';}return t;});
  return clone(state.summaries[summaryId]);}
 async function deleteCloud({summaryId},{confirmed=false}={}){if(!confirmed)throw failure('summary_delete_choice_required');const c=current(),s=await read();if(!c||c.endpoint!==s.preference.endpoint)throw failure('matching_binding_required');
  const check=connectionGuard(c),remote=await c.client.get({summaryId});check();const receipt=await c.client.delete({summaryId,expectedRevision:remote.revision});check();
  await update(t=>{t.queue=t.queue.filter(q=>q.summaryId!==summaryId);if(t.summaries[summaryId]){t.summaries[summaryId].syncState='cloud-deleted';t.summaries[summaryId].cloudRevision=remote.revision+1;}return t;});return receipt;}
 async function onBinding(){const c=current();if(!c)return{state:'local'};const before=await read();
  if(before.preference.state==='declined'&&!before.preference.endpoint)await update(t=>{t.preference.endpoint=c.endpoint;t.preference.needsPreferenceSync=true;return t;});
  if(before.preference.state!=='unset')return synchronize();
  validOrigin(c.endpoint);const check=connectionGuard(c),p=await c.client.preferences();check();if(!p.revision)return{state:'unset',promptNeeded:true};
  await update(t=>{if(t.preference.state!=='unset')return t;t.preference={state:p.enabled?'enabled':'declined',endpoint:c.endpoint,roomIds:p.roomIds,
   includeExisting:p.includeExisting,selectedAt:Date.parse(p.enabledSince)/1000,cloudRevision:p.revision,needsPreferenceSync:false};
   if(p.enabled)for(const r of Object.values(t.summaries))if(allowed(t.preference,r))t.queue.push(queueRecord(r));return t;});
  return status();
 }
 return Object.freeze({choose,save,get,list,status,synchronize,pull,resolve,deleteCloud,onBinding});
}
