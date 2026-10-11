import {participationEventV2Schema} from '../../galaxy-official/src/shared/task-schema-v2.mjs';
import {equalJson,sha256Hex} from '../../galaxy-official/src/shared/web-primitives.mjs';

export const requesterFeedbackAvailable=(task,participant,subjectId)=>participant.subjectId===subjectId
  && Number.isSafeInteger(participant.confirmedAt)
  && (['accepted','withdrawn','closed'].includes(participant.state)||['canceled','closed'].includes(task.state));
export function requesterFeedbackPreview(task,participant,subjectId,draft){
 if(!requesterFeedbackAvailable(task,participant,subjectId))throw Error('只有实际确认参与的本人，在该次参与结束或任务取消后才能记录合作反馈。');
 if(!['yes','no'].includes(draft.scopeMatched))throw Error('请选择实际工作是否符合约定范围。');
 const parsed=participationEventV2Schema.parse({eventId:'00000000-0000-4000-8000-000000000001',kind:'requester-feedback',
  expectedParticipationVersion:participant.version,descriptionClarity:draft.descriptionClarity,scopeMatched:draft.scopeMatched==='yes',note:draft.note,
  ...(participant.feedback?{supersedes:participant.feedback.eventId,reason:draft.reason}:{})});
 const {eventId:_eventId,...event}=parsed;
 return {taskId:task.taskId,participationId:participant.participationId,authorId:subjectId,requesterId:task.requesterId,event,
  viewers:[...new Set([subjectId,task.requesterId])],visibility:'Private',authority:'provider-reported',independentQualityRating:false};
}
export function submitRequesterFeedback(runtime,preview){
 return runtime.participationEvent(preview.taskId,preview.participationId,preview.event,{confirmed:true,viewers:preview.viewers});
}

const uuid=value=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value??'');
const hash=value=>/^[a-f0-9]{64}$/.test(value??'');
const issue=(code,message)=>Object.assign(new Error(message),{code});

/**
 * Feedback uses the existing participation journal. Pure editing stays with
 * the caller; only an exact, body-free locator links its CAS revision to ACK.
 * @param {any} runtime @param {string} taskId @param {string} participationId
 * @param {{subjectId?:string,now?:()=>number}} options
 */
export function createRequesterFeedbackClient(runtime,taskId,participationId,{subjectId=runtime.api.snapshot()?.subjectId,now=()=>Math.floor(Date.now()/1000)}={}){
 if(!subjectId||!uuid(taskId)||!uuid(participationId))throw issue('requester_feedback_scope_invalid','请从这次实际参与打开合作反馈。');
 const endpoint=runtime.api.endpoint,key=`task-event:${taskId}`,path=`/v2/participations/${participationId}/events`,reviews=new WeakMap();let closed=false;
 const changed=()=>issue('requester_feedback_authority_changed','当前身份或连接已变化，原反馈仍保留，请重新打开这次参与。');
 function capture(){
  const lease=runtime.receiptStatus.captureLease(),binding=runtime.api.snapshot();
  const check=()=>{lease.assertCurrent();const current=runtime.api.snapshot();
   if(closed||lease.subjectId!==subjectId||lease.endpoint!==endpoint||!binding||!current
    ||['subjectId','endpoint','bindingId','generation'].some(field=>binding[field]!==current[field]))throw changed();};
  check();return{...lease,check,async wait(action){check();let result;try{result=await action();}catch(error){check();throw error;}check();return result;}};
 }
 async function original(lease){
  const record=await lease.wait(()=>runtime.getLocal(key,subjectId));if(!record)return null;
  // Another participation's operation shares this Task slot, but its body is
  // never exposed as a feedback draft or mistaken for this participation's ACK.
  if(record.path!==path)return null;
  const payload=participationEventV2Schema.parse(JSON.parse(record.payloadJson));if(payload.kind!=='requester-feedback')return null;
  if(record.taskId!==taskId||payload.eventId!==record.eventId||record.participationId&&record.participationId!==participationId
   ||!hash(record.payloadHash)||await lease.wait(()=>sha256Hex(record.payloadJson))!==record.payloadHash
   ||!Array.isArray(record.viewers)||record.viewers.length>2||new Set(record.viewers).size!==record.viewers.length||!record.viewers.includes(subjectId))
   throw issue('requester_feedback_original_changed','原反馈定位或内容已变化，请保留原稿并重新读取。');
  if(record.preparedConsent){const prepared=record.preparedConsent,intent=prepared.intent;
   if(prepared.endpoint!==endpoint||prepared.payloadJson!==record.payloadJson||intent.subjectId!==subjectId||intent.endpoint!==endpoint
    ||intent.action!=='assistance.publish'||intent.objectId!==record.eventId||intent.payloadHash!==record.payloadHash
    ||intent.visibility!=='Private'||!equalJson(intent.viewers,record.viewers)||intent.expiresAt!==record.authorizationExpiresAt
    ||intent.recipient!==endpoint||intent.purpose!=='operational'||!equalJson(intent.fields,Object.keys(payload))
    ||record.submission&&(record.submission.consentId!==intent.id||record.submission.payloadJson!==record.payloadJson))
    throw issue('requester_feedback_original_changed','原反馈与已保存许可不一致，本次不会另建反馈。');
  }else if(record.submission)throw issue('requester_feedback_original_changed','原许可依据不可用，原反馈仍保留。');
  return{record,payload};
 }
 const view=({record,payload})=>({taskId,participationId,eventId:record.eventId,payloadHash:record.payloadHash,payloadJson:record.payloadJson,
  payload:structuredClone(payload),event:structuredClone(payload),visibility:'Private',viewers:[...record.viewers],expiresAt:record.authorizationExpiresAt,
  state:record.state,kind:'requester-feedback'});
 async function receipt(lease,locator){
  if(!uuid(locator?.eventId)||!hash(locator?.payloadHash))throw issue('requester_feedback_receipt_invalid','原反馈定位不完整。');
  const result=await lease.wait(()=>runtime.api.call('/v2/tasks/receipt',{taskId,eventId:locator.eventId,payloadHash:locator.payloadHash}));
  if(result.taskId!==taskId||result.eventId!==locator.eventId||result.payloadHash!==locator.payloadHash
   ||!['absent','acknowledged','conflict'].includes(result.state)
   ||result.state==='acknowledged'&&(result.participationId!==participationId||result.kind!=='requester-feedback'))
   throw issue('requester_feedback_receipt_mismatch','没有读到这条反馈的准确保存结果，原稿仍保留。');
  return{...result,participationId,kind:'requester-feedback'};
 }
 async function selection(lease,saved){
  const task=await lease.wait(()=>runtime.api.call(`/v2/tasks/${taskId}`,null,{method:'GET'}));
  const participant=task.participations?.find(row=>row.participationId===participationId);
  if(!participant||!requesterFeedbackAvailable(task,participant,subjectId))return'participation-unavailable';
  if(participant.version!==saved.payload.expectedParticipationVersion||(participant.feedback?.eventId??null)!==(saved.payload.supersedes??null))return'participation-changed';
  if(!equalJson(saved.record.viewers,[...new Set([subjectId,task.requesterId])]))throw issue('requester_feedback_original_changed','原反馈阅读范围与这次参与不一致。');
  return null;
 }
 async function permission(lease,saved){
  const{record}=saved,deadline=record.authorizationExpiresAt;
  if(!Number.isSafeInteger(deadline))return'original-authorization-unavailable';
  if(deadline<=now())return'authorization-expired';
  if(record.preparedConsent){
   try{const result=await lease.wait(()=>runtime.api.reconcileAuthorization(record.preparedConsent));
    if(result.state==='acknowledged')return null;if(result.state!=='absent')throw issue('requester_feedback_original_changed','原许可回执不一致。');
   }catch(error){
    if(error.code!=='consent_receipt_not_active_or_mismatched')throw error;
    const found=await lease.wait(()=>runtime.api.call('/v2/consents/receipt',{consentId:record.preparedConsent.intent.id}));
    if(found.state!=='recorded'||found.consentId!==record.preparedConsent.intent.id||!equalJson(found.intent,record.preparedConsent.intent)
      ||found.signatureHash!==await lease.wait(()=>sha256Hex(record.preparedConsent.signedIntent))||!['expired','revoked'].includes(found.status))throw error;
    return found.status==='revoked'?'authorization-revoked':'authorization-expired';
   }
  }
  const binding=record.preparedConsent?.intent.bindingId??record.authorizationBindingId;
  return !binding?'original-binding-unavailable':binding!==lease.bindingId?'binding-changed':null;
 }
 function same(left,right){return left&&right&&left.record.eventId===right.record.eventId&&left.record.payloadHash===right.record.payloadHash
  &&left.record.payloadJson===right.record.payloadJson&&left.record.authorizationExpiresAt===right.record.authorizationExpiresAt
  &&equalJson(left.record.viewers,right.record.viewers)&&(left.record.preparedConsent?.signedIntent??null)===(right.record.preparedConsent?.signedIntent??null);}
 async function resume(lease,saved,{explicitRetry=false}={}){
  const exact=await receipt(lease,saved.record);
  if(exact.state==='acknowledged'){
   // Let the existing runtime retire only the matching original journal.
   if(same(saved,await original(lease)))await lease.wait(()=>runtime.resumeTaskEvent(taskId,{expectedEventId:saved.record.eventId,expectedPayloadHash:saved.record.payloadHash}));
   return exact;
  }
  if(exact.state!=='absent')return{...exact,reason:'operation-conflict'};
  const unavailable=await selection(lease,saved);if(unavailable)return{...exact,state:'unacknowledged',reason:unavailable};
  const reason=await permission(lease,saved);if(reason)return{...exact,state:'unacknowledged',reason};
  if(!same(saved,await original(lease)))throw issue('requester_feedback_original_changed','原反馈已经变化，本次没有替换它。');
  try{await lease.wait(()=>runtime.resumeTaskEvent(taskId,{expectedEventId:saved.record.eventId,expectedPayloadHash:saved.record.payloadHash,explicitRetry}));}
  catch(error){if(error.code==='task_operation_authorization_review_required')return{...exact,state:'unacknowledged',reason:error.reason==='original-binding-unavailable'?'original-binding-unavailable':'binding-changed'};
   if(error.code==='task_operation_authorization_expired')return{...exact,state:'unacknowledged',reason:'authorization-expired'};
   if(error.code==='task_operation_business_rejected')return{...exact,state:'unacknowledged',reason:'business-rejected'};throw error;}
  return receipt(lease,saved.record);
 }
 return Object.freeze({
  async readPending(){const lease=capture(),saved=await original(lease);return saved?view(saved):null;},
  async receiptFor(locator){return receipt(capture(),locator);},
  /** @param {{explicitRetry?:boolean}} options */
  async resumePending({explicitRetry=false}={}){const lease=capture(),saved=await original(lease);return saved?resume(lease,saved,{explicitRetry}):{state:'none',taskId,participationId};},
  /** @param {any} task @param {any} participant @param {any} draft @param {{confirmed?:boolean,onJournal?:(locator:any)=>any}} options */
  async submit(task,participant,draft,{confirmed=false,onJournal}={}){
   if(!confirmed)throw issue('requester_feedback_confirmation_required','请明确保存这次合作的反馈。');
   const lease=capture();if(task?.taskId!==taskId||participant?.participationId!==participationId)throw issue('requester_feedback_scope_invalid','这次反馈对应的参与已变化。');
   if(participant.subjectId!==subjectId)throw issue('requester_feedback_author_denied','只有实际确认参与的本人，才能保存这次合作的反馈。');
   const current=await lease.wait(()=>runtime.api.call(`/v2/tasks/${taskId}`,null,{method:'GET'})),actual=current.participations?.find(row=>row.participationId===participationId);
   if(!actual||actual.version!==participant.version||(actual.feedback?.eventId??null)!==(participant.feedback?.eventId??null)
    ||Object.hasOwn(draft,'baseFeedbackId')&&(draft.baseFeedbackId??null)!==(actual.feedback?.eventId??null))
    throw issue('requester_feedback_source_changed','已有较新的参与或反馈，请阅读当前内容后继续修改；你的未发送文字仍保留。');
   const preview=requesterFeedbackPreview(current,actual,subjectId,draft);let locator;
   await lease.wait(()=>runtime.participationEvent(taskId,participationId,preview.event,{confirmed:true,viewers:preview.viewers,
    onJournal:async saved=>{lease.check();locator=saved;await onJournal?.(saved);lease.check();}}));
   return receipt(lease,locator);
  },
  async reviewAuthorization(){
   const lease=capture(),saved=await original(lease);if(!saved)return{state:'none',taskId,participationId};
   const exact=await receipt(lease,saved.record);if(exact.state==='acknowledged')return resume(lease,saved);
   if(exact.state!=='absent')return{...exact,reason:'operation-conflict'};
   const unavailable=await selection(lease,saved);if(unavailable)return{...view(saved),state:'unacknowledged',reason:unavailable,canContinue:false};
   const reason=await permission(lease,saved),originalExpiresAt=saved.record.authorizationExpiresAt;
   if(!same(saved,await original(lease)))throw issue('requester_feedback_original_changed','原反馈已变化，请重新读取原内容。');
   const preview={...view(saved),state:reason?'reauthorization-required':'reuse-original-authorization',reason,originalExpiresAt,
    expiresAt:Number.isSafeInteger(originalExpiresAt)&&originalExpiresAt>now()?originalExpiresAt:now()+2591900,canContinue:true};
   reviews.set(preview,{lease,saved,displayed:structuredClone(preview)});return preview;
  },
  /** @param {any} preview @param {{confirmed?:boolean}} options */
  async reauthorize(preview,{confirmed=false}={}){
   if(!confirmed)throw issue('requester_feedback_confirmation_required','请确认继续这条原反馈和所显示的阅读范围。');
   const token=reviews.get(preview);if(!token)throw issue('requester_feedback_review_changed','原预览不可继续，请重新读取原内容。');
   const{lease,saved,displayed}=token;lease.check();
   if(!equalJson(preview,displayed)||!equalJson(preview.payload,saved.payload)||preview.payloadJson!==saved.record.payloadJson||preview.eventId!==saved.record.eventId
    ||preview.payloadHash!==saved.record.payloadHash||preview.visibility!=='Private'||!equalJson(preview.viewers,saved.record.viewers)
    ||preview.originalExpiresAt!==saved.record.authorizationExpiresAt)throw issue('requester_feedback_review_changed','原反馈或阅读范围已变化，请重新读取原预览。');
   const exact=await receipt(lease,saved.record);if(exact.state==='acknowledged')return resume(lease,saved);
   if(!same(saved,await original(lease)))throw issue('requester_feedback_original_changed','原反馈已经变化，本次没有替换它。');
   const unavailable=await selection(lease,saved);if(unavailable)return{...exact,state:'unacknowledged',reason:unavailable};
   const reason=await permission(lease,saved);
   if(!reason)return resume(lease,saved,{explicitRetry:true});
   if(preview.state!=='reauthorization-required'||preview.expiresAt<=now()
    ||Number.isSafeInteger(saved.record.authorizationExpiresAt)&&saved.record.authorizationExpiresAt>now()&&preview.expiresAt!==saved.record.authorizationExpiresAt)
    throw issue('requester_feedback_review_changed','原许可状态或显示的期限已经变化，请重新查看原内容。');
   const current=await lease.wait(()=>runtime.reviewTaskAuthorization(taskId));
   if(current.state==='acknowledged')return receipt(lease,saved.record);
   if(current.state!=='reauthorization-required'||current.eventId!==saved.record.eventId||current.payloadHash!==saved.record.payloadHash
    ||!equalJson(current.payload,saved.payload)||!equalJson(current.viewers,saved.record.viewers))throw issue('requester_feedback_review_changed','原许可已经变化，请重新读取。');
   await lease.wait(()=>runtime.reauthorizeTaskOperation({...current,expiresAt:preview.expiresAt},{taskId,confirmed:true}));
   return receipt(lease,saved.record);
  },
  close(){closed=true;},
 });
}
