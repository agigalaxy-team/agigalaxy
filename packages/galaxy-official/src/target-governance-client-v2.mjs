import { targetReportSchemaV2, targetModerationSchemaV2 } from './shared/target-governance-v2-schema.mjs';
import { sha256Hex } from './shared/web-primitives.mjs';

// Reuses the existing identity/Consent client; no account, signing key or model
// implementation is introduced here. One durable pending action per subject.
export function createTargetGovernanceClientV2({api,getLocal,putLocal,subjectId,locks=globalThis.navigator?.locks,now=()=>Math.floor(Date.now()/1000)}) {
 const endpoint=api.endpoint,key=`target-governance:${endpoint}:${subjectId}`,previews=new WeakMap(),authorizationPreviews=new WeakMap();let queue=Promise.resolve();
 const check=(bindingId)=>{const current=api.snapshot();if(api.endpoint!==endpoint||current?.subjectId!==subjectId||(bindingId&&current.bindingId!==bindingId))throw new Error('治理操作的身份或连接已改变。');return current;};
 const serial=fn=>{const work=()=>locks?.request?locks.request(key,{mode:'exclusive'},fn):fn();const result=queue.then(work,work);queue=result.catch(()=>{});return result;};
 const load=async()=>{check();const row=await getLocal(key);check();return row??{active:null,stopped:[]};};
 const save=async row=>{check();await putLocal(key,row);check();};
 const call=async(path,input,opts)=>{check();const result=await api.call(path,input,opts);check();return result;};
 async function receipt(op){const r=await call('/v2/target-governance/receipt',{eventId:op.operationId,payloadHash:op.payloadHash});
  if(r.eventId!==op.operationId||!['absent','acknowledged','conflict'].includes(r.state))throw new Error('原操作回执不匹配。');if(r.state==='conflict')throw new Error('同号内容冲突，保留原操作核对。');return r;}
 async function clear(op){const state=await load();if(state.active?.operationId===op.operationId)state.active=null;state.stopped=state.stopped.filter(x=>x.operationId!==op.operationId);await save(state);}
 async function send(op){check();if(await sha256Hex(op.payloadJson)!==op.payloadHash)throw new Error('保存的操作内容已改变。');
  if(!op.prepared){op.prepared=await api.prepareAuthorization(op.payloadJson,{action:'moderation.publish',objectId:op.operationId,visibility:'Private',viewers:op.viewers,confirmed:true});await save({...await load(),active:op});}
  const reconcile=op.authorizationAttempted===true;op.authorizationAttempted=true;await save({...await load(),active:op});
  const submission=await api.submitAuthorization(op.prepared,{confirmed:true,reconcile});check();op.businessAttempted=true;await save({...await load(),active:op});
  await call(op.type==='report'?'/v2/target-governance/reports':'/v2/target-governance/events',submission);
  const r=await receipt(op);if(r.state!=='acknowledged')throw new Error('结果未确认，请查询原操作。');await clear(op);return r;
 }
 return {
  /** @param {string} type @param {unknown} input @param {{viewers?: string[]}} options */
  async prepare(type,input,{viewers=[]}={}){const current=check();if(!['report','event'].includes(type))throw new Error('治理操作类型无效。');
   const payload=(type==='report'?targetReportSchemaV2:targetModerationSchemaV2).parse(input),selected=[...new Set(viewers.filter(x=>x!==subjectId))];
   if(selected.length>16||selected.some(x=>!/^GUID[0-9A-Z]{28}$/.test(x)))throw new Error('请选择最多16位明确受众。');
   const payloadJson=JSON.stringify(payload),op={type,operationId:payload.id,payloadJson,payloadHash:await sha256Hex(payloadJson),viewers:selected};check(current.bindingId);
   const preview=structuredClone({...op,payload,subjectId,endpoint});previews.set(preview,{op,bindingId:current.bindingId,preview:JSON.stringify(preview)});return preview;
  },
  execute(preview,{confirmed=false}={}){return serial(async()=>{const p=previews.get(preview);if(!confirmed||!p||p.preview!==JSON.stringify(preview))throw new Error('请核对本次准确预览。');check(p.bindingId);const state=await load();if(state.active)throw new Error('请先处理原操作回执。');previews.delete(preview);await save({...state,active:p.op});return send(p.op);});},
  async pending(){const s=await load();return[...(s.active?[{operationId:s.active.operationId,type:s.active.type,payload:JSON.parse(s.active.payloadJson),viewers:s.active.viewers,state:'awaiting-receipt'}]:[]),...s.stopped];},
  reconcile(id){return serial(async()=>{const s=await load(),op=s.active?.operationId===id?s.active:s.stopped.find(x=>x.operationId===id);if(!op)throw new Error('原操作不存在。');const r=await receipt(op);if(r.state==='acknowledged')await clear(op);return r;});},
  retry(id,{confirmed=false}={}){return serial(async()=>{const op=(await load()).active;if(!confirmed||op?.operationId!==id)throw new Error('请确认重试保存的原操作。');const r=await receipt(op);if(r.state==='acknowledged'){await clear(op);return r;}return send(op);});},
  reviewAuthorization(id){return serial(async()=>{const op=(await load()).active;if(op?.operationId!==id||!op.prepared)throw new Error('原授权不可用。');
   const r=await receipt(op);if(r.state==='acknowledged'){await clear(op);return r;}
   const c=await api.reconcileAuthorization(op.prepared);check();if(c.state!=='absent')return{state:'reuse-original-authorization',operationId:id};
   const p={state:'reauthorization-required',operationId:id,priorConsentId:op.prepared.intent.id,payload:JSON.parse(op.payloadJson),payloadHash:op.payloadHash,viewers:[...op.viewers],expiresAt:Math.max(now()+300,op.prepared.intent.expiresAt)};
   authorizationPreviews.set(p,{serialized:JSON.stringify(p),bindingId:check().bindingId});return p;
  });},
  reauthorize(preview,{confirmed=false}={}){return serial(async()=>{const p=authorizationPreviews.get(preview);if(!confirmed||!p||p.serialized!==JSON.stringify(preview))throw new Error('请确认展示的原内容与新授权期限。');check(p.bindingId);
   const op=(await load()).active;if(op?.operationId!==preview.operationId||op.prepared?.intent.id!==preview.priorConsentId||op.payloadHash!==preview.payloadHash)throw new Error('原操作已改变。');
   const r=await receipt(op);if(r.state==='acknowledged'){await clear(op);return r;}
   const c=await api.reconcileAuthorization(op.prepared);check(p.bindingId);if(c.state!=='absent')throw new Error('原授权已存在，请沿用原授权重试。');
   const replacement=await api.prepareAuthorization(op.payloadJson,{action:'moderation.publish',objectId:op.operationId,visibility:'Private',viewers:op.viewers,expiresAt:preview.expiresAt,confirmed:true});check(p.bindingId);
   authorizationPreviews.delete(preview);op.previousAuthorizations=[...(op.previousAuthorizations??[]),op.prepared];op.prepared=replacement;op.authorizationAttempted=false;await save({...await load(),active:op});return send(op);
  });},
  stopLocalRetry(id,{confirmed=false}={}){return serial(async()=>{const s=await load(),op=s.active;if(!confirmed||op?.operationId!==id)throw new Error('请确认停止本机重试。');const r=await receipt(op);if(r.state==='acknowledged'){await clear(op);return r;}
   const record={operationId:op.operationId,type:op.type,payloadHash:op.payloadHash,state:'stopped-local',serverCancellationConfirmed:false};await save({active:null,stopped:[...s.stopped,record]});return record;});},
  config:()=>call('/v2/target-governance/config',undefined,{method:'GET'}),
  target:input=>call('/v2/target-governance/target',input),query:input=>call('/v2/target-governance/query',input),
  get:id=>call(`/v2/target-governance/${id}`,undefined,{method:'GET'}),
 };
}
