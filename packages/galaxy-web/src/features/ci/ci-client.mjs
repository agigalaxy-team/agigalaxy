import {ciRequestV2Schema,ciProofV2Schema,ciSourceMetadata} from "../../../../galaxy-contracts/src/ci-observation-v2-schema.mjs";
import {githubReference} from "../../../../galaxy-contracts/src/github-evidence-schema.mjs";
import {sha256Hex} from "../../../../galaxy-contracts/src/web-primitives.mjs";
const clients=new WeakMap();
export function ciSourceFromEvidence(view){
  const record=view?.record;if(view?.referenceStatus!=='current'||record?.kind!=='evidence'||record.evidenceType!=='ci-result'||record.source.originSystem!=='github-actions')return null;
  const match=/^github-actions:([^/:]+)\/([^/:]+):run:([0-9]+):attempt:([0-9]+)$/.exec(record.source.externalStableId);if(!match)return null;
  const parsed=githubReference.safeParse({provider:'github-actions',owner:match[1],repository:match[2],runId:Number(match[3]),attempt:Number(match[4]),commit:record.source.contentVersion});
  if(!parsed.success||!Object.entries(ciSourceMetadata(parsed.data)).every(([k,v])=>record.source[k]===v))return null;return parsed.data;
}
export function getCiClient(runtime,subjectId,{now=()=>Math.floor(Date.now()/1000),locks=globalThis.navigator?.locks}={}){
 let owners=clients.get(runtime);if(!owners){owners=new Map();clients.set(runtime,owners);}if(owners.has(subjectId))return owners.get(subjectId);
 const api=runtime.api,endpoint=api.endpoint,key=`ci-operations:${subjectId}`,authorizationPreviews=new WeakMap();let queue=Promise.resolve();
 const stamp=()=>{const state=api.snapshot();return state?JSON.stringify([api.endpoint,state.subjectId,state.bindingId,state.generation,state.control?.deviceId,state.control?.keyId,state.control?.epoch]):null;};
 function capture(){const tag=stamp(),reference=runtime.receiptStatus?.captureLease?.();
  if(reference&&(reference.subjectId!==subjectId||reference.endpoint!==endpoint||typeof reference.assertCurrent!=='function'))throw Error('当前 CI 身份租约不可用。');
  const check=()=>{reference?.assertCurrent();if(!tag||api.endpoint!==endpoint||api.snapshot()?.subjectId!==subjectId||tag!==stamp())throw Error('身份或连接已变化，请重新打开 CI 记录。');};check();return{check};}
 async function guard(lease,fn){lease.check();let value;try{value=await fn();}catch(error){lease.check();throw error;}lease.check();return value;}
 const serial=fn=>{const lease=capture(),invoke=()=>guard(lease,()=>fn(lease)),run=()=>locks?.request?locks.request('ci:'+endpoint+':'+subjectId,{mode:'exclusive'},invoke):invoke();
  const next=queue.then(run,run);queue=next.catch(()=>{});return next;};
 const call=(lease,path,input)=>guard(lease,()=>api.call(path,input));
 const localWithin=async lease=>{const state=await guard(lease,()=>runtime.getLocal(key,subjectId));
  if(state&&(!Array.isArray(state.requests)||!Array.isArray(state.proofs)))throw Error('本机 CI 记录格式不匹配，请保留原记录。');return state??{pending:null,requests:[],proofs:[]};};
 const save=(lease,state)=>guard(lease,()=>runtime.putLocal(key,state,subjectId));
 const savePending=async(lease,record)=>save(lease,{...await localWithin(lease),pending:record});
 const action=record=>record.type==='request'?'ci.observe':'proof.publish';
 async function original(lease,record){
  if(!['request','proof'].includes(record.type)||!['Private','Public'].includes(record.visibility)||typeof record.payloadJson!=='string')throw Error('原 CI 操作格式不匹配。');
  const payload=JSON.parse(record.payloadJson);(record.type==='request'?ciRequestV2Schema:ciProofV2Schema).parse(payload);
  if(JSON.stringify(payload)!==JSON.stringify(record.payload)||record.type==='request'&&record.visibility!=='Private'
   ||await guard(lease,()=>sha256Hex(record.payloadJson))!==record.payloadHash)throw Error('原 CI 内容或字节校验不匹配。');
  const intent=record.prepared?.intent,viewers=record.viewers??[],deadline=record.expiresAt??intent?.expiresAt;
  if(intent&&(record.prepared.endpoint!==endpoint||record.prepared.payloadJson!==record.payloadJson||intent.endpoint!==endpoint||intent.subjectId!==subjectId
   ||intent.objectId!==payload.id||intent.action!==action(record)||intent.payloadHash!==record.payloadHash||intent.recipient!==endpoint
   ||intent.visibility!==record.visibility||intent.purpose!==(record.visibility==='Public'?'public-profile':'operational')
   ||JSON.stringify(intent.fields)!==JSON.stringify(Object.keys(payload))||JSON.stringify(intent.viewers)!==JSON.stringify(viewers)
   ||record.expiresAt!==undefined&&record.expiresAt!==intent.expiresAt))throw Error('原 CI 授权范围不匹配。');
  if(record.submission&&(record.submission.payloadJson!==record.payloadJson||intent&&record.submission.consentId!==intent.id))throw Error('原 CI 授权回执不匹配。');
  return{payload,viewers,deadline};
 }
 async function remember(lease,record){const state=await localWithin(lease),field=record.type==='request'?'requests':'proofs';
  if(state.pending&&(state.pending.payload.id!==record.payload.id||state.pending.payloadHash!==record.payloadHash))throw Error('本机 CI 原操作已改变，请读取当前记录。');
  const item=record.type==='request'?{id:record.payload.id,caseId:record.payload.caseId,evidenceRef:record.payload.evidenceRef,resultRef:record.payload.resultRef}
   :{id:record.payload.id,requestId:record.payload.bindingId,visibility:record.visibility};
  await save(lease,{...state,pending:null,[field]:[item,...state[field].filter(prior=>prior.id!==item.id)]});return{id:item.id,state:'recorded'};
 }
 async function receipt(lease,record){await original(lease,record);const result=await call(lease,'/v2/ci/receipts',{type:record.type,id:record.payload.id});
  if(result.id!==record.payload.id||result.type!==record.type||!['recorded','absent'].includes(result.state))throw Error('原 CI 操作回执不匹配。');
  if(result.state==='recorded'){
   if(result.payloadHash!==record.payloadHash||record.prepared&&result.consentId!==record.prepared.intent.id)throw Error('发现不同内容或许可的同号操作，请保留记录核对。');
   return remember(lease,record);
  }return{state:'unconfirmed',id:record.payload.id};
 }
 function proofExpired(record){return record.type==='proof'&&(record.payload.preparedAt<now()-300||record.payload.expiresAt<=now());}
 async function send(lease,record){await original(lease,record);
  if(!record.prepared){record.prepared=await guard(lease,()=>api.prepareAuthorization(record.payloadJson,{action:action(record),objectId:record.payload.id,
   visibility:record.visibility,viewers:record.viewers??[],expiresAt:record.expiresAt,confirmed:true}));
   record.authorizationBindingId=record.prepared.intent.bindingId;record.authorizationAttempted=false;await savePending(lease,record);}
  if(!record.submission){const reconcile=record.authorizationAttempted===true;record.authorizationAttempted=true;await savePending(lease,record);
   record.submission=await guard(lease,()=>api.submitAuthorization(record.prepared,{confirmed:true,reconcile}));
   if(record.submission.consentId!==record.prepared.intent.id||record.submission.payloadJson!==record.payloadJson)throw Error('原 CI 授权回执不匹配。');await savePending(lease,record);}
  const result=await call(lease,record.type==='request'?'/v2/ci/requests':'/v2/ci/proofs/publish',record.submission);
  if((result.requestId??result.proofId)!==record.payload.id)throw Error('回执不匹配，请查询原操作。');await remember(lease,record);return result;
 }
 async function resumeWithin(lease){const record=(await localWithin(lease)).pending;if(!record)return{state:'none'};
  const checked=await receipt(lease,record);if(checked.state==='recorded')return checked;
  const {deadline}=await original(lease,record),blocked=async reason=>{record.blockedReason=reason;await savePending(lease,record);return{state:'unconfirmed',id:record.payload.id,reason};};
  if(!Number.isSafeInteger(deadline))return blocked('original-deadline-unavailable');
  if(deadline<=now())return blocked('authorization-expired');
  if(proofExpired(record))return blocked('proof-preview-expired');record.expiresAt=deadline;
  if(record.prepared){const accepted=await guard(lease,()=>api.reconcileAuthorization(record.prepared));
   if(accepted.state==='acknowledged'){
    if(accepted.consentId!==record.prepared.intent.id||accepted.payloadJson!==record.payloadJson)throw Error('原 CI 授权回执不匹配。');
    record.submission={consentId:accepted.consentId,payloadJson:record.payloadJson};
   }else if(accepted.state==='absent'){
    const intent=record.prepared.intent;if(intent.bindingId!==api.snapshot().bindingId)return blocked('original-binding-changed');
    if(intent.issuedAt<now()-300){record.authorizationHistory=[...(record.authorizationHistory??[]),record.prepared];record.authorizationBindingId=intent.bindingId;
     record.prepared=null;record.submission=null;record.authorizationAttempted=false;}
   }else throw Error('原 CI 授权回执不匹配。');
  }else if(record.submission)throw Error('原 CI 授权依据暂不可用。');
  if(!record.prepared&&(!record.authorizationBindingId||record.authorizationBindingId!==api.snapshot().bindingId))
   return blocked(record.authorizationBindingId?'original-binding-changed':'original-binding-unavailable');
  delete record.blockedReason;await savePending(lease,record);return{state:'recorded',id:record.payload.id,result:await send(lease,record)};
 }
 async function reviewWithin(lease){const record=(await localWithin(lease)).pending;if(!record)return null;
  const {payload,viewers,deadline}=await original(lease,record);return{type:record.type,id:payload.id,payload,payloadHash:record.payloadHash,visibility:record.visibility,
   viewers:structuredClone(viewers),expiresAt:deadline??null,state:'unconfirmed',reason:record.blockedReason??null,originalBindingId:record.prepared?.intent.bindingId??record.authorizationBindingId??null};
 }
 async function reviewAuthorizationWithin(lease){const record=(await localWithin(lease)).pending;if(!record)return{state:'none'};
  const checked=await receipt(lease,record);if(checked.state==='recorded')return checked;
  const originalScope=await original(lease,record);if(proofExpired(record))return{...await reviewWithin(lease),state:'proof-preview-expired',reason:'proof-preview-expired'};
  if(record.prepared){const accepted=await guard(lease,()=>api.reconcileAuthorization(record.prepared));
   if(accepted.state==='acknowledged')return{state:'reuse-original-authorization',id:record.payload.id};if(accepted.state!=='absent')throw Error('原 CI 授权回执不匹配。');}
  const expiresAt=originalScope.deadline>now()?originalScope.deadline:now()+2591900;
  const preview={state:'reauthorization-required',endpoint,subjectId,type:record.type,id:record.payload.id,payload:structuredClone(record.payload),payloadHash:record.payloadHash,
   visibility:record.visibility,viewers:structuredClone(originalScope.viewers),expiresAt,originalExpiresAt:originalScope.deadline??null,priorConsentId:record.prepared?.intent.id??null};
  authorizationPreviews.set(preview,{lease,exact:JSON.stringify(preview),payloadJson:record.payloadJson});return preview;
 }
 async function reauthorizeWithin(lease,preview,{confirmed=false}={}){
  const token=authorizationPreviews.get(preview);if(!confirmed||!token||token.exact!==JSON.stringify(preview))throw Error('请先查看并确认原 CI 内容与授权范围。');token.lease.check();
  const record=(await localWithin(lease)).pending;
  if(!record||record.type!==preview.type||record.payload.id!==preview.id||record.payloadHash!==preview.payloadHash||record.payloadJson!==token.payloadJson
   ||record.visibility!==preview.visibility||JSON.stringify(record.viewers??[])!==JSON.stringify(preview.viewers)||(record.prepared?.intent.id??null)!==preview.priorConsentId)throw Error('原 CI 操作已改变，请重新读取预览。');
  const {deadline}=await original(lease,record);if((deadline??null)!==preview.originalExpiresAt)throw Error('原 CI 期限已改变，请重新读取预览。');
  const checked=await receipt(lease,record);if(checked.state==='recorded')return checked;
  if(proofExpired(record))return{state:'unconfirmed',id:record.payload.id,reason:'proof-preview-expired'};
  if(record.prepared){const accepted=await guard(lease,()=>api.reconcileAuthorization(record.prepared));
   if(accepted.state==='acknowledged')return resumeWithin(lease);if(accepted.state!=='absent')throw Error('原 CI 授权回执不匹配。');}
  if(preview.expiresAt<=now()||deadline>now()&&preview.expiresAt!==deadline)throw Error('原 CI 授权预览已到期，请重新读取。');
  const prepared=await guard(lease,()=>api.prepareAuthorization(record.payloadJson,{action:action(record),objectId:record.payload.id,visibility:record.visibility,
   viewers:preview.viewers,expiresAt:preview.expiresAt,confirmed:true}));
  record.authorizationHistory=[...(record.authorizationHistory??[]),...(record.prepared?[record.prepared]:[])];record.prepared=prepared;
  record.expiresAt=preview.expiresAt;record.authorizationBindingId=prepared.intent.bindingId;record.submission=null;record.authorizationAttempted=false;delete record.blockedReason;
  authorizationPreviews.delete(preview);await savePending(lease,record);return{state:'recorded',id:record.payload.id,result:await send(lease,record)};
 }
 /** @param {{retry?:boolean,reauthorize?:boolean,confirmed?:boolean,authorizationPreview?:any}} options */
 function reconcile({retry=false,reauthorize=false,confirmed=false,authorizationPreview=null}={}){return serial(async lease=>{
  const record=(await localWithin(lease)).pending;if(!record)return{state:'none'};const checked=await receipt(lease,record);if(checked.state==='recorded'||!retry)return checked;
  if(!confirmed)throw Error('请确认继续原 CI 操作。');if(reauthorize)return reauthorizeWithin(lease,authorizationPreview,{confirmed});return resumeWithin(lease);
 });}
 function stopPending(locator,{confirmed=false}={}){return serial(async lease=>{
  if(!confirmed)throw Error('请明确停止这次本机发送。');const state=await localWithin(lease),record=state.pending;
  if(!record||record.payload.id!==locator.id||record.payloadHash!==locator.payloadHash)throw Error('原 CI 操作已改变，请读取当前记录。');
  const checked=await receipt(lease,record);if(checked.state==='recorded')return checked;
  const current=await localWithin(lease);
  if(current.pending?.payload.id!==locator.id||current.pending?.payloadHash!==locator.payloadHash)throw Error('原 CI 操作已改变，请读取当前记录。');
  const stopped={type:record.type,id:record.payload.id,payloadHash:record.payloadHash,consentId:record.prepared?.intent.id??null,
   state:'stopped-local',serverCancellationConfirmed:false};
  await save(lease,{...current,pending:null,stopped:[...(current.stopped??[]).filter(item=>item.id!==stopped.id||item.type!==stopped.type),stopped]});return stopped;
 });}
 function reconcileStopped(locator){return serial(async lease=>{
  const state=await localWithin(lease),saved=(state.stopped??[]).find(item=>item.type===locator.type&&item.id===locator.id&&item.payloadHash===locator.payloadHash);
  if(!saved)throw Error('本机原 CI 定位不存在或已改变。');
  const result=await call(lease,'/v2/ci/receipts',{type:saved.type,id:saved.id});
  if(result.type!==saved.type||result.id!==saved.id||!['recorded','absent'].includes(result.state)
   ||result.state==='recorded'&&(result.payloadHash!==saved.payloadHash||saved.consentId&&result.consentId!==saved.consentId))throw Error('原 CI 回执不匹配，请保留本机定位。');
  return result;
 });}
 const client={local:()=>localWithin(capture()),reconcile,resumePending:()=>serial(resumeWithin),reviewPending:()=>serial(reviewWithin),
  stopPending,reconcileStopped,
  reviewAuthorization:()=>serial(reviewAuthorizationWithin),reauthorize:(preview,options={})=>serial(lease=>reauthorizeWithin(lease,preview,options)),
  submit(type,payload,{confirmed=false,visibility='Private'}={}){const selected=structuredClone(payload);return serial(async lease=>{
   if(!confirmed||!['request','proof'].includes(type)||!['Private','Public'].includes(visibility))throw Error('请确认这次观测或证明披露。');
   if((await localWithin(lease)).pending)throw Error('请先恢复上一次 CI 操作。');
   const value=type==='request'?ciRequestV2Schema.parse(selected):selected;if(type==='proof')ciProofV2Schema.parse(value);if(type==='request')visibility='Private';
   const payloadJson=JSON.stringify(value),record={type,payload:value,payloadJson,payloadHash:await guard(lease,()=>sha256Hex(payloadJson)),visibility,viewers:[],
    expiresAt:now()+2591900,authorizationBindingId:api.snapshot().bindingId};await savePending(lease,record);return send(lease,record);
  });},
 };owners.set(subjectId,client);return client;
}
