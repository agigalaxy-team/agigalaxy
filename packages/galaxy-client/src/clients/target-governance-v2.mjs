import { targetReportSchemaV2, targetModerationSchemaV2, targetGovernanceReceiptSchemaV2 } from "../../../galaxy-contracts/src/target-governance-v2-schema.mjs";
import { sha256Hex } from "../../../galaxy-contracts/src/web-primitives.mjs";

// The existing identity/Consent client owns signing. The durable journal fixes
// each pending operation's original ID, payload bytes and exact receipt hash.
export function createTargetGovernanceClientV2({
 api, getLocal, putLocal, subjectId, receiptStatus,
 locks=globalThis.navigator?.locks, now=()=>Math.floor(Date.now()/1000),
}) {
 const endpoint=api.endpoint,key=`target-governance:${endpoint}:${subjectId}`;
 const previews=new WeakMap(),authorizationPreviews=new WeakMap();let queue=Promise.resolve();
 const checkOwner=()=>{
  const current=api.snapshot();
  if(api.endpoint!==endpoint||current?.subjectId!==subjectId)throw new Error('治理操作的身份或连接已改变。');
  return current;
 };
 function captureLease(){
  const original=checkOwner(),runtimeLease=receiptStatus?.captureLease?.();
  if(runtimeLease&&(runtimeLease.subjectId!==subjectId||runtimeLease.endpoint!==endpoint||typeof runtimeLease.assertCurrent!=='function'))
   throw new Error('当前治理身份租约不可用。');
  const check=()=>{
   runtimeLease?.assertCurrent();const current=checkOwner();
   if(['subjectId','endpoint','bindingId','generation'].some(field=>original[field]!==current[field]))
    throw new Error('治理操作的身份或连接已改变，原操作已保留，请重新核对。');
  };
  check();
  return{check,async wait(action){
   check();let result;try{result=await action();}catch(error){check();throw error;}check();return result;
  }};
 }
 const serial=fn=>{
  // Fix the lease before either the local queue or cross-tab lock waits.
  const lease=captureLease(),invoke=()=>{lease.check();return fn(lease);};
  const work=()=>locks?.request?locks.request(key,{mode:'exclusive'},invoke):invoke();
  const result=queue.then(work,work);queue=result.catch(()=>{});return result;
 };
 const load=async lease=>{
  const row=await lease.wait(()=>getLocal(key));
  if(row&&(row.subjectId&&row.subjectId!==subjectId||row.endpoint&&row.endpoint!==endpoint))
   throw new Error('本机原治理操作不属于当前身份或站点。');
  return row??{active:null,stopped:[]};
 };
 const save=(row,lease)=>lease.wait(()=>putLocal(key,{...row,subjectId,endpoint}));
 const call=(lease,path,input,options)=>lease.wait(()=>api.call(path,input,options));
 async function receipt(op,lease){
  const input=targetGovernanceReceiptSchemaV2.parse({eventId:op.operationId,payloadHash:op.payloadHash});
  const result=await call(lease,'/v2/target-governance/receipt',input);
  if(result.eventId!==op.operationId||!['absent','acknowledged','conflict'].includes(result.state))
   throw new Error('原操作回执不匹配。');
  if(result.state==='conflict')throw new Error('同号内容冲突，保留原操作核对。');
  return result;
 }
 async function original(op,lease){
  const payload=(op.type==='report'?targetReportSchemaV2:targetModerationSchemaV2).parse(JSON.parse(op.payloadJson));
  if(!['report','event'].includes(op.type)||payload.id!==op.operationId||await lease.wait(()=>sha256Hex(op.payloadJson))!==op.payloadHash)
   throw new Error('保存的操作内容已改变。');
  const intent=op.prepared?.intent,deadline=op.expiresAt??intent?.expiresAt;
  if(intent&&(op.prepared.endpoint!==endpoint||op.prepared.payloadJson!==op.payloadJson||intent.subjectId!==subjectId||intent.endpoint!==endpoint
   ||intent.objectId!==op.operationId||intent.action!=='moderation.publish'||intent.visibility!=='Private'||intent.purpose!=='operational'
   ||intent.recipient!==endpoint||intent.payloadHash!==op.payloadHash||JSON.stringify(intent.fields)!==JSON.stringify(Object.keys(payload))
   ||JSON.stringify(intent.viewers)!==JSON.stringify(op.viewers)||intent.expiresAt!==deadline
   ||op.submission&&(op.submission.consentId!==intent.id||op.submission.payloadJson!==op.payloadJson)))
   throw new Error('原操作内容、受众或授权期限不匹配。');
  return{payload,deadline};
 }
 async function clear(op,lease){
  const state=await load(lease);if(state.active?.operationId===op.operationId)state.active=null;
  // Clear private retry bytes, but keep an accepted fact's body-free locator.
  // An interrupted local completion cannot cancel the service operation.
  state.stopped=[...state.stopped.filter(item=>item.operationId!==op.operationId),{
   operationId:op.operationId,type:op.type,payloadHash:op.payloadHash,state:'acknowledged',
  }];
  state.retainedStopped=(state.retainedStopped??[]).filter(item=>item.operationId!==op.operationId);
  await save(state,lease);
 }
 async function send(op,lease){
  try{
   await original(op,lease);
   if(!op.prepared){
    op.prepared=await lease.wait(()=>api.prepareAuthorization(op.payloadJson,{
     action:'moderation.publish',objectId:op.operationId,visibility:'Private',viewers:op.viewers,confirmed:true,
     ...(op.expiresAt?{expiresAt:op.expiresAt}:{}),
    }));
    op.expiresAt=op.prepared.intent.expiresAt;op.authorizationBindingId=op.prepared.intent.bindingId;
    await save({...await load(lease),active:op},lease);
   }
   if(!op.submission){
    const reconcile=op.authorizationAttempted===true;op.authorizationAttempted=true;
    await save({...await load(lease),active:op},lease);
    op.submission=await lease.wait(()=>api.submitAuthorization(op.prepared,{confirmed:true,reconcile}));
    if(op.submission.payloadJson!==op.payloadJson||op.submission.consentId!==op.prepared.intent.id)throw new Error('原授权回执不匹配。');
    await save({...await load(lease),active:op},lease);
   }
   op.businessAttempted=true;await save({...await load(lease),active:op},lease);
   await call(lease,op.type==='report'?'/v2/target-governance/reports':'/v2/target-governance/events',op.submission);
   const result=await receipt(op,lease);
   if(result.state!=='acknowledged')throw new Error('结果未确认，请查询原操作。');
   await clear(op,lease);lease.check();return result;
  }catch(error){throw Object.assign(error,{operationId:op.operationId,resultUnknown:error.outcome!=='rejected'});}
 }
 async function resume(id,lease){
  const state=await load(lease),op=id===null?state.active:state.active?.operationId===id?state.active:state.stopped.find(item=>item.operationId===id);
  if(!op)return{state:'none'};
  const result=await receipt(op,lease);if(result.state==='acknowledged'){await clear(op,lease);return result;}
  if(op!==state.active)return{...result,reason:op.state==='stopped-local'?'stopped-local':'original-receipt-unavailable'};
  const {deadline}=await original(op,lease);
  const blocked=async reason=>{op.blockedReason=reason;await save({...await load(lease),active:op},lease);return{...result,operationId:op.operationId,reason};};
  if(!Number.isSafeInteger(deadline))return blocked('original-deadline-unavailable');
  if(deadline<=now())return blocked('authorization-expired');
  op.expiresAt=deadline;
  if(op.prepared){
   const accepted=await lease.wait(()=>api.reconcileAuthorization(op.prepared));
   if(accepted.state==='acknowledged'){
    if(accepted.consentId!==op.prepared.intent.id||accepted.payloadJson!==op.payloadJson)throw new Error('原授权回执不匹配。');
    op.submission={consentId:accepted.consentId,payloadJson:op.payloadJson};
   }else if(accepted.state!=='absent')throw new Error('原授权回执不匹配。');
   else{
    const intent=op.prepared.intent;
    if(intent.bindingId!==checkOwner().bindingId)return blocked('original-binding-changed');
    if(intent.issuedAt<now()-300){
     op.previousAuthorizations=[...(op.previousAuthorizations??[]),op.prepared];
     op.authorizationBindingId=intent.bindingId;op.prepared=null;op.submission=null;op.authorizationAttempted=false;
    }
   }
  }else if(op.submission)throw new Error('原授权回执不匹配。');
  if(!op.prepared&&(!op.authorizationBindingId||op.authorizationBindingId!==checkOwner().bindingId))
   return blocked(op.authorizationBindingId?'original-binding-changed':'original-binding-unavailable');
  delete op.blockedReason;await save({...await load(lease),active:op},lease);return send(op,lease);
 }
 return{
  /** @param {string} type @param {unknown} input @param {{viewers?: string[],expiresAt?:number}} options */
  async prepare(type,input,{viewers=[],expiresAt=now()+2591900}={}){
   const lease=captureLease();if(!['report','event'].includes(type))throw new Error('治理操作类型无效。');
   const payload=(type==='report'?targetReportSchemaV2:targetModerationSchemaV2).parse(input);
   const selected=[...new Set(viewers.filter(id=>id!==subjectId))];
   if(selected.length>16||selected.some(id=>!/^GUID[0-9A-Z]{28}$/.test(id)))throw new Error('请选择最多16位明确受众。');
   const payloadJson=JSON.stringify(payload),op={
    type,operationId:payload.id,payloadJson,payloadHash:await lease.wait(()=>sha256Hex(payloadJson)),viewers:selected,expiresAt,
   };
   const preview=structuredClone({...op,payload,subjectId,endpoint});
   previews.set(preview,{op,lease,serialized:JSON.stringify(preview)});return preview;
  },
  execute(preview,{confirmed=false}={}){return serial(async lease=>{
   const saved=previews.get(preview);
   if(!confirmed||!saved||saved.serialized!==JSON.stringify(preview))throw new Error('请核对本次准确预览。');
   saved.lease.check();const state=await load(lease);
   if(state.active)throw new Error('请先处理原操作回执。');
   saved.op.authorizationBindingId=checkOwner().bindingId;
   previews.delete(preview);await save({...state,active:saved.op},lease);return send(saved.op,lease);
  });},
  async pending(){
   const lease=captureLease(),state=await load(lease);
   return[...(state.active?[{operationId:state.active.operationId,type:state.active.type,
    payload:JSON.parse(state.active.payloadJson),payloadHash:state.active.payloadHash,viewers:state.active.viewers,state:'awaiting-receipt',
    expiresAt:state.active.expiresAt??state.active.prepared?.intent.expiresAt??null,
    originalBindingId:state.active.prepared?.intent.bindingId??state.active.authorizationBindingId??null,
    blockedReason:state.active.blockedReason??null}]:[]),
    ...state.stopped.filter(item=>item.state!=='acknowledged')];
  },
  reconcile(id){return serial(async lease=>{
   const state=await load(lease),op=state.active?.operationId===id?state.active:state.stopped.find(item=>item.operationId===id);
   if(!op)throw new Error('原操作不存在。');
   const result=await receipt(op,lease);if(result.state==='acknowledged')await clear(op,lease);lease.check();return result;
  });},
  retry(id,{confirmed=false}={}){return serial(async lease=>{
   const op=(await load(lease)).active;if(!confirmed||op?.operationId!==id)throw new Error('请确认重试保存的原操作。');
   return resume(id,lease);
  });},
  /** @param {string|null} id */
  resumePending(id=null){return serial(lease=>resume(id,lease));},
  /** @param {{operationId:string,payloadHash:string,type?:string,reportId?:string}} locator */
  async receipt(locator){const result=await receipt(locator,captureLease());
   if(locator.reportId&&result.state==='acknowledged'&&result.reportId!==locator.reportId)throw new Error('原操作回执不匹配。');
   return result;},
  async stopped(){const lease=captureLease(),state=await load(lease);
   return state.stopped.filter(item=>item.state==='stopped-local'&&item.operationId!==state.active?.operationId).map(item=>{
    const retained=(state.retainedStopped??[]).find(op=>op.operationId===item.operationId&&op.payloadHash===item.payloadHash);
    const payload=retained?JSON.parse(retained.payloadJson):null;
    return{...item,reportId:item.reportId??(item.type==='report'?item.operationId:payload?.reportId??null),target:item.target??payload?.target??null,
     expiresAt:retained?.expiresAt??retained?.prepared?.intent.expiresAt??null,canContinue:!!retained};
   });},
  /** @param {{operationId:string,payloadHash:string}} locator @param {{confirmed?:boolean}} options */
  continueStopped(locator,{confirmed=false}={}){return serial(async lease=>{
   if(!confirmed)throw new Error('请明确继续这条原说明。');
   const state=await load(lease),stored=state.stopped.find(item=>item.operationId===locator.operationId&&item.payloadHash===locator.payloadHash);
   if(!stored)throw new Error('原停止记录不存在或已改变。');
   const result=await receipt(stored,lease);if(result.state==='acknowledged'){await clear(stored,lease);return result;}
   if(state.active&&state.active.operationId!==locator.operationId)throw new Error('请先处理当前另一条原操作。');
   const retained=state.active??(state.retainedStopped??[]).find(item=>item.operationId===locator.operationId&&item.payloadHash===locator.payloadHash);
   if(!retained)return{...result,reason:'original-content-unavailable'};
   await original(retained,lease);delete retained.blockedReason;
   await save({...state,active:retained},lease);return resume(locator.operationId,lease);
  });},
  reviewAuthorization(id){return serial(async lease=>{
   const op=(await load(lease)).active;if(op?.operationId!==id)throw new Error('原授权不可用。');
   const result=await receipt(op,lease);if(result.state==='acknowledged'){await clear(op,lease);lease.check();return result;}
   const checked=await original(op,lease);
   if(op.prepared){const accepted=await lease.wait(()=>api.reconcileAuthorization(op.prepared));
    if(accepted.state!=='absent')return{state:'reuse-original-authorization',operationId:id};}
   const preview={state:'reauthorization-required',operationId:id,priorConsentId:op.prepared?.intent.id??null,
    payload:JSON.parse(op.payloadJson),payloadHash:op.payloadHash,viewers:[...op.viewers],
    expiresAt:checked.deadline>now()?checked.deadline:now()+300,originalExpiresAt:checked.deadline??null};
   authorizationPreviews.set(preview,{serialized:JSON.stringify(preview),lease});return preview;
  });},
  reauthorize(preview,{confirmed=false}={}){return serial(async lease=>{
   const saved=authorizationPreviews.get(preview);
   if(!confirmed||!saved||saved.serialized!==JSON.stringify(preview))throw new Error('请确认展示的原内容与新授权期限。');
   saved.lease.check();const op=(await load(lease)).active;
   if(op?.operationId!==preview.operationId||(op.prepared?.intent.id??null)!==preview.priorConsentId||op.payloadHash!==preview.payloadHash
    ||JSON.stringify(JSON.parse(op.payloadJson))!==JSON.stringify(preview.payload)||JSON.stringify(op.viewers)!==JSON.stringify(preview.viewers))
    throw new Error('原操作已改变。');
   const result=await receipt(op,lease);if(result.state==='acknowledged'){await clear(op,lease);lease.check();return result;}
   await original(op,lease);
   if(op.prepared){const accepted=await lease.wait(()=>api.reconcileAuthorization(op.prepared));
    if(accepted.state!=='absent')throw new Error('原授权已存在，请沿用原授权重试。');}
   const replacement=await lease.wait(()=>api.prepareAuthorization(op.payloadJson,{
    action:'moderation.publish',objectId:op.operationId,visibility:'Private',viewers:op.viewers,
    expiresAt:preview.expiresAt,confirmed:true,
   }));
   authorizationPreviews.delete(preview);
   op.previousAuthorizations=[...(op.previousAuthorizations??[]),...(op.prepared?[op.prepared]:[])];op.prepared=replacement;op.authorizationAttempted=false;
   op.submission=null;op.expiresAt=preview.expiresAt;op.authorizationBindingId=replacement.intent.bindingId;delete op.blockedReason;
   await save({...await load(lease),active:op},lease);return send(op,lease);
  });},
  stopLocalRetry(id,{confirmed=false}={}){return serial(async lease=>{
   const state=await load(lease),op=state.active;
   if(!confirmed||op?.operationId!==id)throw new Error('请确认停止本机重试。');
   const result=await receipt(op,lease);if(result.state==='acknowledged'){await clear(op,lease);lease.check();return result;}
   const payload=JSON.parse(op.payloadJson),record={operationId:op.operationId,type:op.type,payloadHash:op.payloadHash,state:'stopped-local',serverCancellationConfirmed:false,
    reportId:op.type==='report'?op.operationId:payload.reportId,target:payload.target??null};
   await save({...state,active:null,stopped:[...state.stopped.filter(item=>item.operationId!==op.operationId),record],
    retainedStopped:[...(state.retainedStopped??[]).filter(item=>item.operationId!==op.operationId),op]},lease);lease.check();return record;
  });},
  config:()=>call(captureLease(),'/v2/target-governance/config',undefined,{method:'GET'}),
  target:input=>call(captureLease(),'/v2/target-governance/target',input),
  query:input=>call(captureLease(),'/v2/target-governance/query',input),
  get:id=>call(captureLease(),`/v2/target-governance/${id}`,undefined,{method:'GET'}),
 };
}
