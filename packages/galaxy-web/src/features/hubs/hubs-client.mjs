import {hubEventSchema} from "../../../../galaxy-official/src/shared/hubs-v2-schema.mjs";
import {peeringEventSchema} from "../../../../galaxy-official/src/shared/hub-peering-v2-schema.mjs";
import {equalJson,sha256Hex} from "../../../../galaxy-official/src/shared/web-primitives.mjs";
const copy=value=>structuredClone(value);
const error=(code,message)=>Object.assign(new Error(message),{code});
export function createHubsWebClient(runtime,{subjectId=/** @type {string|null} */(null),now=()=>Math.floor(Date.now()/1000),locks=globalThis.navigator?.locks}={}){
 const api=runtime.api,endpoint=api.endpoint,key='hubs-v2:'+endpoint+':'+subjectId,legacyKey='hubs-v2:'+subjectId,previews=new WeakMap();let queue=Promise.resolve();
 const stamp=()=>{const s=api.snapshot();return JSON.stringify([api.endpoint,s?.subjectId??null,s?.bindingId??null,s?.generation??null,s?.control?.deviceId??null,s?.control?.keyId??null,s?.control?.epoch??null]);};
 function capture(authenticated=true){
  const tag=stamp(),reference=authenticated?runtime.receiptStatus?.captureLease?.():null;
  if(reference&&(reference.endpoint!==endpoint||reference.subjectId!==subjectId))throw error('hub_authority_changed','身份或连接已变化，请重新连接并核对原操作。');
  const check=()=>{reference?.assertCurrent();if(api.endpoint!==endpoint||stamp()!==tag||authenticated&&(!subjectId||api.snapshot()?.subjectId!==subjectId))throw error('hub_authority_changed','身份或连接已变化，请重新连接并核对原操作。');};
  check();return{check,bindingId:api.snapshot()?.bindingId??null};
 }
 async function guard(lease,action){lease.check();let value;try{value=await action();}catch(caught){lease.check();throw caught;}lease.check();return value;}
 const serial=fn=>{let lease;try{lease=capture();}catch(caught){return Promise.reject(caught);}const invoke=()=>guard(lease,()=>fn(lease)),run=()=>locks?.request?locks.request('hub-journal:'+endpoint+':'+subjectId,{mode:'exclusive'},invoke):invoke();
  const next=queue.then(run,run);queue=next.catch(()=>{});return next;};
 const get=(name,lease)=>guard(lease,()=>runtime.getLocal(name,subjectId));
 const update=(lease,change)=>guard(lease,()=>{if(typeof runtime.updateLocal!=='function')throw error('local_atomic_update_unavailable','当前本机存储不能安全保存原操作。');
  return runtime.updateLocal(key,value=>{lease.check();return change(value??{pending:null});},subjectId);});
 async function load(lease){
  const current=await get(key,lease);if(current)return current;
  const legacy=await get(legacyKey,lease);if(!legacy?.pending)return{pending:null};
  if(legacy.pending.prepared?.endpoint!==endpoint||legacy.pending.prepared?.intent?.subjectId!==subjectId)throw error('hub_legacy_authority_unknown','旧操作尚未绑定当前服务，请保留原记录核对。');
  // Preserve the old key and exact payload/signature bytes. An unaccepted
  // legacy record requires an explicit retry, never an automatic new intent.
  return update(lease,value=>value.pending||value.stoppedOperations?.length?value:{...copy(legacy),...value,pending:{...copy(legacy.pending),legacy:true}});
 }
 const base=family=>family==='peering'?'/v2/hubs/peering':'/v2/hubs';
 const locatorFor=record=>({endpoint,ownerId:subjectId,operationId:record.event.id,hubId:record.event.hubId,payloadHash:record.payloadHash,family:record.family});
 const matches=(record,selected)=>!!record&&record.event.hubId===selected.hubId&&record.event.id===selected.operationId&&record.payloadHash===selected.payloadHash&&record.family===selected.family;
 function locator(input){
  if(!input||input.endpoint!==endpoint||input.ownerId!==subjectId||!input.hubId||!input.operationId||!/^[a-f0-9]{64}$/.test(input.payloadHash)||!['hub','peering'].includes(input.family))throw error('hub_locator_mismatch','原操作定位信息不属于当前主体与服务。');return copy(input);
 }
 async function exact(record,lease){
  if(!['hub','peering'].includes(record.family))throw error('hub_original_changed','原操作类型不匹配。');
  const parsed=(record.family==='peering'?peeringEventSchema:hubEventSchema).parse(record.event),path=base(record.family)+'/events';
  if(!equalJson(parsed,JSON.parse(record.payloadJson))||!equalJson(parsed,record.event)||record.path!==undefined&&record.path!==path
   ||await guard(lease,()=>sha256Hex(record.payloadJson))!==record.payloadHash||!['Private','Public'].includes(record.visibility)||!Array.isArray(record.viewers))throw error('hub_original_changed','本机原操作内容已变化，不能重发。');
  const intent=record.prepared?.intent;
  if(record.prepared&&(record.prepared.endpoint!==endpoint||intent?.endpoint!==endpoint||intent.subjectId!==subjectId||intent.action!=='hub.publish'||intent.objectId!==record.event.id||intent.recipient!==endpoint
   ||intent.purpose!==(record.visibility==='Public'?'public-profile':'operational')||record.prepared.payloadJson!==record.payloadJson||intent.payloadHash!==record.payloadHash||intent.visibility!==record.visibility
   ||!equalJson(intent.viewers,record.viewers)||!equalJson(intent.fields,Object.keys(JSON.parse(record.payloadJson)))||record.authorizationExpiresAt!==undefined&&record.authorizationExpiresAt!==intent.expiresAt))throw error('hub_original_changed','原操作的内容或可见范围与保存授权不一致。');
  if(record.submission&&(!record.prepared||record.submission.payloadJson!==record.payloadJson||record.submission.consentId!==intent.id))throw error('hub_original_changed','原操作提交与保存授权不一致。');
  return{deadline:record.authorizationExpiresAt??intent?.expiresAt??null,bindingId:record.authorizationBindingId??intent?.bindingId??null};
 }
 async function replace(lease,original,change){
  let saved;await update(lease,value=>{if(!equalJson(value.pending,original))throw error('hub_operation_changed','原操作已在另一页改变，请读取当前记录。');
   if(value.stoppedOperations?.some(item=>item.operationId===original.event.id&&item.family===original.family))throw error('hub_operation_stopped','这次本机发送已经停止。原记录仍可查询。');
   saved={...original,...change,journalRevision:(original.journalRevision??0)+1};return{...value,pending:saved};});return copy(saved);
 }
 const call=(lease,path,input,authenticated=true)=>guard(lease,()=>api.call(path,input,{authenticated}));
 const read=(path,input,authenticated)=>call(capture(authenticated),path,input,authenticated);
 async function receiptWithin(input,lease){
  const selected=locator(input),r=await call(lease,base(selected.family)+'/receipt',{operationId:selected.operationId,payloadHash:selected.payloadHash});
  if(!['recorded','absent'].includes(r.state)||r.operationId!==selected.operationId
   ||r.state==='recorded'&&(r.hubId!==selected.hubId||r.payloadHash!==selected.payloadHash))throw error('hub_receipt_mismatch','原操作回执尚未确定或不匹配，请保留记录。');
  return{...r,remoteState:r.state,state:r.state==='recorded'?'acknowledged':'absent',locator:selected};
 }
 async function acknowledge(lease,record,receipt){
  const selected=locatorFor(record),result={...receipt,state:'acknowledged',locator:selected};
  // Late ACK settles only the exact original and never revives a stopped
  // record or clears a different operation from another page.
  await update(lease,value=>({...value,...(matches(value.pending,selected)?{pending:null}:{}),lastReceipt:result}));return result;
 }
 async function blocked(lease,record,reason,caught=null){
  const businessFailure=caught?{code:caught.code??'request_failed',status:caught.status??null}:record.businessFailure;
  if(record.blockedReason===reason&&equalJson(record.businessFailure,businessFailure))return{state:'blocked',reason,locator:locatorFor(record)};
  const saved=await replace(lease,record,{blockedReason:reason,...(caught?{businessFailure}:{})});
  return{state:'blocked',reason,locator:locatorFor(saved)};
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
   if(accepted.state==='acknowledged'){if(accepted.consentId!==record.prepared.intent.id||accepted.payloadJson!==record.payloadJson)throw error('hub_original_changed','原授权回执与保存内容不一致。');}
   else if(accepted.state!=='absent')throw error('hub_receipt_mismatch','原授权结果尚未确定。');
  }catch(caught){if(!unavailable(caught))return{reason:'consent-outcome-unknown'};authorizationUnavailable=true;}
  if(original.bindingId!==lease.bindingId)return{reason:original.bindingId?'binding-changed':'original-binding-unavailable'};
  if(!Number.isSafeInteger(original.deadline))return{reason:'original-deadline-unavailable'};
  if(original.deadline<=now())return{reason:'permission-expired'};
  if(!record.prepared)return record.intentConfirmed===true?{state:'ready'}:{reason:'original-authorization-unavailable'};
  if(authorizationUnavailable)return{reason:'permission-unavailable'};
  return accepted.state==='acknowledged'?{state:'ready',submission:{consentId:accepted.consentId,payloadJson:record.payloadJson}}
   :record.prepared.intent.issuedAt<now()-300?{reason:'original-signature-expired'}:{state:'ready'};
 }
 async function send(record,lease){
  await exact(record,lease);
  if(!record.prepared){const prepared=await guard(lease,()=>api.prepareAuthorization(record.payloadJson,{action:'hub.publish',objectId:record.event.id,visibility:record.visibility,viewers:record.viewers,expiresAt:record.authorizationExpiresAt,confirmed:true}));
   record=await replace(lease,record,{prepared,authorizationBindingId:prepared.intent.bindingId});}
  if(!record.submission){
   const reconcile=record.authorizationAttempted===true;record=await replace(lease,record,{authorizationAttempted:true});
   try{const submission=await guard(lease,()=>api.submitAuthorization(record.prepared,{confirmed:true,reconcile}));record=await replace(lease,record,{submission});}
   catch(caught){if(unavailable(caught))await blocked(lease,record,'permission-unavailable');throw caught;}
  }
  await exact(record,lease);record=await replace(lease,record,{attempted:true});let receipt;
  try{receipt=await call(lease,record.path??base(record.family)+'/events',record.submission);}
  catch(caught){if(businessRejected(caught))await blocked(lease,record,'business-declined',caught);throw caught;}
  if(receipt.state!=='recorded'||receipt.operationId!==record.event.id||receipt.hubId!==record.event.hubId||receipt.payloadHash!==record.payloadHash)throw error('hub_receipt_mismatch','回执与原操作不匹配。');
  return acknowledge(lease,record,{...receipt,remoteState:'recorded'});
 }
 async function resume(lease,{explicitRetry=false}={}){
  let record=(await load(lease)).pending;if(!record)return{state:'none'};await exact(record,lease);
  const receipt=await receiptWithin(locatorFor(record),lease);if(receipt.state==='acknowledged')return acknowledge(lease,record,receipt);
  if(record.legacy&&!explicitRetry)return blocked(lease,record,'legacy-review-required');
  if(record.businessFailure&&!explicitRetry)return{state:'blocked',reason:'business-declined',locator:locatorFor(record)};
  const authorized=await availability(lease,record);if(authorized.reason)return blocked(lease,record,authorized.reason);
  if(authorized.submission&&!equalJson(authorized.submission,record.submission))record=await replace(lease,record,{submission:authorized.submission});
  record=await replace(lease,record,{blockedReason:null,...(explicitRetry?{businessFailure:null}:{})});return send(record,lease);
 }
 async function review(lease){
  let record=(await load(lease)).pending;if(!record)return{state:'none'};
  const original=await exact(record,lease),receipt=await receiptWithin(locatorFor(record),lease);if(receipt.state==='acknowledged')return acknowledge(lease,record,receipt);
  const authorized=await availability(lease,record);if(!authorized.reason)return{state:'ready',locator:locatorFor(record)};
  if(authorized.reason==='consent-outcome-unknown')return blocked(lease,record,authorized.reason);
  if(record.blockedReason!==authorized.reason)record=await replace(lease,record,{blockedReason:authorized.reason});
  const preview={state:'reauthorization-required',locator:locatorFor(record),event:copy(record.event),visibility:record.visibility,viewers:copy(record.viewers),
   originalBindingId:original.bindingId,currentBindingId:lease.bindingId,originalExpiresAt:original.deadline,expiresAt:original.deadline>now()?original.deadline:now()+2591900,reason:authorized.reason};
  previews.set(preview,{lease,record:copy(record),exact:JSON.stringify(preview)});return preview;
 }
 const reauthorizeWithin=async(lease,preview,confirmed)=>{
   const token=previews.get(preview);if(!confirmed||!token||token.compat||token.exact!==JSON.stringify(preview))throw Error('请先查看并确认原社区内容与授权范围。');token.lease.check();
   let record=(await load(lease)).pending;if(!equalJson(record,token.record))throw error('hub_operation_changed','原操作已改变，请重新读取预览。');await exact(record,lease);
   const receipt=await receiptWithin(preview.locator,lease);if(receipt.state==='acknowledged')return acknowledge(lease,record,receipt);
   const current=await review(lease);if(current.state==='acknowledged')return current;if(current.state==='ready')return resume(lease,{explicitRetry:true});
   if(current.state!=='reauthorization-required'||!equalJson({...current,expiresAt:preview.expiresAt},preview)||preview.expiresAt<=now())throw error('hub_authorization_preview_changed','原授权预览已改变或到期，请重新读取。');
   const prepared=await guard(lease,()=>api.prepareAuthorization(record.payloadJson,{action:'hub.publish',objectId:record.event.id,visibility:record.visibility,viewers:record.viewers,expiresAt:preview.expiresAt,confirmed:true}));
   record=await replace(lease,record,{authorizationHistory:[...(record.authorizationHistory??[]),...(record.prepared?[record.prepared]:[])],prepared,submission:null,authorizationAttempted:false,
    authorizationBindingId:prepared.intent.bindingId,authorizationExpiresAt:preview.expiresAt,blockedReason:null,businessFailure:null});previews.delete(preview);return send(record,lease);
 };
 return{
  local:()=>serial(load),
  query:(input={},authenticated=false)=>read('/v2/hubs/query',input,authenticated),
  read:(input,authenticated=false)=>read('/v2/hubs/read',input,authenticated),
  manage:input=>read('/v2/hubs/manage',input,true),
  members:input=>read('/v2/hubs/memberships',input,true),
  intake:input=>read('/v2/hubs/intake',input,true),
  builder:hubId=>read('/v1/builders/manage/read',{builderId:hubId},true),
  ownedBuilders:(input={})=>read('/v1/builders/owned/query',{...input,type:'hub'},true),
  contacts:(input={})=>read('/v2/contacts/query',{direction:'both',limit:50,...input},true),
  peering:(method,input)=>{if(!['read','query','list','preview','sources','connections','party'].includes(method))throw Error('不支持的互联操作。');return read('/v2/hubs/peering/'+method,input,true);},
  /** @param {unknown} input @param {{visibility?:'Private'|'Public',viewers?:string[],family?:'hub'|'peering',confirmed?:boolean,onJournal?:null|((locator:any)=>unknown)}} [options] */
  submit:(input,{visibility='Private',viewers=[],family='hub',confirmed=false,onJournal=/** @type {null|((locator:any)=>unknown)} */(null)}={})=>{
   const intent=copy(input),selected=copy(viewers);return serial(async lease=>{
    if(!confirmed)throw Error('请先核对内容和可见范围。');await load(lease);
    if(!['hub','peering'].includes(family))throw Error('未知社区操作类型。');
    const event=(family==='peering'?peeringEventSchema:hubEventSchema).parse(intent),payloadJson=JSON.stringify(event),payloadHash=await guard(lease,()=>sha256Hex(payloadJson));
    if(new TextEncoder().encode(JSON.stringify({consentId:'00000000-0000-4000-8000-000000000000',payloadJson})).length>32000)throw Error('本次文字超过接口大小限制，请缩短后重新预览。');
    const record={event,payloadJson,payloadHash,family,path:base(family)+'/events',visibility,viewers:selected,intentConfirmed:true,
     authorizationBindingId:lease.bindingId,authorizationExpiresAt:now()+2591900,journalRevision:1};await exact(record,lease);
    await update(lease,value=>{if(value.pending)throw error('hub_operation_pending','上一次内容正在接续，请先读取原结果。');if(value.stoppedOperations?.some(item=>item.operationId===event.id&&item.family===family))throw error('hub_operation_stopped','这次本机发送已经停止，请保留原记录查询。');return{...value,pending:record};});
    if(onJournal)await guard(lease,()=>onJournal(locatorFor(record)));return send(record,lease);
   });
  },
  receiptFor:input=>{const selected=copy(input);return serial(lease=>receiptWithin(selected,lease));},
  resumePending:({explicitRetry=false}={})=>serial(lease=>resume(lease,{explicitRetry})),
  reviewAuthorization:()=>serial(review),
  reauthorize:(preview,{confirmed=false}={})=>serial(lease=>reauthorizeWithin(lease,preview,confirmed)),
  reviewPending:()=>serial(async lease=>{
   const local=await load(lease),record=local.pending,selected=record?locatorFor(record):local.stoppedOperations?.at(-1);if(!selected)return{state:'none'};
   if(record)await exact(record,lease);const receipt=await receiptWithin(selected,lease);
   if(receipt.state==='acknowledged'){if(record)await acknowledge(lease,record,receipt);return{...receipt,state:'recorded'};}
   if(!record)return{...receipt,...selected,localRetryStopped:true,remoteCancellationConfirmed:false};
   const preview={state:'absent',...selected,event:copy(record.event),visibility:record.visibility,viewers:copy(record.viewers),contentJson:record.payloadJson};
   previews.set(preview,{lease,record:copy(record),exact:JSON.stringify(preview),compat:true});return preview;
  }),
  reconcile:({retry=false,confirmed=false,review:chosen=null}={})=>serial(async lease=>{
   const local=await load(lease),record=local.pending,selected=record?locatorFor(record):local.stoppedOperations?.at(-1);if(!selected)return{state:'none'};
   if(record)await exact(record,lease);const receipt=await receiptWithin(selected,lease);if(receipt.state==='acknowledged'){if(record)await acknowledge(lease,record,receipt);return{...receipt,state:'recorded'};}
   if(!retry)return{...receipt,...(!record?{localRetryStopped:true,remoteCancellationConfirmed:false}:{})};
   if(!record)throw error('hub_retry_stopped','本机重试已停止，请仅查询原记录；不会自动重发。');
   const token=chosen&&previews.get(chosen);
   if(!confirmed||!token?.compat||token.exact!==JSON.stringify(chosen)||!equalJson(token.record,record))throw error('hub_retry_review_required','请在当前连接重新阅读原内容，再明确确认重试。');token.lease.check();
   previews.delete(chosen);const value=await resume(lease,{explicitRetry:true});return value.state==='acknowledged'?{...value,state:'recorded'}:value;
  }),
  discard:()=>serial(async lease=>{
   const local=await load(lease),record=local.pending;if(!record)return{state:'none'};await exact(record,lease);let receipt;
   try{receipt=await receiptWithin(locatorFor(record),lease);}catch(caught){lease.check();receipt={state:'unknown',reason:caught?.code??'receipt-unavailable'};}
   const stopped=locatorFor(record);
   await update(lease,value=>{if(!equalJson(value.pending,record))throw error('hub_operation_changed','原操作已在另一页改变，请读取当前记录。');
    return{...value,pending:null,stoppedOperations:[...(value.stoppedOperations??[]).filter(item=>item.operationId!==stopped.operationId||item.family!==stopped.family),stopped],...(receipt.state==='acknowledged'?{lastReceipt:{...receipt,state:'acknowledged',locator:stopped}}:{})};});
   return{...stopped,state:'stopped',remoteState:receipt.state,localRetryStopped:true,remoteCancellationConfirmed:false};
  }),
  queryStopped:input=>{const selected=copy(input);return serial(async lease=>{locator(selected);const local=await load(lease),stopped=(local.stoppedOperations??[]).find(item=>item.hubId===selected.hubId&&item.operationId===selected.operationId&&item.family===selected.family&&item.payloadHash===selected.payloadHash);
   if(!stopped)throw Error('本机没有这次原操作定位，请保留原记录核对。');return receiptWithin(stopped,lease);});},
 };
}
