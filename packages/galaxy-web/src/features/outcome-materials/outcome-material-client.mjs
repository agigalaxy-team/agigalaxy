import {outcomeMaterialEventSchema} from "../../../../galaxy-contracts/src/outcome-material-v2-schema.mjs";
import {sha256Hex,equalJson} from "../../../../galaxy-contracts/src/web-primitives.mjs";

const instances=new WeakMap();
export function createOutcomeMaterialClient(runtime,{subjectId}){
 let owners=instances.get(runtime);if(!owners){owners=new Map();instances.set(runtime,owners);}if(owners.has(subjectId))return owners.get(subjectId);
 const endpoint=runtime.api.endpoint,key='outcome-materials:'+endpoint+':'+subjectId,reviews=new WeakMap();let queue=Promise.resolve();
 const fail=message=>{throw Error(message);};
 const capture=()=>JSON.stringify([runtime.api.endpoint,runtime.api.snapshot()?.subjectId??null,runtime.api.snapshot()?.bindingId??null,runtime.api.snapshot()?.generation??null]);
 const guard=lease=>{if(runtime.api.endpoint!==endpoint||runtime.api.snapshot()?.subjectId!==subjectId||capture()!==lease)fail('身份或连接已变化，请重新核对材料与原操作。');};
 const guarded=async(lease,fn)=>{guard(lease);const value=await fn();guard(lease);return value;};
 const serial=fn=>{const lease=capture(),invoke=()=>guarded(lease,()=>fn(lease)),run=()=>globalThis.navigator?.locks?navigator.locks.request('galaxy:'+key,invoke):invoke();const next=queue.then(run,run);queue=next.catch(()=>{});return next;};
 const load=async lease=>(await guarded(lease,()=>runtime.getLocal(key)))??{pending:null,stopped:[],receipts:[]};
 const save=(lease,value)=>guarded(lease,()=>runtime.putLocal(key,value));
 const call=(lease,method,input)=>guarded(lease,()=>runtime.api.call('/v2/outcome-materials/'+method,input));
 const locator=p=>({operationId:p.operationId,materialId:p.materialId,payloadHash:p.payloadHash,kind:p.kind,endpoint,subjectId});
 const cleanSource=value=>({source:value.source,authorId:value.authorId,size:value.size,...(value.name?{name:value.name}:{}),...(value.mediaType?{mediaType:value.mediaType}:{})});
 const source=(lease,selection)=>call(lease,'source',selection).then(cleanSource);
 const exact=async(lease,p)=>{
  if(p.endpoint!==endpoint||p.subjectId!==subjectId||!p.payloadJson||await guarded(lease,()=>sha256Hex(p.payloadJson))!==p.payloadHash)fail('本机原材料操作已变化，请保留定位信息核对。');
  const event=outcomeMaterialEventSchema.parse(JSON.parse(p.payloadJson));
  if(event.id!==p.operationId||event.materialId!==p.materialId||event.kind!==p.kind||JSON.stringify(event)!==p.payloadJson)fail('原材料操作内容与编号不一致。');
  if(p.authorization&&(p.authorization.payloadJson!==p.payloadJson||p.authorization.endpoint!==endpoint||p.authorization.intent?.subjectId!==subjectId||p.authorization.intent?.payloadHash!==p.payloadHash||p.authorization.intent?.objectId!==p.operationId||p.authorization.intent?.action!=='outcome.material'||p.authorization.intent?.visibility!=='Private'||p.authorization.intent?.purpose!=='operational'||p.authorization.intent?.recipient!==endpoint||p.authorization.intent?.expiresAt!==p.authorizationExpiresAt||JSON.stringify(p.authorization.intent?.viewers)!==JSON.stringify(p.viewers)))fail('保存的原授权范围与材料操作不一致。');
  if(p.submission&&(!p.authorization||p.submission.consentId!==p.authorization.intent.id||p.submission.payloadJson!==p.payloadJson))fail('保存的原提交与授权不一致。');
  return event;
 };
 const current=async(lease,event)=>{
  if(event.kind==='request'||event.kind==='approve'){
   const selected=await source(lease,{kind:event.source.kind,id:event.source.id,version:event.source.version});
   if(!equalJson(selected.source,event.source))fail('来源版本或内容已改变，请重新选择当前材料。');
   if(event.kind==='approve'&&selected.authorId!==subjectId)fail('只有所选原材料作者可以批准保存。');
  }
  if(event.kind!=='request'){
   const item=await call(lease,'inspect',{id:event.materialId,version:1});
   if(item.revision!==event.expectedRevision)fail('材料申请已变化，请刷新当前状态。');
   if(event.kind==='approve'&&(item.requestHash!==event.requestHash||!equalJson(item.source,event.source)||item.state!=='requested'))fail('当前申请与原批准范围不一致。');
  }
 };
 const preview=async(lease,p,retry=false)=>{
  const event=await exact(lease,p);await current(lease,event);
  const value={...locator(p),event,viewers:[...p.viewers],authorizationExpiresAt:p.authorizationExpiresAt,retry};
  reviews.set(value,{lease,json:JSON.stringify(value)});return value;
 };
 const receipt=async(lease,p)=>{
  if(p.endpoint!==endpoint||p.subjectId!==subjectId||!p.operationId||!/^[a-f0-9]{64}$/.test(p.payloadHash))fail('原操作定位不属于当前身份或服务。');
  const r=await call(lease,'receipt',{operationId:p.operationId,payloadHash:p.payloadHash});
  if(r.operationId!==p.operationId||!['absent','recorded','conflict'].includes(r.state)||r.state==='recorded'&&r.material?.materialId!==p.materialId)fail('原材料回执不匹配，请保留原操作。');return r;
 };
 const settle=async(lease,data,p,r)=>{data.pending=null;data.receipts=[...(data.receipts??[]).filter(x=>x.operationId!==p.operationId),{...locator(p),state:r.state??'recorded'}].slice(-40);await save(lease,data);return r;};
 const client={
  source:selection=>{const lease=capture();return source(lease,selection);},
  query:input=>{const lease=capture();return call(lease,'query',input);},
  inspect:id=>{const lease=capture();return call(lease,'inspect',{id,version:1});},
  history:after=>{const lease=capture();return guarded(lease,()=>runtime.api.call('/v2/history/query',{subjectId,timeWindow:{kind:'all-visible'},limit:20,...(after?{after}:{})}));},
  directory:()=>serial(async lease=>{const data=await load(lease);return{pending:data.pending?locator(data.pending):null,stopped:data.stopped??[],receipts:data.receipts??[]};}),
  prepare:(input,{viewers=[],expiresAt})=>serial(async lease=>{
   const data=await load(lease);if(data.pending)fail('请先核对或停止上一项原材料操作。');
   const event=outcomeMaterialEventSchema.parse(structuredClone(input)),payloadJson=JSON.stringify(event);
   if(!Number.isInteger(expiresAt)||expiresAt<=Math.floor(Date.now()/1000))fail('请选择尚未到期的授权期限。');
   const p={endpoint,subjectId,operationId:event.id,materialId:event.materialId,kind:event.kind,payloadJson,payloadHash:await guarded(lease,()=>sha256Hex(payloadJson)),viewers:[...new Set(viewers.filter(id=>id!==subjectId))],authorizationExpiresAt:expiresAt};
   const value=await preview(lease,p);data.pending=p;await save(lease,data);return value;
  }),
  confirm:(value,{confirmed=false}={})=>serial(async lease=>{
   const review=reviews.get(value);if(!confirmed||!review||review.lease!==lease||review.json!==JSON.stringify(value))fail('请重新预览准确材料与授权范围，再明确确认。');
   const data=await load(lease),p=data.pending;if(!p||JSON.stringify(locator(p))!==JSON.stringify({operationId:value.operationId,materialId:value.materialId,payloadHash:value.payloadHash,kind:value.kind,endpoint:value.endpoint,subjectId:value.subjectId}))fail('待提交原操作已变化。');
   const event=await exact(lease,p);if((p.attempted||p.authorizationAttempted)&&!value.retry)fail('上次结果尚待核对，请先只查询原回执。');
   if(value.retry){const r=await receipt(lease,p);if(r.state==='recorded')return settle(lease,data,p,r);if(r.state!=='absent')fail('原操作冲突，不能重新提交。');}
   await current(lease,event);reviews.delete(value);
   const prepare=async()=>{p.authorization=await guarded(lease,()=>runtime.api.prepareAuthorization(p.payloadJson,{action:'outcome.material',objectId:p.operationId,visibility:'Private',viewers:p.viewers,expiresAt:p.authorizationExpiresAt,confirmed:true}));p.authorizationAttempted=false;p.submission=null;await save(lease,data);};
   if(!p.authorization)await prepare();
   if(!p.submission){
    const reconcile=p.authorizationAttempted===true;p.authorizationAttempted=true;await save(lease,data);
    try{p.submission=await guarded(lease,()=>runtime.api.submitAuthorization(p.authorization,{confirmed:true,reconcile}));}
    catch(error){if(error?.code!=='consent_reauthorization_required'||!value.retry)throw error;
     // Only after exact operation absence and this fresh, explicit review.
     await prepare();p.authorizationAttempted=true;await save(lease,data);p.submission=await guarded(lease,()=>runtime.api.submitAuthorization(p.authorization,{confirmed:true}));}
    await save(lease,data);
   }
   // Recheck current source/approval after authorization awaits as well.
   await current(lease,event);p.attempted=true;await save(lease,data);
   const response=await call(lease,['request','approve'].includes(p.kind)?p.kind:'control',p.submission);
   if(response.operationId!==p.operationId||response.materialId!==p.materialId||response.operationState!=='recorded')fail('材料写入回执不匹配，请只查询原操作。');
   return settle(lease,data,p,{state:'recorded',operationId:p.operationId,material:response});
  }),
  reconcile:operationId=>serial(async lease=>{
   const data=await load(lease),p=data.pending?.operationId===operationId?data.pending:[...(data.stopped??[]),...(data.receipts??[])].find(x=>x.operationId===operationId);if(!p)fail('没有这项原材料操作的本机定位。');
   const r=await receipt(lease,p);if(data.pending===p&&r.state==='recorded')return settle(lease,data,p,r);
   return{...r,localRetryStopped:data.pending!==p,currentReadPermissionConfirmed:false};
  }),
  reviewPending:()=>serial(async lease=>{const data=await load(lease),p=data.pending;if(!p)fail('当前没有待核对的原材料操作。');const r=await receipt(lease,p);if(r.state==='recorded')return settle(lease,data,p,r);if(r.state!=='absent')fail('原操作冲突，不能继续提交。');return preview(lease,p,true);}),
  stop:operationId=>serial(async lease=>{const data=await load(lease),p=data.pending;if(!p||p.operationId!==operationId)fail('待停止的原材料操作已变化。');data.stopped=[...(data.stopped??[]),locator(p)];data.pending=null;await save(lease,data);return{state:'stopped-local',remoteCancellationConfirmed:false};}),
  read:async id=>{const lease=capture(),r=await call(lease,'read',{id,version:1});const {bytesBase64:_bytes,...view}=r;return view;},
  download:async id=>{
   const lease=capture(),r=await call(lease,'read',{id,version:1});if(!r.contentAvailable||r.authorization!=='current'||typeof r.bytesBase64!=='string')fail('材料当前不可下载，请刷新核对自身授权与期限。');
   const bytes=Uint8Array.from(atob(r.bytesBase64),c=>c.charCodeAt(0)),hash=Array.from(new Uint8Array(await guarded(lease,()=>crypto.subtle.digest('SHA-256',bytes))),v=>v.toString(16).padStart(2,'0')).join('');if(bytes.length!==r.size||hash!==r.sha256)fail('材料内容与原摘要不一致，未保存文件。');guard(lease);return{bytes,name:r.title||'outcome-material',view:(({bytesBase64:_bytes,...view})=>view)(r)};
  },
 };
 owners.set(subjectId,client);return client;
}
