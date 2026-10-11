import {sha256Hex,stableJson} from '../../galaxy-official/src/shared/web-primitives.mjs';
import {choicePutIntent,choiceReceiptQuerySchema,choiceReceiptResultSchema} from '../../galaxy-official/src/shared/choice-snapshot-schema-v2.mjs';
const copy=x=>structuredClone(x),key=r=>`${r.type}:${r.id}:${r.version}`;
/** @param {any} runtime @param {{subjectId:string}} options */
export function createChoiceSyncClient(runtime,{subjectId}){
 let closed=false,serial=Promise.resolve(),endpoint=runtime.api.endpoint??null;
 const retainedCheck=lease=>{if(closed)throw new Error('choice_client_closed');lease.runtimeLease.assertCurrent();
  if(lease.subjectId!==subjectId||lease.endpoint!==endpoint||runtime.api.endpoint!==endpoint)throw new Error('choice_identity_changed');};
 const retainedLease=()=>{if(closed)throw new Error('choice_client_closed');
  if(typeof runtime.receiptStatus?.captureLease!=='function')throw new Error('choice_retained_runtime_lease_unavailable');
  const runtimeLease=runtime.receiptStatus.captureLease();
  if(!runtimeLease||typeof runtimeLease.assertCurrent!=='function'||runtimeLease.subjectId!==subjectId)throw new Error('choice_identity_changed');
  endpoint??=runtimeLease.endpoint;
  const lease={subjectId,endpoint:runtimeLease.endpoint,bindingId:runtimeLease.bindingId,generation:runtimeLease.generation,retained:true,runtimeLease};
  retainedCheck(lease);return lease;};
 const current=async()=>{if(closed)throw new Error('choice_client_closed');const s=await runtime.status();
  if(closed||s.identity?.subjectId!==subjectId)throw new Error('choice_identity_changed');
  const lease={subjectId,endpoint:s.endpoint??runtime.api.endpoint??null,bindingId:s.connection?.bindingId??null,generation:s.connection?.generation??null};
  endpoint??=lease.endpoint;if(endpoint!==lease.endpoint)throw new Error('choice_connection_changed');return lease;};
 const check=async lease=>{if(lease.retained){retainedCheck(lease);return;}const now=await current();if(Object.keys(lease).some(k=>lease[k]!==now[k]))throw new Error('choice_connection_changed');};
 const guarded=async(lease,fn)=>{await check(lease);if(lease.retained)retainedCheck(lease);let value;try{value=await fn();}catch(error){await check(lease);throw error;}await check(lease);return value;};
 const read=(lease,name)=>guarded(lease,()=>runtime.getLocal(name));
 const write=(lease,name,value)=>guarded(lease,()=>runtime.putLocal(name,value));
 const call=(lease,method,input={})=>guarded(lease,()=>runtime.api.call('/v2/choice-snapshots/'+method,input,{authenticated:true}));
 const state=async lease=>await read(lease,'choice-cloud-v2')??{schemaVersion:2,heads:{},pending:{},restored:{}};
 /** @template T @param {(lease:any)=>Promise<T>} fn */
 const run=fn=>{const pending=current().then(lease=>({lease}),error=>({error})),result=serial.then(async()=>{const selected=await pending;if(selected.error)throw selected.error;
  await check(selected.lease);const value=await fn(selected.lease);await check(selected.lease);return value;});
  serial=result.then(()=>{},()=>{});return result;};
 // Capture the actual device/lifecycle before entering the common journal
 // queue. Ordinary connection state and any sync preference are irrelevant.
 const runRetained=fn=>{let lease;try{lease=retainedLease();}catch(error){return Promise.reject(error);}
  const result=serial.then(async()=>{retainedCheck(lease);const value=await fn(lease);retainedCheck(lease);return value;});
  serial=result.then(()=>{},()=>{});return result;};
 const remember=async(lease,snapshot)=>{const s=await state(lease);s.heads[snapshot.snapshotId]={revision:snapshot.revision,snapshot:copy(snapshot)};await write(lease,'choice-cloud-v2',s);return snapshot;};
 const originalLocator=async(lease,request)=>({snapshotId:request.snapshotId,versionId:request.versionId,
  requestHash:await guarded(lease,()=>sha256Hex(stableJson(choicePutIntent(request))))});
 const isOwner=(owner,lease)=>owner?.subjectId===lease.subjectId&&owner?.endpoint===lease.endpoint;
 const retainedDirectory=async lease=>{
  const s=await state(lease),items=new Map(),owner={subjectId:lease.subjectId,endpoint:lease.endpoint};
  const add=(query,originalState,location)=>{const parsed=choiceReceiptQuerySchema.parse(query),prior=items.get(parsed.versionId);
   if(prior&&(prior.snapshotId!==parsed.snapshotId||prior.requestHash!==parsed.requestHash))throw new Error('choice_original_operation_changed');
   if(!prior)items.set(parsed.versionId,{...parsed,owner:{...owner},originalState,location});};
  for(const [id,request]of Object.entries(s.pending??{})){
   if(request.snapshotId!==id)throw new Error('choice_original_operation_changed');
   // Older requests lived solely in the runtime's owner+endpoint journal. New
   // requests additionally keep explicit owner metadata outside signed bytes.
   const savedOwner=s.pendingOwners?.[request.versionId];
   if(savedOwner&&!isOwner(savedOwner,lease))throw new Error('choice_original_owner_mismatch');
   add(await originalLocator(lease,request),'local-pending','pending');
  }
  for(const [versionId,stopped]of Object.entries(s.stoppedVersions??{})){
   if(!isOwner(stopped.owner,lease))continue;
   if(stopped.versionId!==versionId)throw new Error('choice_original_operation_changed');
   add({snapshotId:stopped.snapshotId,versionId,requestHash:stopped.requestHash},
    ['acknowledged','absent','conflict'].includes(stopped.state)?stopped.state:'unknown','stopped');
  }
  for(const [versionId,prior]of Object.entries(s.operationReceipts??{})){
   if(!isOwner(prior.owner,lease))continue;
   const receipt=choiceReceiptResultSchema.parse(prior.receipt);
   if(receipt.versionId!==versionId)throw new Error('choice_original_operation_changed');
   add({snapshotId:receipt.snapshotId,versionId,requestHash:receipt.requestHash},receipt.state,'receipt');
  }
  retainedCheck(lease);return[...items.values()].sort((a,b)=>a.snapshotId.localeCompare(b.snapshotId)||a.versionId.localeCompare(b.versionId));
 };
 const receipt=async(lease,query)=>{const result=choiceReceiptResultSchema.parse(await call(lease,'receipt',choiceReceiptQuerySchema.parse(query)));
  if(Object.keys(query).some(k=>query[k]!==result[k]))throw new Error('choice_original_receipt_mismatch');return result;};
 const acceptReceipt=async(lease,result)=>{
  if(result.state!=='acknowledged')return result;
  const s=await state(lease),id=result.snapshotId,request=s.pending[id],stopped=s.stoppedVersions?.[result.versionId];
  if(request?.versionId===result.versionId){const savedOwner=s.pendingOwners?.[request.versionId];
   if(savedOwner&&!isOwner(savedOwner,lease))throw new Error('choice_original_owner_mismatch');
   const query=await originalLocator(lease,request);if(query.requestHash!==result.requestHash)throw new Error('choice_original_operation_changed');
   // This marker prevents a duplicate unchanged local intent. It is historical
   // acceptance, separate from the current cloud head and its source access.
   s.acceptedLocalHashes??={};if(s.pendingLocalHashes?.[id])s.acceptedLocalHashes[`${id}:${s.pendingLocalHashes[id]}`]=result.versionId;
   delete s.pending[id];if(s.pendingLocalHashes)delete s.pendingLocalHashes[id];
   if(s.pendingOwners)delete s.pendingOwners[result.versionId];
  }
  if(stopped){if(stopped.snapshotId!==id||stopped.requestHash!==result.requestHash||stopped.owner?.subjectId!==lease.subjectId||stopped.owner?.endpoint!==lease.endpoint)throw new Error('choice_original_operation_changed');
   s.stoppedVersions[result.versionId]={...stopped,state:'acknowledged',receipt:copy(result)};}
  s.operationReceipts??={};s.operationReceipts[result.versionId]={owner:{subjectId:lease.subjectId,endpoint:lease.endpoint},receipt:copy(result)};
  await write(lease,'choice-cloud-v2',s);return result;
 };
 const stopPending=async(lease,s,id)=>{const request=s.pending[id];if(!request)return null;
  // The strict schema has only JSON strings, arrays and finite integers.
  // stableJson matches the server canonical intent; witnesses and preference
  // revision do not belong to that immutable business hash.
  const {requestHash}=await originalLocator(lease,request),prior=s.stoppedVersions?.[request.versionId];
  if(prior&&(prior.requestHash!==requestHash||prior.snapshotId!==id))throw new Error('choice_original_operation_changed');
  const locator=prior??{snapshotId:id,versionId:request.versionId,requestHash,owner:{subjectId:lease.subjectId,endpoint:lease.endpoint},
   state:'unknown',localRetryStopped:true,serverCancellationConfirmed:false,stoppedAt:new Date().toISOString()};
  s.stoppedVersions??={};s.stoppedVersions[request.versionId]=locator;delete s.pending[id];if(s.pendingLocalHashes)delete s.pendingLocalHashes[id];return locator;};
 return{
  preferences:()=>run(lease=>call(lease,'preferences/read')),
  savePreference:input=>run(lease=>call(lease,'preferences/save',input)),
  list:(input={})=>run(async lease=>{const page=await call(lease,'list',input);for(const item of page.items)await remember(lease,item);return page;}),
  get:id=>run(async lease=>remember(lease,await call(lease,'get',{snapshotId:id}))),
  localState:()=>run(state),
  localPreview:id=>run(async lease=>{const local=await read(lease,'help-choices-v2'),choice=local?.choices.find(c=>c.id===id);if(!choice)throw new Error('choice_local_missing');return copy(choice.versions.at(-1));}),
  /** @param {string} id @param {{resolveVersionIds?:string[],expectedLocalHash?:string,expectedPendingVersionId?:string}} options */
  sync(id,{resolveVersionIds=[],expectedLocalHash,expectedPendingVersionId}={}){return run(async lease=>{
   const s=await state(lease),existing=s.pending[id];let request=existing;
   if(expectedPendingVersionId&&existing?.versionId!==expectedPendingVersionId)throw new Error('choice_sync_preview_changed');
   if(expectedLocalHash&&existing)throw new Error('choice_sync_preview_changed');
   let p=await call(lease,'preferences/read');if(!p.enabled||!p.snapshotIds.includes(id))throw new Error('choice_sync_not_selected');
   if(existing){
    const original=await receipt(lease,await originalLocator(lease,existing));
    if(original.state==='conflict')throw new Error('choice_original_operation_conflict');
    if(original.state==='acknowledged'){await acceptReceipt(lease,original);const current=await remember(lease,await call(lease,'get',{snapshotId:id}));
     return{...current,operationVersionId:original.versionId,operationReceipt:original,replayed:true};}
    // Only the exact original absent receipt permits this explicit retry.
    // Recheck independently selected sync scope after the network await.
    p=await call(lease,'preferences/read');if(!p.enabled||!p.snapshotIds.includes(id))throw new Error('choice_sync_not_selected');
   }
   if(!request){
    const local=await read(lease,'help-choices-v2'),current=local?.choices.find(c=>c.id===id)?.versions.at(-1);if(!current)throw new Error('choice_local_missing');
    if(expectedLocalHash&&current.hash!==expectedLocalHash)throw new Error('choice_sync_preview_changed');
    if((s.synced?.[`${id}:${current.hash}`]||s.acceptedLocalHashes?.[`${id}:${current.hash}`])&&!resolveVersionIds.length)return remember(lease,await call(lease,'get',{snapshotId:id}));
    const lookups=await read(lease,'help-choice-lookups-v2')??{},witnesses=current.candidateRefs.map(ref=>{const search=lookups[key(ref)];if(!search)throw new Error('choice_original_source_query_unavailable');return{search,ref:{id:ref.id,version:ref.version}};});
    const {localTaskRef,visibleRationale,rationaleAuthor,candidateRefs,selectedRefs,resultRefs}=current;
    const bases=await read(lease,'choice-cloud-bases-v2')??{};
    request={snapshotId:id,versionId:crypto.randomUUID(),baseRevision:bases[`${id}:${current.hash}`]??0,preferenceRevision:p.revision,
     content:{localVersion:current.version,localTaskRef,visibleRationale,rationaleAuthor,candidateRefs,selectedRefs,resultRefs},witnesses,resolveVersionIds};
   s.pending[id]=request;s.pendingLocalHashes??={};s.pendingLocalHashes[id]=current.hash;
   s.pendingOwners??={};s.pendingOwners[request.versionId]={subjectId:lease.subjectId,endpoint:lease.endpoint};await write(lease,'choice-cloud-v2',s);
   }
   // Explicit retry uses the currently selected category/range. Preference
   // revision is transport authorization, excluded from the original intent
   // hash; the business version, source witnesses and bytes stay unchanged.
   if(request.preferenceRevision!==p.revision){request={...request,preferenceRevision:p.revision};s.pending[id]=request;await write(lease,'choice-cloud-v2',s);}
   const result=await call(lease,'put',request);const latest=await state(lease);delete latest.pending[id];latest.synced??={};
   if(latest.pendingOwners)delete latest.pendingOwners[request.versionId];
   if(latest.pendingLocalHashes?.[id]){latest.synced[`${id}:${latest.pendingLocalHashes[id]}`]=result.operationVersionId;delete latest.pendingLocalHashes[id];}
   latest.heads[id]={revision:result.revision,snapshot:copy(result)};await write(lease,'choice-cloud-v2',latest);return result;
  });},
  // This remains read-only on the service after opt-out and local retry stop.
  // No current-head read, body restoration, preference update or put follows it.
  reconcile(id,{versionId}={}){return run(async lease=>{
   const s=await state(lease),request=s.pending[id];let query;
   if(request&&(!versionId||request.versionId===versionId))query=await originalLocator(lease,request);
   else{
    const stopped=versionId?s.stoppedVersions?.[versionId]:null;
    if(stopped){if(stopped.snapshotId!==id||stopped.owner?.subjectId!==lease.subjectId||stopped.owner?.endpoint!==lease.endpoint)throw new Error('choice_original_owner_mismatch');
     query=choiceReceiptQuerySchema.parse({snapshotId:id,versionId:stopped.versionId,requestHash:stopped.requestHash});}
    else{const prior=versionId?s.operationReceipts?.[versionId]:null;
     if(!prior||prior.owner?.subjectId!==lease.subjectId||prior.owner?.endpoint!==lease.endpoint||prior.receipt.snapshotId!==id)throw new Error('choice_original_operation_missing');
     query=choiceReceiptQuerySchema.parse({snapshotId:id,versionId,requestHash:prior.receipt.requestHash});}
   }
   return acceptReceipt(lease,await receipt(lease,query));
  });},
  // Explicit retained recovery is a separate user path. No ordinary API call,
  // preference/head/source read, connect or put is a fallback for this method.
  retainedReceiptOperations:()=>runRetained(retainedDirectory),
  reconcileRetained(snapshotId,{versionId}={}){return runRetained(async lease=>{
   const selected=choiceReceiptQuerySchema.pick({snapshotId:true,versionId:true}).parse({snapshotId,versionId});
   const row=(await retainedDirectory(lease)).find(item=>item.snapshotId===selected.snapshotId&&item.versionId===selected.versionId);
   if(!row)throw new Error('choice_original_operation_missing');
   const query=choiceReceiptQuerySchema.parse({snapshotId:row.snapshotId,versionId:row.versionId,requestHash:row.requestHash});
   const result=choiceReceiptResultSchema.parse(await guarded(lease,()=>runtime.receiptStatus.query({kind:'choice-snapshot',...query})));
   if(Object.keys(query).some(k=>query[k]!==result[k]))throw new Error('choice_original_receipt_mismatch');
   return acceptReceipt(lease,result);
  });},
  // Choosing a cloud alternative stores its actual payload in a separate local
  // branch. It never fabricates original queries or silently replaces a local draft.
  restore(id,versionId){return run(async lease=>{const snapshot=await call(lease,'get',{snapshotId:id}),v=[snapshot.current,...snapshot.conflicts].find(x=>x?.versionId===versionId);
   if(!v?.content?.visibleRationale||!['current','conflict'].includes(v.state))throw new Error('choice_cloud_content_unavailable');
   const s=await state(lease);s.restored[versionId]={snapshotId:id,versionId,content:copy(v.content),sourceStatus:copy(v.sourceStatus),restoredAt:new Date().toISOString(),hash:await guarded(lease,()=>sha256Hex(JSON.stringify(v.content)))};
   s.heads[id]={revision:snapshot.revision,snapshot:copy(snapshot)};await write(lease,'choice-cloud-v2',s);return copy(s.restored[versionId]);});},
  delete(id){return run(async lease=>{const s=await state(lease),head=s.heads[id];if(!head)throw new Error('choice_read_cloud_before_delete');
   const result=await call(lease,'delete',{snapshotId:id,expectedRevision:head.revision}),stoppedVersion=await stopPending(lease,s,id);
   delete s.heads[id];await write(lease,'choice-cloud-v2',s);return{...result,...(stoppedVersion?{stoppedVersion}:{})};});},
  discardPending(id){return run(async lease=>{const s=await state(lease);if(!s.pending[id])return;const actual=await call(lease,'get',{snapshotId:id});
   s.heads[id]={revision:actual.revision,snapshot:copy(actual)};const stoppedVersion=await stopPending(lease,s,id);await write(lease,'choice-cloud-v2',s);
   return{...actual,stoppedVersion,localRetryStopped:true,serverCancellationConfirmed:false};});},
  removeRestored(versionId){return run(async lease=>{const s=await state(lease);delete s.restored[versionId];await write(lease,'choice-cloud-v2',s);return s;});},
  close(){closed=true;}
 };
}
