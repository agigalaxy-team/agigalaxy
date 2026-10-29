import {builderEventSchema} from "../../../../galaxy-contracts/src/builders-schema.mjs";
import {builderExtensionEventSchema} from "../../../../galaxy-contracts/src/builder-support-v2-schema.mjs";
import {equalJson,sha256Hex} from "../../../../galaxy-contracts/src/web-primitives.mjs";
const extensions=new Set(['support-profile','pack-manifest','scope-report']),copy=value=>structuredClone(value);
const error=(code,message)=>Object.assign(new Error(message),{code});
export function createBuildersWebClient(runtime,{subjectId=/** @type {string|null} */(null),now=()=>Math.floor(Date.now()/1000),locks=globalThis.navigator?.locks}={}){
 const api=runtime.api,endpoint=api.endpoint,key='builder-web-v2:'+endpoint+':'+subjectId,legacyKey='builder-web-v2:'+subjectId,previews=new WeakMap();let queue=Promise.resolve();
 const stamp=()=>{const s=api.snapshot();return JSON.stringify([api.endpoint,s?.subjectId??null,s?.bindingId??null,s?.generation??null,s?.control?.deviceId??null,s?.control?.keyId??null,s?.control?.epoch??null]);};
 function capture(authenticated=true){
  const tag=stamp(),reference=authenticated?runtime.receiptStatus?.captureLease?.():null;
  if(reference&&(reference.endpoint!==endpoint||reference.subjectId!==subjectId))throw error('builder_authority_changed','身份或连接已变化，请重新连接并核对原操作。');
  const check=()=>{reference?.assertCurrent();if(api.endpoint!==endpoint||stamp()!==tag||authenticated&&(!subjectId||api.snapshot()?.subjectId!==subjectId))throw error('builder_authority_changed','身份或连接已变化，请重新连接并核对原操作。');};
  check();return{check,bindingId:api.snapshot()?.bindingId??null};
 }
 async function guard(lease,action){lease.check();let value;try{value=await action();}catch(caught){lease.check();throw caught;}lease.check();return value;}
 const serial=fn=>{let lease;try{lease=capture();}catch(caught){return Promise.reject(caught);}const invoke=()=>guard(lease,()=>fn(lease)),run=()=>locks?.request?locks.request('builder-journal:'+endpoint+':'+subjectId,{mode:'exclusive'},invoke):invoke();
  const next=queue.then(run,run);queue=next.catch(()=>{});return next;};
 const get=(name,lease)=>guard(lease,()=>runtime.getLocal(name,subjectId));
 const update=(lease,change)=>guard(lease,()=>{if(typeof runtime.updateLocal!=='function')throw error('local_atomic_update_unavailable','当前本机存储不能安全保存原操作。');
  return runtime.updateLocal(key,value=>{lease.check();return change(value??{pending:null});},subjectId);});
 async function load(lease){
  const current=await get(key,lease);if(current)return current;
  const legacy=await get(legacyKey,lease);if(!legacy?.pending)return{pending:null};
  if(legacy.pending.prepared?.endpoint!==endpoint||legacy.pending.prepared?.intent?.subjectId!==subjectId)throw error('builder_legacy_authority_unknown','旧操作尚未绑定当前服务，请保留原记录核对。');
  // Preserve the old key and exact payload/signature bytes. An unaccepted
  // legacy record requires an explicit retry, never an automatic new intent.
  return update(lease,value=>value.pending||value.stoppedOperations?.length?value:{...copy(legacy),...value,pending:{...copy(legacy.pending),legacy:true}});
 }
 const locatorFor=record=>({endpoint,ownerId:subjectId,builderId:record.event.builderId,eventId:record.event.id,payloadHash:record.payloadHash,kind:record.event.kind});
 const matches=(record,locator)=>!!record&&record.event.builderId===locator.builderId&&record.event.id===locator.eventId&&record.payloadHash===locator.payloadHash;
 function locator(input){
  if(!input||input.endpoint!==endpoint||input.ownerId!==subjectId||!input.builderId||!input.eventId||!/^[a-f0-9]{64}$/.test(input.payloadHash)||input.kind!==undefined&&typeof input.kind!=='string')throw error('builder_locator_mismatch','原操作定位信息不属于当前主体与服务。');return copy(input);
 }
 async function exact(record,lease){
  const extension=extensions.has(record.event?.kind),parsed=(extension?builderExtensionEventSchema:builderEventSchema).parse(record.event);
  if(!equalJson(parsed,JSON.parse(record.payloadJson))||!equalJson(parsed,record.event)||record.path!==(extension?'/v2/builders/support/events':'/v1/builders/events')
   ||await guard(lease,()=>sha256Hex(record.payloadJson))!==record.payloadHash||!['Private','Public'].includes(record.visibility)||!Array.isArray(record.viewers))throw error('builder_original_changed','本机原操作内容已变化，不能重发。');
  const intent=record.prepared?.intent;
  if(record.prepared&&(record.prepared.endpoint!==endpoint||intent?.endpoint!==endpoint||intent.subjectId!==subjectId||intent.action!=='builder.publish'||intent.objectId!==record.event.id||intent.recipient!==endpoint
   ||intent.purpose!==(record.visibility==='Public'?'public-profile':'operational')||record.prepared.payloadJson!==record.payloadJson||intent.payloadHash!==record.payloadHash||intent.visibility!==record.visibility
   ||!equalJson(intent.viewers,record.viewers)||!equalJson(intent.fields,Object.keys(JSON.parse(record.payloadJson)))||record.authorizationExpiresAt!==undefined&&record.authorizationExpiresAt!==intent.expiresAt))throw error('builder_original_changed','原操作的内容或可见范围与保存授权不一致。');
  if(record.submission&&(!record.prepared||record.submission.payloadJson!==record.payloadJson||record.submission.consentId!==intent.id))throw error('builder_original_changed','原操作提交与保存授权不一致。');
  return{deadline:record.authorizationExpiresAt??intent?.expiresAt??null,bindingId:record.authorizationBindingId??intent?.bindingId??null};
 }
 async function replace(lease,original,change){
  let saved;await update(lease,value=>{if(!equalJson(value.pending,original))throw error('builder_operation_changed','原操作已在另一页改变，请读取当前记录。');
   if(value.stoppedOperations?.some(item=>item.eventId===original.event.id))throw error('builder_operation_stopped','这次本机发送已经停止。原记录仍可查询。');
   saved={...original,...change,journalRevision:(original.journalRevision??0)+1};return{...value,pending:saved};});return copy(saved);
 }
 const call=(lease,path,input,authenticated=true)=>guard(lease,()=>api.call(path,input,{authenticated}));
 const read=(path,input,authenticated)=>call(capture(authenticated),path,input,authenticated);
 async function receiptWithin(input,lease){
  const selected=locator(input),r=await call(lease,'/v1/builders/events/receipt',{builderId:selected.builderId,eventId:selected.eventId,payloadHash:selected.payloadHash});
  if(r.builderId!==selected.builderId||r.eventId!==selected.eventId||r.payloadHash!==selected.payloadHash||!['acknowledged','absent','conflict'].includes(r.state))throw error('builder_receipt_mismatch','原操作回执尚未确定或不匹配，请保留记录。');
  if(r.state==='conflict')throw error('builder_receipt_conflict','原操作标识对应不同内容，不能覆盖。');return{...r,locator:selected};
 }
 async function acknowledge(lease,record,receipt){
  const selected=locatorFor(record),result={...receipt,state:'acknowledged',locator:selected};
  // Late ACK settles only the exact original and never revives a stopped
  // record or clears a different operation from another page.
  await update(lease,value=>({...value,...(matches(value.pending,selected)?{pending:null}:{}),lastReceipt:result}));return result;
 }
 async function blocked(lease,record,reason,caught=null){
  const businessFailure=caught?{code:caught.code??'request_failed',status:caught.status??null}:record.businessFailure;
  if(record.blockedReason===reason&&equalJson(record.businessFailure,businessFailure))return{state:'unconfirmed',reason,locator:locatorFor(record)};
  const saved=await replace(lease,record,{blockedReason:reason,...(caught?{businessFailure}:{})});
  return{state:'unconfirmed',reason,locator:locatorFor(saved)};
 }
 const unavailable=caught=>['consent_receipt_not_active_or_mismatched','consent_reauthorization_required','consent_unavailable','binding_unavailable'].includes(caught?.code);
 const businessRejected=caught=>caught?.outcome==='rejected'&&Number.isInteger(caught.status)&&caught.status>=400&&caught.status<500
  &&![401,408,429].includes(caught.status)&&!['unauthorized','binding_revoked','binding_unavailable','invalid_session','session_expired','access_denied',
   'authorization_changed','session_generation_changed','consent_receipt_not_active_or_mismatched','consent_reauthorization_required','consent_unavailable',
   'consent_required','consent_scope_required','disclosure_mismatch','browser_origin_not_enabled','browser_preflight_denied','identity_control_stale'].includes(caught.code);
 async function availability(lease,record){
  const original=await exact(record,lease);
  let accepted=null,authorizationUnavailable=false;
  if(record.prepared)try{
   accepted=await guard(lease,()=>api.reconcileAuthorization(record.prepared));
   if(accepted.state==='acknowledged'){if(accepted.consentId!==record.prepared.intent.id||accepted.payloadJson!==record.payloadJson)throw error('builder_original_changed','原授权回执与保存内容不一致。');}
   else if(accepted.state!=='absent')throw error('builder_receipt_mismatch','原授权结果尚未确定。');
  }catch(caught){if(!unavailable(caught))throw caught;authorizationUnavailable=true;}
  if(original.bindingId!==lease.bindingId)return{reason:original.bindingId?'original-binding-changed':'original-binding-unavailable'};
  if(!Number.isSafeInteger(original.deadline))return{reason:'original-deadline-unavailable'};
  if(original.deadline<=now())return{reason:'authorization-expired'};
  if(!record.prepared)return record.intentConfirmed===true?{state:'ready'}:{reason:'original-authorization-unavailable'};
  if(authorizationUnavailable)return{reason:'authorization-unavailable'};
  return accepted.state==='acknowledged'?{state:'ready',submission:{consentId:accepted.consentId,payloadJson:record.payloadJson}}
   :record.prepared.intent.issuedAt<now()-300?{reason:'original-signature-expired'}:{state:'ready'};
 }
 async function send(record,lease){
  await exact(record,lease);
  if(!record.prepared){const prepared=await guard(lease,()=>api.prepareAuthorization(record.payloadJson,{action:'builder.publish',objectId:record.event.id,visibility:record.visibility,viewers:record.viewers,expiresAt:record.authorizationExpiresAt,confirmed:true}));
   record=await replace(lease,record,{prepared,authorizationBindingId:prepared.intent.bindingId});}
  if(!record.submission){
   const reconcile=record.authorizationAttempted===true;record=await replace(lease,record,{authorizationAttempted:true});
   try{const submission=await guard(lease,()=>api.submitAuthorization(record.prepared,{confirmed:true,reconcile}));record=await replace(lease,record,{submission});}
   catch(caught){if(unavailable(caught))await blocked(lease,record,'authorization-unavailable');throw caught;}
  }
  await exact(record,lease);record=await replace(lease,record,{attempted:true});let receipt;
  try{receipt=await call(lease,record.path,record.submission);}
  catch(caught){if(businessRejected(caught))await blocked(lease,record,'business-declined',caught);throw caught;}
  if(receipt.builderId!==record.event.builderId||receipt.eventId!==record.event.id)throw error('builder_receipt_mismatch','回执与原操作不匹配。');
  return acknowledge(lease,record,{...receipt,payloadHash:record.payloadHash});
 }
 async function resume(lease,{explicitRetry=false}={}){
  let record=(await load(lease)).pending;if(!record)return{state:'none'};await exact(record,lease);
  const receipt=await receiptWithin(locatorFor(record),lease);if(receipt.state==='acknowledged')return acknowledge(lease,record,receipt);
  if(record.legacy&&!explicitRetry)return blocked(lease,record,'legacy-explicit-retry-required');
  if(record.businessFailure&&!explicitRetry)return{state:'unconfirmed',reason:'business-declined',locator:locatorFor(record)};
  const authorized=await availability(lease,record);if(authorized.reason)return blocked(lease,record,authorized.reason);
  if(authorized.submission&&!equalJson(authorized.submission,record.submission))record=await replace(lease,record,{submission:authorized.submission});
  record=await replace(lease,record,{blockedReason:null,...(explicitRetry?{businessFailure:null}:{})});return send(record,lease);
 }
 async function review(lease){
  let record=(await load(lease)).pending;if(!record)return{state:'none'};
  const original=await exact(record,lease),receipt=await receiptWithin(locatorFor(record),lease);if(receipt.state==='acknowledged')return acknowledge(lease,record,receipt);
  const authorized=await availability(lease,record);if(!authorized.reason)return{state:'ready',locator:locatorFor(record)};
  if(record.blockedReason!==authorized.reason)record=await replace(lease,record,{blockedReason:authorized.reason});
  const preview={state:'reauthorization-required',locator:locatorFor(record),event:copy(record.event),visibility:record.visibility,viewers:copy(record.viewers),
   originalBindingId:original.bindingId,currentBindingId:lease.bindingId,originalExpiresAt:original.deadline,expiresAt:original.deadline>now()?original.deadline:now()+2591900,reason:authorized.reason};
  previews.set(preview,{lease,record:copy(record),exact:JSON.stringify(preview)});return preview;
 }
 return{
  local:()=>serial(load),
  query:(input={},authenticated=false)=>read('/v1/builders/query',input,authenticated),
  read:async(builderId,authenticated=false)=>{const lease=capture(authenticated);for(let attempt=0;attempt<2;attempt++){
   const entry=await call(lease,'/v1/builders/read',{builderId},authenticated),extensions=await call(lease,'/v2/builders/support/read',{builderId},authenticated);
   if(['builderId','declarationId','declarationHash','revision'].every(field=>entry[field]===extensions[field]))return{entry,extensions};
  }throw error('builder_current_changed','这份资料刚有更新，请重新读取当前内容。');},
  owned:input=>read('/v1/builders/owned/query',input??{},true),
  manage:builderId=>read('/v1/builders/manage/read',{builderId},true),
  exportPack:(builderId,manifestId,authenticated=false)=>read('/v2/builders/pack/export',{builderId,manifestId},authenticated),
  submit:(input,{visibility='Private',viewers=/** @type {string[]} */([]),confirmed=false,onJournal=/** @type {null|((locator:import('./builder-authoring-state.ts').BuilderLocator)=>unknown)} */(null)}={})=>{
   const intent=copy(input),selected=copy(viewers);return serial(async lease=>{
    if(!confirmed)throw Error('请先核对内容和可见范围。');await load(lease);
    const extension=extensions.has(intent.kind),event=(extension?builderExtensionEventSchema:builderEventSchema).parse(intent),payloadJson=JSON.stringify(event),payloadHash=await guard(lease,()=>sha256Hex(payloadJson));
    const record={event,payloadJson,payloadHash,path:extension?'/v2/builders/support/events':'/v1/builders/events',visibility,viewers:selected,intentConfirmed:true,
     authorizationBindingId:lease.bindingId,authorizationExpiresAt:now()+2591900,journalRevision:1};await exact(record,lease);
    await update(lease,value=>{if(value.pending)throw error('builder_operation_pending','上一次内容正在接续，请先读取原结果。');if(value.stoppedOperations?.some(item=>item.eventId===event.id))throw error('builder_operation_stopped','这次本机发送已经停止，请保留原记录查询。');return{...value,pending:record};});
    if(onJournal)await guard(lease,()=>onJournal(locatorFor(record)));return send(record,lease);
   });
  },
  receiptFor:input=>{const selected=copy(input);return serial(lease=>receiptWithin(selected,lease));},
  resumePending:({explicitRetry=false}={})=>serial(lease=>resume(lease,{explicitRetry})),
  reconcile:({retry=false,confirmed=false}={})=>serial(async lease=>{
   const record=(await load(lease)).pending;if(!record)return{state:'none'};await exact(record,lease);const receipt=await receiptWithin(locatorFor(record),lease);
   if(receipt.state==='acknowledged')return acknowledge(lease,record,receipt);if(!retry)return receipt;if(!confirmed)throw Error('请确认仅重试原操作。');return resume(lease,{explicitRetry:true});
  }),
  reviewAuthorization:()=>serial(review),
  reauthorize:(preview,{confirmed=false}={})=>serial(async lease=>{
   const token=previews.get(preview);if(!confirmed||!token||token.exact!==JSON.stringify(preview))throw Error('请先查看并确认原建设者内容与授权范围。');token.lease.check();
   let record=(await load(lease)).pending;if(!equalJson(record,token.record))throw error('builder_operation_changed','原操作已改变，请重新读取预览。');await exact(record,lease);
   const receipt=await receiptWithin(preview.locator,lease);if(receipt.state==='acknowledged')return acknowledge(lease,record,receipt);
   const current=await review(lease);if(current.state==='acknowledged')return current;if(current.state==='ready')return resume(lease,{explicitRetry:true});
   if(current.state!=='reauthorization-required'||!equalJson({...current,expiresAt:preview.expiresAt},preview)||preview.expiresAt<=now())throw error('builder_authorization_preview_changed','原授权预览已改变或到期，请重新读取。');
   const prepared=await guard(lease,()=>api.prepareAuthorization(record.payloadJson,{action:'builder.publish',objectId:record.event.id,visibility:record.visibility,viewers:record.viewers,expiresAt:preview.expiresAt,confirmed:true}));
   record=await replace(lease,record,{authorizationHistory:[...(record.authorizationHistory??[]),...(record.prepared?[record.prepared]:[])],prepared,submission:null,authorizationAttempted:false,
    authorizationBindingId:prepared.intent.bindingId,authorizationExpiresAt:preview.expiresAt,blockedReason:null,businessFailure:null});previews.delete(preview);return send(record,lease);
  }),
  discard:()=>serial(async lease=>{
   const record=(await load(lease)).pending;if(!record)return{state:'none'};await exact(record,lease);let receipt;
   try{receipt=await receiptWithin(locatorFor(record),lease);}catch(caught){lease.check();receipt={state:'unknown',reason:caught?.code??'receipt-unavailable'};}
   const stopped=locatorFor(record);
   await update(lease,value=>{if(!equalJson(value.pending,record))throw error('builder_operation_changed','原操作已在另一页改变，请读取当前记录.');
    return{...value,pending:null,stoppedOperations:[...(value.stoppedOperations??[]).filter(item=>item.eventId!==stopped.eventId),stopped],...(receipt.state==='acknowledged'?{lastReceipt:{...receipt,state:'acknowledged',locator:stopped}}:{})};});
   return{...stopped,state:'stopped',remoteState:receipt.state,localRetryStopped:true,remoteCancellationConfirmed:false};
  }),
  queryStopped:input=>{const selected=copy(input);return serial(async lease=>{locator(selected);const local=await load(lease),stopped=(local.stoppedOperations??[]).find(item=>item.builderId===selected.builderId&&item.eventId===selected.eventId&&item.payloadHash===selected.payloadHash);
   if(!stopped)throw Error('本机没有这次原操作定位，请保留原记录核对。');return receiptWithin(stopped,lease);});},
 };
}
