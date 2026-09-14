import {sha256Hex} from '../../galaxy-official/src/shared/web-primitives.mjs';
const copy=x=>structuredClone(x),key=r=>`${r.type}:${r.id}:${r.version}`;
/** @param {any} runtime @param {{subjectId:string}} options */
export function createChoiceSyncClient(runtime,{subjectId}){
 let closed=false,serial=Promise.resolve();
 const guard=async()=>{if(closed)throw new Error('choice_client_closed');const s=await runtime.status();if(closed||s.identity?.subjectId!==subjectId)throw new Error('choice_identity_changed');return s;};
 const read=async name=>{await guard();const v=await runtime.getLocal(name);await guard();return v;};
 const write=async(name,v)=>{await guard();await runtime.putLocal(name,v);await guard();};
 const call=async(method,input={})=>{await guard();const result=await runtime.api.call('/v2/choice-snapshots/'+method,input,{authenticated:true});await guard();return result;};
 const state=async()=>await read('choice-cloud-v2')??{schemaVersion:2,heads:{},pending:{},restored:{}};
 /** @template T @param {()=>Promise<T>} fn */
 const run=fn=>{const result=serial.then(fn);serial=result.then(()=>{},()=>{});return result;};
 const remember=async(snapshot)=>{const s=await state();s.heads[snapshot.snapshotId]={revision:snapshot.revision,snapshot:copy(snapshot)};await write('choice-cloud-v2',s);return snapshot;};
 return{
  preferences:()=>call('preferences/read'),
  savePreference:input=>call('preferences/save',input),
  async list(input={}){const page=await call('list',input);for(const item of page.items)await remember(item);return page;},
  get:id=>run(async()=>remember(await call('get',{snapshotId:id}))),
  localState:state,
  async localPreview(id){const local=await read('help-choices-v2'),choice=local?.choices.find(c=>c.id===id);if(!choice)throw new Error('choice_local_missing');return copy(choice.versions.at(-1));},
  /** @param {string} id @param {{resolveVersionIds?:string[]}} options */
  sync(id,{resolveVersionIds=[]}={}){return run(async()=>{
   const s=await state(),existing=s.pending[id];let request=existing;
   if(!request){
    const local=await read('help-choices-v2'),current=local?.choices.find(c=>c.id===id)?.versions.at(-1);if(!current)throw new Error('choice_local_missing');
    if(s.synced?.[`${id}:${current.hash}`]&&!resolveVersionIds.length)return remember(await call('get',{snapshotId:id}));
    const p=await call('preferences/read');if(!p.enabled||!p.snapshotIds.includes(id))throw new Error('choice_sync_not_selected');
    const lookups=await read('help-choice-lookups-v2')??{},witnesses=current.candidateRefs.map(ref=>{const search=lookups[key(ref)];if(!search)throw new Error('choice_original_source_query_unavailable');return{search,ref:{id:ref.id,version:ref.version}};});
    const {localTaskRef,visibleRationale,rationaleAuthor,candidateRefs,selectedRefs,resultRefs}=current;
    const bases=await read('choice-cloud-bases-v2')??{};
    request={snapshotId:id,versionId:crypto.randomUUID(),baseRevision:bases[`${id}:${current.hash}`]??0,preferenceRevision:p.revision,
     content:{localVersion:current.version,localTaskRef,visibleRationale,rationaleAuthor,candidateRefs,selectedRefs,resultRefs},witnesses,resolveVersionIds};
    s.pending[id]=request;s.pendingLocalHashes??={};s.pendingLocalHashes[id]=current.hash;await write('choice-cloud-v2',s);
   }
   const result=await call('put',request);const latest=await state();delete latest.pending[id];latest.synced??={};
   if(latest.pendingLocalHashes?.[id]){latest.synced[`${id}:${latest.pendingLocalHashes[id]}`]=result.operationVersionId;delete latest.pendingLocalHashes[id];}
   latest.heads[id]={revision:result.revision,snapshot:copy(result)};await write('choice-cloud-v2',latest);return result;
  });},
  // Choosing a cloud alternative stores its actual payload in a separate local
  // branch. It never fabricates original queries or silently replaces a local draft.
  restore(id,versionId){return run(async()=>{const snapshot=await call('get',{snapshotId:id}),v=[snapshot.current,...snapshot.conflicts].find(x=>x?.versionId===versionId);
   if(!v?.content?.visibleRationale||!['current','conflict'].includes(v.state))throw new Error('choice_cloud_content_unavailable');
   const s=await state();s.restored[versionId]={snapshotId:id,versionId,content:copy(v.content),sourceStatus:copy(v.sourceStatus),restoredAt:new Date().toISOString(),hash:await sha256Hex(JSON.stringify(v.content))};
   s.heads[id]={revision:snapshot.revision,snapshot:copy(snapshot)};await write('choice-cloud-v2',s);return copy(s.restored[versionId]);});},
  delete(id){return run(async()=>{const s=await state(),head=s.heads[id];if(!head)throw new Error('choice_read_cloud_before_delete');
   const result=await call('delete',{snapshotId:id,expectedRevision:head.revision});delete s.heads[id];delete s.pending[id];await write('choice-cloud-v2',s);return result;});},
  discardPending(id){return run(async()=>{const s=await state();if(!s.pending[id])return;const actual=await call('get',{snapshotId:id});
   s.heads[id]={revision:actual.revision,snapshot:copy(actual)};delete s.pending[id];await write('choice-cloud-v2',s);return actual;});},
  removeRestored(versionId){return run(async()=>{const s=await state();delete s.restored[versionId];await write('choice-cloud-v2',s);return s;});},
  close(){closed=true;}
 };
}
