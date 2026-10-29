import {moderationEventSchema,moderationReceiptSchema,moderationReceiptResultSchema} from "../../../../galaxy-contracts/src/moderation-schema.mjs";
const permission={'invite-verifier':'canInviteVerifier','accept-verifier':'canAcceptVerifier','decline-verifier':'canDeclineVerifier','withdraw-verifier':'canWithdrawVerifier','verification-response':'canSubmitVerification',supplement:'canSupplement',appeal:'canAppeal',pause:'canModerate',resume:'canModerate',resolve:'canModerate'};
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),v=>v.toString(16).padStart(2,'0')).join('');

export function createModerationReviewClient({runtime,subjectId,now=()=>Math.floor(Date.now()/1000),locks=globalThis.navigator?.locks}){
 const api=runtime.api,endpoint=api.endpoint,previews=new WeakMap(),authorizationPreviews=new WeakMap();let queue=Promise.resolve();
 const stamp=()=>{const state=api.snapshot();return state?JSON.stringify([api.endpoint,state.subjectId,state.bindingId,state.generation,state.control?.epoch]):null;};
 function capture(){
  const tag=stamp(),reference=runtime.receiptStatus?.captureLease?.();
  if(reference&&(reference.subjectId!==subjectId||reference.endpoint!==endpoint||typeof reference.assertCurrent!=='function'))throw Error('当前复核身份租约不可用。');
  const check=()=>{reference?.assertCurrent();if(!tag||api.endpoint!==endpoint||api.snapshot()?.subjectId!==subjectId||tag!==stamp())throw Error('复核身份或连接已变化，请重新打开。');};
  check();return{tag,check};
 }
 async function owner(lease){lease.check();const status=await runtime.status();lease.check();if(status.identity?.subjectId!==subjectId)throw Error('复核身份或连接已变化，请重新打开。');}
 async function wait(lease,action){await owner(lease);let value;try{value=await action();}catch(error){lease.check();throw error;}await owner(lease);return value;}
 const serial=action=>{const lease=capture(),invoke=()=>wait(lease,()=>action(lease));
  const run=()=>locks?.request?locks.request('moderation-review:'+endpoint+':'+subjectId,{mode:'exclusive'},invoke):invoke();
  const next=queue.then(run,run);queue=next.catch(()=>{});return next;};
 const call=(lease,path,input={})=>wait(lease,()=>api.call(path,input));
 const configWithin=lease=>call(lease,'/v1/moderation/config');
 async function getWithin(lease,id){const result=await call(lease,'/v1/moderation/reports/'+id+'/read');
  if(result?.reportId!==id||!Number.isInteger(result.version)||!Array.isArray(result.events))throw Error('复核记录不匹配。');return result;}
 const key=id=>'moderation-review:'+id;
 async function pendingWithin(lease,id){const record=await wait(lease,()=>runtime.getLocal(key(id),subjectId));
  if(record&&(record.reportId!==id||record.subjectId!==subjectId||record.endpoint!==endpoint))throw Error('原操作的身份、服务或对象不匹配。');return record??null;}
 const save=(lease,id,value)=>wait(lease,()=>runtime.putLocal(key(id),value,subjectId));
 const stoppedKey=id=>'moderation-review-stopped:'+id;
 async function stoppedWithin(lease,id){const records=await wait(lease,()=>runtime.getLocal(stoppedKey(id),subjectId))??[];
  if(!Array.isArray(records)||records.some(record=>record.reportId!==id||record.subjectId!==subjectId||record.endpoint!==endpoint))throw Error('原停止记录不属于当前身份或服务。');return records;}
 const saveStopped=(lease,id,records)=>wait(lease,()=>runtime.putLocal(stoppedKey(id),records,subjectId));
 async function clearStopped(lease,id,eventId){const records=await stoppedWithin(lease,id);if(records.some(record=>record.eventId===eventId))
  await saveStopped(lease,id,records.filter(record=>record.eventId!==eventId));}
 function allowed(current,input){if(input.kind==='correct'){if(!current.canCorrectEventIds?.includes(input.correctsEventId))throw Error('只能更正本人当前可更正的原陈述。');}
  else if(!current[permission[input.kind]])throw Error('当前角色、邀请或来源已变化，此操作暂不可用。');}
 async function original(lease,record){
  const payload=moderationEventSchema.parse(JSON.parse(record.payloadJson));
  if(payload.id!==record.eventId||payload.reportId!==record.reportId||JSON.stringify(payload)!==JSON.stringify(record.payload)
   ||await wait(lease,()=>hash(record.payloadJson))!==record.payloadHash)throw Error('原操作的身份、服务或内容校验不匹配。');
  const intent=record.authorization?.intent,deadline=record.expiresAt??intent?.expiresAt;
  if(intent&&(record.authorization.endpoint!==endpoint||record.authorization.payloadJson!==record.payloadJson||intent.subjectId!==subjectId||intent.endpoint!==endpoint
   ||intent.action!=='moderation.publish'||intent.objectId!==record.eventId||intent.visibility!=='Private'||intent.purpose!=='operational'||intent.recipient!==endpoint
   ||intent.payloadHash!==record.payloadHash||JSON.stringify(intent.fields)!==JSON.stringify(Object.keys(payload))||JSON.stringify(intent.viewers)!==JSON.stringify(record.viewers)
   ||intent.expiresAt!==deadline||record.submission&&(record.submission.consentId!==intent.id||record.submission.payloadJson!==record.payloadJson)))throw Error('原操作内容、受众或授权期限不匹配。');
  return{payload,deadline};
 }
 async function receiptWithin(lease,locator){
  const query=moderationReceiptSchema.parse(locator),result=moderationReceiptResultSchema.parse(await call(lease,
   '/v1/moderation/reports/'+query.reportId+'/receipt',{eventId:query.eventId,payloadHash:query.payloadHash}));
  if(result.reportId!==query.reportId||result.eventId!==query.eventId||result.payloadHash!==query.payloadHash)throw Error('原操作回执格式不匹配，仍保持未知。');
  if(result.state==='conflict')throw Error('服务上的原操作标识对应另一份内容，请保留本机引用。');return result;
 }
 const locator=record=>({reportId:record.reportId,eventId:record.eventId,payloadHash:record.payloadHash});
 async function reconcileWithin(lease,reportId){
  const record=await pendingWithin(lease,reportId);if(!record)return{state:'none'};
  await original(lease,record);const result=await receiptWithin(lease,locator(record));
  if(result.state==='acknowledged'){
   if(result.receipt.version!==record.payload.expectedVersion+1)throw Error('原操作回执与原版本不匹配。');
   await save(lease,reportId,null);
   await clearStopped(lease,reportId,record.eventId);
  }
  return result;
 }
 async function currentOperation(lease,record){const current=await getWithin(lease,record.reportId);allowed(current,record.payload);
  if(current.version!==record.payload.expectedVersion)throw Error('当前记录已变化，原操作保持未确认；不能改写旧请求。');return current;}
 async function send(lease,record){
  await original(lease,record);await currentOperation(lease,record);
  if(record.phase==='stopped-local')throw Error('原操作已停止本机重试。');
  if(!record.authorization){
   record.authorization=await wait(lease,()=>api.prepareAuthorization(record.payloadJson,{action:'moderation.publish',objectId:record.eventId,
    visibility:'Private',viewers:record.viewers,expiresAt:record.expiresAt,confirmed:true}));
   record.authorizationBindingId=record.authorization.intent.bindingId;await save(lease,record.reportId,record);
  }
  if(!record.submission){
   record.phase='authorizing';await save(lease,record.reportId,record);
   record.submission=await wait(lease,()=>api.submitAuthorization(record.authorization,{confirmed:true,reconcile:true}));
   if(record.submission.consentId!==record.authorization.intent.id||record.submission.payloadJson!==record.payloadJson)throw Error('原授权回执不匹配。');
   await save(lease,record.reportId,record);
  }
  record.phase='awaiting-receipt';await save(lease,record.reportId,record);
  const result=await call(lease,'/v1/moderation/reports/'+record.reportId+'/events',record.submission);
  if(result?.reportId!==record.reportId||result.eventId!==record.eventId||result.version!==record.payload.expectedVersion+1)throw Error('原操作回执不匹配，请继续保留引用。');
  await save(lease,record.reportId,null);await clearStopped(lease,record.reportId,record.eventId);return result;
 }
 async function resumeWithin(lease,reportId){
  const record=await pendingWithin(lease,reportId);if(!record)return{state:'none'};
  const result=await reconcileWithin(lease,reportId);if(result.state!=='absent')return result;
  if(record.phase==='stopped-local')return{...result,reason:'stopped-local'};
  const {deadline}=await original(lease,record);
  const blocked=async reason=>{record.blockedReason=reason;await save(lease,reportId,record);return{...result,eventId:record.eventId,reason};};
  if(!Number.isSafeInteger(deadline))return blocked('original-deadline-unavailable');
  if(deadline<=now())return blocked('authorization-expired');
  record.expiresAt=deadline;
  if(record.authorization){
   const accepted=await wait(lease,()=>api.reconcileAuthorization(record.authorization));
   if(accepted.state==='acknowledged'){
    if(accepted.consentId!==record.authorization.intent.id||accepted.payloadJson!==record.payloadJson)throw Error('原授权回执不匹配。');
    record.submission={consentId:accepted.consentId,payloadJson:record.payloadJson};
   }else if(accepted.state!=='absent')throw Error('原授权回执不匹配。');
   else{
    const intent=record.authorization.intent;
    if(intent.bindingId!==api.snapshot().bindingId)return blocked('original-binding-changed');
    if(intent.issuedAt<now()-300){
     record.authorizationHistory=[...(record.authorizationHistory??[]),record.authorization];
     record.authorizationBindingId=intent.bindingId;record.authorization=null;record.submission=null;
    }
   }
  }else if(record.submission)throw Error('原授权回执不匹配。');
  if(!record.authorization&&(!record.authorizationBindingId||record.authorizationBindingId!==api.snapshot().bindingId))
   return blocked(record.authorizationBindingId?'original-binding-changed':'original-binding-unavailable');
  delete record.blockedReason;await save(lease,reportId,record);const ack=await send(lease,record);return{state:'acknowledged',receipt:ack};
 }
 function prepare(input){return serial(async lease=>{
  const prior=await pendingWithin(lease,input.reportId);
  if(prior?.phase==='stopped-local'){
   // Older clients kept explicitly stopped bytes in the active slot. Keep
   // their exact locator/body in the same independent archive before editing.
   const result=await reconcileWithin(lease,input.reportId);
   if(result.state!=='acknowledged'){
    const records=await stoppedWithin(lease,input.reportId);
    await saveStopped(lease,input.reportId,[...records.filter(item=>item.eventId!==prior.eventId),prior]);
    await save(lease,input.reportId,null);
   }
  }else if(prior)throw Error('请先核对本机保留的原操作。');
  const [config,current]=await Promise.all([configWithin(lease),getWithin(lease,input.reportId)]);allowed(current,input);
  if(!config.moderatorIds?.length)throw Error('此服务尚未配置复核处理者。');
  const fields={...input};if(input.kind==='invite-verifier'){
   const report=current.report;if(!report)throw Error('原举报说明当前不可读取。');
   fields.target=report.caseId?{caseId:report.caseId,caseVersion:report.caseVersion,targetEventId:report.targetEventId,...(report.evidenceId?{evidenceId:report.evidenceId}:{})}:{assistanceId:report.assistanceId};
  }else if(['accept-verifier','decline-verifier','withdraw-verifier','verification-response'].includes(input.kind)){
   const own=current.verifierParticipation?.own;if(!own?.invitationId)throw Error('当前没有可用的本人邀请。');fields.invitationId=own.invitationId;
  }
  const payload=moderationEventSchema.parse({...fields,id:crypto.randomUUID(),expectedVersion:current.version}),payloadJson=JSON.stringify(payload);
  const viewers=[...new Set([...config.moderatorIds,...(input.kind==='appeal'||['supplement','correct'].includes(input.kind)&&current.canAppeal?[]:
   [current.reporterId,...(current.participantIds??[])]),...(input.kind==='invite-verifier'?[input.verifierId]:[])])].filter(id=>id&&id!==subjectId).sort((a,b)=>a.localeCompare(b));
  if(!viewers.length)throw Error('此操作没有可用的必要接收人。');
  const preview=Object.freeze({endpoint,subjectId,reportId:input.reportId,eventId:payload.id,payload,payloadJson,
   payloadHash:await wait(lease,()=>hash(payloadJson)),viewers,expiresAt:now()+3600});
  previews.set(preview,{state:'prepared',lease,exact:JSON.stringify(preview)});return preview;
 });}
 function execute(preview,{confirmed=false}={}){return serial(async lease=>{
  const state=previews.get(preview);if(!confirmed||state?.state!=='prepared'||state.exact!==JSON.stringify(preview))throw Error('请确认当前连接下预览的内容与接收人。');
  try{state.lease.check();}catch{throw Error('请确认当前连接下预览的内容与接收人。');}
  state.state='executing';if(await pendingWithin(lease,preview.reportId))throw Error('已有待核对的原操作。');
  const current=await getWithin(lease,preview.reportId);allowed(current,preview.payload);
  if(current.version!==preview.payload.expectedVersion)throw Error('记录已更新，请重新读取并预览。');
  const record={...structuredClone(preview),phase:'prepared',authorizationBindingId:api.snapshot().bindingId};
  await save(lease,record.reportId,record);const result=await send(lease,record);state.state='complete';return result;
 });}
 function reviewAuthorization(reportId){return serial(async lease=>{
  const record=await pendingWithin(lease,reportId);if(!record)return{state:'none'};
  const result=await reconcileWithin(lease,reportId);if(result.state!=='absent')return result;
  if(record.phase==='stopped-local')return{...result,reason:'stopped-local'};
  const checked=await original(lease,record);await currentOperation(lease,record);
  if(record.authorization){const accepted=await wait(lease,()=>api.reconcileAuthorization(record.authorization));
   if(accepted.state!=='absent')return{state:'reuse-original-authorization',reportId,eventId:record.eventId};}
  const preview={state:'reauthorization-required',reportId,eventId:record.eventId,payload:structuredClone(record.payload),payloadHash:record.payloadHash,
   viewers:[...record.viewers],priorConsentId:record.authorization?.intent.id??null,expiresAt:checked.deadline>now()?checked.deadline:now()+3600,
   originalExpiresAt:checked.deadline??null};
  authorizationPreviews.set(preview,{serialized:JSON.stringify(preview),lease});return preview;
 });}
 function reauthorize(preview,{confirmed=false}={}){return serial(async lease=>{
  const saved=authorizationPreviews.get(preview);if(!confirmed||!saved||saved.serialized!==JSON.stringify(preview))throw Error('请确认展示的原内容与授权期限。');
  saved.lease.check();const record=await pendingWithin(lease,preview.reportId);
  if(!record||record.phase==='stopped-local'||record.eventId!==preview.eventId||record.payloadHash!==preview.payloadHash
   ||(record.authorization?.intent.id??null)!==preview.priorConsentId||JSON.stringify(record.payload)!==JSON.stringify(preview.payload)
   ||JSON.stringify(record.viewers)!==JSON.stringify(preview.viewers))throw Error('原操作已改变。');
  const result=await reconcileWithin(lease,record.reportId);if(result.state!=='absent')return result;
  await original(lease,record);await currentOperation(lease,record);
  if(record.authorization){const accepted=await wait(lease,()=>api.reconcileAuthorization(record.authorization));
   if(accepted.state!=='absent')return resumeWithin(lease,record.reportId);}
  const replacement=await wait(lease,()=>api.prepareAuthorization(record.payloadJson,{action:'moderation.publish',objectId:record.eventId,
   visibility:'Private',viewers:record.viewers,expiresAt:preview.expiresAt,confirmed:true}));
  record.authorizationHistory=[...(record.authorizationHistory??[]),...(record.authorization?[record.authorization]:[])];
  record.authorization=replacement;record.submission=null;record.expiresAt=preview.expiresAt;record.authorizationBindingId=replacement.intent.bindingId;
  delete record.blockedReason;authorizationPreviews.delete(preview);await save(lease,record.reportId,record);
  return{state:'acknowledged',receipt:await send(lease,record)};
 });}
 function stop(reportId,{confirmed=false}={}){if(!confirmed)throw Error('需要明确停止本机重试。');return serial(async lease=>{
  const record=await pendingWithin(lease,reportId);if(!record)return{state:'none',serverCancellationConfirmed:false};
  const result=await reconcileWithin(lease,reportId);if(result.state==='acknowledged')return result;
  record.phase='stopped-local';const records=await stoppedWithin(lease,reportId);
  await saveStopped(lease,reportId,[...records.filter(item=>item.eventId!==record.eventId),record]);await save(lease,reportId,null);
  return{...locator(record),state:'stopped-local',serverCancellationConfirmed:false};
 });}
 function continueStopped(input,{confirmed=false}={}){return serial(async lease=>{
  if(!confirmed)throw Error('请明确继续这条原说明。');const query=moderationReceiptSchema.parse(input),records=await stoppedWithin(lease,query.reportId);
  const pending=await pendingWithin(lease,query.reportId),candidates=[...records,...pending?.phase==='stopped-local'?[pending]:[]];
  const record=candidates.find(item=>item.eventId===query.eventId&&item.payloadHash===query.payloadHash);
  if(!record)throw Error('原停止记录不存在或已改变。');
  const result=await receiptWithin(lease,query);if(result.state==='acknowledged'){
   await clearStopped(lease,query.reportId,query.eventId);if(pending?.eventId===query.eventId)await save(lease,query.reportId,null);return result;}
  if(pending&&pending.eventId!==query.eventId)throw Error('请先处理当前另一条原操作。');
  await original(lease,record);record.phase='prepared';delete record.blockedReason;await save(lease,query.reportId,record);
  return resumeWithin(lease,query.reportId);
 });}
 return Object.freeze({prepare,execute,reviewAuthorization,reauthorize,stop,
  continueStopped,
  async stopped(reportId){const lease=capture(),records=await stoppedWithin(lease,reportId),active=await pendingWithin(lease,reportId);
   const retained=[...records.filter(record=>record.eventId!==active?.eventId),...active?.phase==='stopped-local'?[active]:[]];
   return retained.map(record=>({...locator(record),state:'stopped-local',kind:record.payload.kind,
    target:record.payload.target??null,expiresAt:record.expiresAt??record.authorization?.intent.expiresAt??null,canContinue:typeof record.payloadJson==='string',serverCancellationConfirmed:false}));},
  config:()=>configWithin(capture()),get:id=>getWithin(capture(),id),query:input=>call(capture(),'/v1/moderation/reports/query',input),
  async pending(id){const lease=capture(),record=await pendingWithin(lease,id);return record?{...record,originalBindingId:record.authorization?.intent.bindingId??record.authorizationBindingId??null}:null;},
  reconcile:reportId=>serial(lease=>reconcileWithin(lease,reportId)),
  resumePending:reportId=>serial(lease=>resumeWithin(lease,reportId)),
  retry(reportId,{confirmed=false}={}){if(!confirmed)throw Error('需要明确确认继续同一原操作。');return serial(lease=>resumeWithin(lease,reportId));},
  receipt:input=>receiptWithin(capture(),input),
 });
}
