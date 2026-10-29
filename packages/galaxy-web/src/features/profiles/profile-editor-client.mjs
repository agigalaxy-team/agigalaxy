import {z} from 'zod/v4';
import {profileStatementSchema,profileReceiptLocatorSchema,selfDeclaredProfileSchema} from "../../../../galaxy-contracts/src/profile-schema.mjs";
import {consentSchema} from "../../../../galaxy-contracts/src/consents-schema.mjs";
import {equalJson,sha256Hex} from "../../../../galaxy-contracts/src/web-primitives.mjs";
import {readProfileDisplayNames} from "../../../../galaxy-client/src/accounts/profile-display-names.mjs";

const subjectSchema=z.string().regex(/^GUID[0-9A-Z]{28}$/);
const viewersSchema=z.array(subjectSchema).max(16).refine(ids=>new Set(ids).size===ids.length);
const hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const preparedSchema=z.strictObject({version:z.literal(1),endpoint:z.string(),intent:consentSchema,signedIntent:z.string(),payloadJson:z.string()});
const journalSchema=z.strictObject({version:z.literal(1),operationId:z.uuid(),payloadJson:z.string().max(12000),payloadHash:hashSchema,
 expectedRevision:z.number().int().nonnegative(),visibility:z.enum(['Private','Public']),viewers:viewersSchema,
 expiresAt:z.number().int().positive().nullable(),authorizationExpiresAt:z.number().int().positive(),originalBindingId:z.uuid(),confirmed:z.literal(true),
 state:z.enum(['confirmed','result-unknown','business-rejected','stopped']),prepared:preparedSchema.nullable(),
 authorizationHistory:z.array(preparedSchema),submission:z.strictObject({consentId:z.uuid(),payloadJson:z.string()}).nullable(),
 blocker:z.strictObject({reason:z.string(),status:z.number().int()}).nullable()});
const storedSchema=z.strictObject({version:z.literal(1),active:journalSchema.nullable(),stopped:z.array(journalSchema)});
const saveSchema=z.strictObject({expectedRevision:z.number().int().nonnegative(),selfDeclared:selfDeclaredProfileSchema,
 visibility:z.enum(['Private','Public']),viewers:viewersSchema,expiresAt:z.number().int().positive().nullable()});
const empty=()=>({version:1,active:null,stopped:[]});
const issue=(code,message)=>Object.assign(new Error(message),{code});
/** @param {unknown} error */
function rejection(error){
 if(!(error instanceof Error)||!('status' in error)||!('outcome' in error)||!('code' in error)
  ||typeof error.status!=='number'||error.outcome!=='rejected'||typeof error.code!=='string'
  ||error.status<400||error.status>=500||[401,408,429].includes(error.status)
  ||['access_denied','unauthorized','binding_revoked','invalid_session','session_expired'].includes(error.code))return null;
 return{reason:error.code,status:error.status};
}

/**
 * Editing is local to this owner and endpoint. Only a confirmed, immutable
 * statement journal can be sent; a form draft never becomes an operation.
 * @param {import('../accounts/account-workspace-types').AccountRuntime} runtime
 * @param {{subjectId?:string,authenticated?:boolean,now?:()=>number}} options
 */
export function createProfileEditorClient(runtime,{subjectId=runtime.api.snapshot()?.subjectId,authenticated=true,now=()=>Math.floor(Date.now()/1000)}={}){
 const owner=subjectSchema.parse(subjectId),api=runtime.api,endpoint=api.endpoint,authority=runtime.receiptStatus.captureLease();
 const initial=api.snapshot(),key=`profile-statements:${endpoint}`,reviews=new WeakMap();let closed=false;
 /** @type {Promise<unknown>} */let tail=Promise.resolve();
 function check(){
  authority.assertCurrent();const current=api.snapshot();
  if(closed||!authenticated||!current||!initial||authority.subjectId!==owner||api.endpoint!==endpoint
   ||['subjectId','endpoint','bindingId','generation'].some(field=>initial[field]!==current[field]))
   throw issue('profile_identity_changed','当前身份或连接已变化，原输入仍保留，请重新打开本人资料。');
 }
 /** @template T @param {()=>Promise<T>} action */
 async function wait(action){check();let result;try{result=await action();}catch(error){check();throw error;}check();return result;}
 /** @template T @param {()=>Promise<T>} action */
 function serial(action){const result=tail.then(()=>wait(action));tail=result.then(()=>undefined,()=>undefined);return result;}
 const call=(path,input)=>wait(()=>api.call(path,input));
 async function load(){const raw=await wait(()=>runtime.getLocal(key,owner));return storedSchema.parse(raw??empty());}
 async function update(change){return storedSchema.parse(await wait(()=>runtime.updateLocal(key,raw=>{check();return change(storedSchema.parse(raw??empty()));},owner)));}
 const matches=(left,right)=>!!left&&!!right&&left.operationId===right.operationId&&left.payloadHash===right.payloadHash;
 async function replace(before,after){
  const state=await update(current=>{if(!matches(current.active,before)||!equalJson(current.active,before))
   throw issue('profile_operation_changed','原保存操作已改变，本次没有替换它。');return{...current,active:after};});
  return journalSchema.parse(state.active);
 }
 async function original(){
  const record=(await load()).active;if(!record)return null;
  const payload=profileStatementSchema.parse(JSON.parse(record.payloadJson));
  if(payload.id!==record.operationId||payload.expectedRevision!==record.expectedRevision
   ||!payload.sharing||payload.sharing.visibility!==record.visibility||!equalJson(payload.sharing.viewers,record.viewers)
   ||payload.sharing.expiresAt!==record.expiresAt
   ||await wait(()=>sha256Hex(record.payloadJson))!==record.payloadHash)
   throw issue('profile_original_changed','原资料内容或定位已变化，请保留原稿。');
  if(record.prepared){const prepared=record.prepared,intent=prepared.intent;
   if(prepared.payloadJson!==record.payloadJson||prepared.endpoint!==endpoint||intent.endpoint!==endpoint||intent.subjectId!==owner
    ||intent.action!=='profile.publish'||intent.objectId!==record.operationId||intent.recipient!==endpoint
    ||intent.payloadHash!==record.payloadHash||intent.visibility!==record.visibility||!equalJson(intent.viewers,record.viewers)
    ||intent.expiresAt!==record.authorizationExpiresAt||!equalJson(intent.fields,Object.keys(payload))
    ||record.submission&&(record.submission.consentId!==intent.id||record.submission.payloadJson!==record.payloadJson))
    throw issue('profile_original_changed','原资料的授权或范围不能准确核对，尚未发送。');
  }else if(record.submission)throw issue('profile_original_changed','原保存缺少对应授权记录，尚未发送。');
  return record;
 }
 /** @returns {Promise<import('../accounts/account-workspace-types').ProfileOwnerView>} */
 async function ownerRead(){
  const page=await call('/v1/profiles/current',{});
  if(page.subjectId!==owner||!Number.isSafeInteger(page.revision)||page.revision<0||typeof page.readable!=='boolean')
   throw issue('profile_owner_projection_invalid','当前本人资料不能准确核对，请保留输入后重新读取。');
  return{subjectId:owner,revision:page.revision,selfDeclared:selfDeclaredProfileSchema.parse(page.selfDeclared),
   statement:page.statement,sharing:page.sharing,readable:page.readable,checkedAt:page.checkedAt};
 }
 /** @param {{operationId:string,payloadHash:string}} locator @returns {Promise<import('../accounts/account-workspace-types').ProfileSaveResult>} */
 async function receiptFor(locator){
  const selected=profileReceiptLocatorSchema.parse({operationId:locator.operationId,payloadHash:locator.payloadHash});
  const receipt=await call('/v1/profiles/statements/receipt',selected);
  if(!['acknowledged','absent','conflict'].includes(receipt.state)||receipt.operationId!==selected.operationId||receipt.payloadHash!==selected.payloadHash)
   throw issue('profile_receipt_mismatch','本次保存结果还不能准确核对，原操作仍保留。');
  if(receipt.state!=='acknowledged')return{...selected,state:receipt.state,canContinue:receipt.state==='absent'};
  if(receipt.id!==selected.operationId||!Number.isSafeInteger(receipt.revision)||receipt.revision<1
   ||receipt.classification!=='self-declared'||receipt.capabilityVerified!==false)throw issue('profile_receipt_mismatch','资料保存回执不匹配。');
  return{...selected,state:'acknowledged',revision:receipt.revision,receipt:{id:receipt.id,revision:receipt.revision,classification:'self-declared',capabilityVerified:false}};
 }
 async function acknowledged(record,result){
  if(result.state!=='acknowledged')return result;
  await update(current=>matches(current.active,record)?{...current,active:null}:current);return result;
 }
 /** @returns {Promise<import('../accounts/account-workspace-types').ProfilePending|null>} */
 async function pending(){const record=await original();return record?view(record):null;}
 /** @param {z.infer<typeof journalSchema>} record @returns {import('../accounts/account-workspace-types').ProfilePending} */
 function view(record){return{kind:'profile-statement',operationId:record.operationId,payloadHash:record.payloadHash,payloadJson:record.payloadJson,
  payload:profileStatementSchema.parse(JSON.parse(record.payloadJson)),visibility:record.visibility,viewers:[...record.viewers],expiresAt:record.expiresAt,
  authorizationExpiresAt:record.authorizationExpiresAt,
  state:record.state,...(record.blocker?{reason:record.blocker.reason}:{})};}
 /** @param {z.infer<typeof journalSchema>} record */
 async function authorization(record){
  if(record.expiresAt!==null&&record.expiresAt<=now())return{reason:'sharing-expired'};
  let expiredReceipt=false;
  if(record.prepared){
   let accepted;try{accepted=await wait(()=>api.reconcileAuthorization(record.prepared));}
   catch(error){
    if(!(error instanceof Error&&'code' in error&&error.code==='consent_receipt_not_active_or_mismatched'))throw error;
    // reconcileAuthorization already checked the original signature envelope.
    // Distinguish its natural submission expiry from an explicit revocation.
    const receipt=await call('/v2/consents/receipt',{consentId:record.prepared.intent.id});
    if(receipt.state!=='recorded'||receipt.consentId!==record.prepared.intent.id||!equalJson(receipt.intent,record.prepared.intent)
     ||receipt.signatureHash!==await wait(()=>sha256Hex(record.prepared.signedIntent)))
     throw issue('profile_receipt_mismatch','原资料授权回执不匹配，尚未继续发送。');
    if(receipt.status==='revoked')return{reason:'authorization-unavailable'};
    if(receipt.status!=='expired')throw issue('profile_receipt_mismatch','原资料授权状态不能准确核对。');
    expiredReceipt=true;accepted={state:'absent'};
   }
   if(accepted.state==='acknowledged')return{submission:{consentId:accepted.consentId,payloadJson:accepted.payloadJson}};
   if(accepted.state!=='absent')throw issue('profile_receipt_mismatch','原资料授权状态无法核对。');
  }
  const binding=api.snapshot();
  if(record.originalBindingId!==binding?.bindingId&&record.prepared?.intent.bindingId!==binding?.bindingId)return{reason:'binding-changed'};
  return{reason:null,renew:record.authorizationExpiresAt<=now(),newConsent:expiredReceipt};
 }
 function authorizationDeadline(){
  if(!api.snapshot())throw issue('profile_identity_changed','当前连接已结束，请连接本人身份后继续。');
  // The ordinary API snapshot exposes the session, not the binding deadline.
  // Access/Consent enforce the actual binding's validity on submission. This
  // short internal deadline must never become the declaration's sharing limit.
  return now()+3600;
 }
 /** @param {{explicitRetry?:boolean}} options @returns {Promise<import('../accounts/account-workspace-types').ProfileSaveResult>} */
 async function resume({explicitRetry=false}={}){
  let record=await original();if(!record)return{state:'idle'};
  const exact=await receiptFor(record);if(exact.state==='acknowledged')return acknowledged(record,exact);
  if(exact.state==='conflict')return{...exact,reason:'profile_statement_conflict',canContinue:false};
  /** @param {string} reason @returns {import('../accounts/account-workspace-types').ProfileSaveResult} */
  const result=reason=>({state:'unacknowledged',operationId:record.operationId,payloadHash:record.payloadHash,reason,
   canContinue:!['profile_revision_conflict','sharing-expired','stopped-local'].includes(reason)});
  if(record.state==='stopped')return result('stopped-local');
  if(record.blocker&&!explicitRetry)return result(record.blocker.reason);
  const auth=await authorization(record);if(auth.reason)return result(auth.reason);
  try{
   if(auth.submission){if(!record.submission)record=await replace(record,{...record,submission:auth.submission});}
   else{
    // A still-valid confirmed choice on the same binding needs no new user
    // decision when only its transport signature has become too old.
    if(!record.prepared||auth.renew||auth.newConsent||record.prepared.intent.issuedAt<now()-300){
     const authorizationExpiresAt=auth.renew||auth.newConsent?authorizationDeadline():record.authorizationExpiresAt;
     const prepared=await wait(()=>api.prepareAuthorization(record.payloadJson,{action:'profile.publish',objectId:record.operationId,
      visibility:record.visibility,viewers:record.viewers,expiresAt:authorizationExpiresAt,
      ...(record.prepared&&!auth.newConsent?{id:record.prepared.intent.id}:{}),confirmed:true}));
     record=await replace(record,{...record,prepared,authorizationExpiresAt,submission:null,
      authorizationHistory:record.prepared?[...record.authorizationHistory,record.prepared]:record.authorizationHistory});
    }
    const submission=await wait(()=>api.submitAuthorization(record.prepared,{confirmed:true,reconcile:true}));
    record=await replace(record,{...record,submission});
   }
   record=await replace(record,{...record,state:'result-unknown',blocker:null});
   await call('/v1/profiles/statements',record.submission);
   return acknowledged(record,await receiptFor(record));
  }catch(error){
   const blocked=rejection(error);if(blocked){record=await replace(record,{...record,state:'business-rejected',blocker:blocked});return result(blocked.reason);}
   throw error;
  }
 }
 /** @param {import('../accounts/account-workspace-types').ProfileSaveInput} input @param {{onJournal?:(locator:import('../accounts/account-workspace-types').ProfileStatementLocator)=>unknown}} options */
 async function save(input,{onJournal}={}){
  const value=saveSchema.parse(input);
  if(value.expiresAt!==null&&value.expiresAt<=now()||value.visibility==='Public'&&value.viewers.length)
   throw issue('profile_sharing_invalid','请核对这次实际分享范围和期限。');
  const payload=profileStatementSchema.parse({id:crypto.randomUUID(),expectedRevision:value.expectedRevision,selfDeclared:value.selfDeclared,
   sharing:{visibility:value.visibility,viewers:value.viewers,expiresAt:value.expiresAt}});
  const payloadJson=JSON.stringify(payload);if(payloadJson.length>12000)throw issue('profile_too_large','这份介绍太长，请缩短后保存。');
  const record=journalSchema.parse({version:1,operationId:payload.id,payloadJson,payloadHash:await wait(()=>sha256Hex(payloadJson)),
   expectedRevision:value.expectedRevision,visibility:value.visibility,viewers:value.viewers,expiresAt:value.expiresAt,
   authorizationExpiresAt:authorizationDeadline(),originalBindingId:api.snapshot().bindingId,
   confirmed:true,state:'confirmed',prepared:null,authorizationHistory:[],submission:null,blocker:null});
  await update(current=>{if(current.active)throw issue('profile_pending_operation','上次资料保存还在确认中，原输入仍保留。');return{...current,active:record};});
  await wait(async()=>onJournal?.({kind:'profile-statement',operationId:record.operationId,payloadHash:record.payloadHash,expectedRevision:record.expectedRevision}));
  return resume();
 }
 /** @returns {Promise<import('../accounts/account-workspace-types').ProfileAuthorizationReview>} */
 async function reviewAuthorization(){
  const record=await original();if(!record)return{state:'idle'};
  const exact=await receiptFor(record);if(exact.state==='acknowledged')return acknowledged(record,exact);
  if(exact.state==='conflict')return{...exact,canContinue:false,reason:'profile_statement_conflict'};
  if(record.blocker?.reason==='profile_revision_conflict')return{...view(record),state:'unacknowledged',canContinue:false,reason:record.blocker.reason};
  const auth=await authorization(record);
  if(auth.reason==='sharing-expired')return{...view(record),state:'unacknowledged',canContinue:false,reason:auth.reason};
  /** @type {import('../accounts/account-workspace-types').ProfileAuthorizationReview} */
  const preview={...view(record),state:auth.reason?'reauthorization-required':'reuse-original-authorization',reason:auth.reason??record.blocker?.reason,
   originalExpiresAt:record.expiresAt,authorizationExpiresAt:auth.reason?authorizationDeadline():record.authorizationExpiresAt,canContinue:true};
  reviews.set(preview,{record,exact:structuredClone(preview)});return preview;
 }
 /** @param {import('../accounts/account-workspace-types').ProfileAuthorizationReview} preview @param {{confirmed?:boolean}} options */
 async function reauthorize(preview,{confirmed=false}={}){
  const token=reviews.get(preview);check();
  if(!confirmed||!token||!equalJson(preview,token.exact))throw issue('profile_review_changed','请重新核对原资料与显示的实际范围。');
  const receipt=await receiptFor(token.record);if(receipt.state==='acknowledged')return acknowledged(token.record,receipt);
  const record=await original();if(!record||!equalJson(record,token.record))throw issue('profile_operation_changed','原保存操作已变化。');
  const auth=await authorization(record);if(!auth.reason)return resume({explicitRetry:true});
  if(preview.state!=='reauthorization-required'||!preview.authorizationExpiresAt||preview.authorizationExpiresAt<=now()
   ||preview.expiresAt!==record.expiresAt||auth.reason==='sharing-expired')throw issue('profile_review_changed','原内容、分享范围或显示的提交期限已经变化。');
  const prepared=await wait(()=>api.prepareAuthorization(record.payloadJson,{action:'profile.publish',objectId:record.operationId,
   visibility:record.visibility,viewers:record.viewers,expiresAt:preview.authorizationExpiresAt,confirmed:true}));
  await replace(record,{...record,prepared,authorizationExpiresAt:preview.authorizationExpiresAt,originalBindingId:prepared.intent.bindingId,submission:null,
   state:'confirmed',blocker:null,authorizationHistory:record.prepared?[...record.authorizationHistory,record.prepared]:record.authorizationHistory});
  return resume({explicitRetry:true});
 }
 /** @param {{operationId:string,payloadHash:string}} locator */
 async function stopPending(locator){
  const selected=profileReceiptLocatorSchema.parse({operationId:locator.operationId,payloadHash:locator.payloadHash});
  const record=await original();if(!record||!matches(record,selected))throw issue('profile_operation_changed','原保存操作已经变化。');
  const receipt=await receiptFor(record);if(receipt.state==='acknowledged')return acknowledged(record,receipt);
  if(receipt.state!=='absent')return receipt;
  await update(current=>{if(!matches(current.active,record)||!equalJson(current.active,record))throw issue('profile_operation_changed','原保存已经变化。');
   return{...current,active:null,stopped:[...current.stopped,{...record,state:'stopped'}]};});
  return{...receipt,reason:'stopped-local',canContinue:false};
 }
 /** @param {'contacts'|'rooms'} kind @param {{after?:string}} options */
 async function peoplePage(kind,{after}={}){
  if(!['contacts','rooms'].includes(kind))throw issue('profile_people_kind_invalid','联系人来源不正确。');
  const page=await call(kind==='contacts'?'/v2/contacts/query':'/v2/chat/rooms/query',
   {...(kind==='contacts'?{direction:'both',limit:50}:{}),...(after?{after}:{})});
  const ids=[...new Set(kind==='contacts'?(page.items??[]).filter(person=>person.state==='accepted')
   .map(person=>person.initiatorId===owner?person.recipientId:person.initiatorId):(page.rooms??[]).flatMap(room=>(room.members??[]).map(person=>person.subjectId)))].filter(id=>id!==owner);
  const names=[];for(let start=0;start<ids.length;start+=20)names.push(...await wait(()=>readProfileDisplayNames(call,ids.slice(start,start+20))));
  return{items:names.map(person=>({subjectId:person.subjectId,displayName:person.displayName,source:kind==='contacts'?'联系人':'共同对话'})),
   next:kind==='contacts'?page.nextAfter??null:page.next??null};
 }
 check();return Object.freeze({check,close(){closed=true;},ownerRead,pending,readPending:pending,peoplePage,receiptFor,
  save:(input,options)=>serial(()=>save(input,options)),resumePending:options=>serial(()=>resume(options)),
  reviewAuthorization:()=>serial(reviewAuthorization),reauthorize:(preview,options)=>serial(()=>reauthorize(preview,options)),
  stopPending:locator=>serial(()=>stopPending(locator))});
}
