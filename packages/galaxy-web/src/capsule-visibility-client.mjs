// Exact owner Consent withdrawal. This neither deletes sources nor cancels a
// Task, and never replaces Capsule author/source permissions with a broad flag.
export function createCapsuleVisibilityClient({api,getLocal,putLocal,subjectId}){
 const endpoint=api.endpoint,key=`capsule-visibility:${endpoint}:${subjectId}`,previews=new WeakMap();
 let queue=Promise.resolve();
 const check=()=>{if(!subjectId||api.endpoint!==endpoint||api.snapshot()?.subjectId!==subjectId)throw new Error('当前身份已改变。');};
 const serial=fn=>{const p=queue.then(fn,fn);queue=p.catch(()=>{});return p;};
 const call=async(path,input)=>{check();const r=await api.call(path,input);check();return r;};
 const load=async()=>{check();const r=await getLocal(key);check();return r??[];};
 const save=async rows=>{check();await putLocal(key,rows);check();};
 const status=async target=>{
  if(!['publication','use'].includes(target?.type))throw new Error('未知 Capsule 展示授权。');
  const r=await call('/v2/consents/receipt',{consentId:target.consentId});
  if(r.state!=='recorded'||r.consentId!==target.consentId||r.intent?.subjectId!==subjectId
   ||r.intent?.objectId!==target.operationId||r.intent?.payloadHash!==target.payloadHash
   ||r.intent?.action!==(target.type==='use'?'capsule.use':'capsule.publish'))throw new Error('未取得本人精确对象授权。');
  const exact=await call('/v2/capsules/receipt',{type:target.type,operationId:target.operationId,payloadHash:target.payloadHash});
  if(exact.state!=='acknowledged'||exact.consentId!==target.consentId)throw new Error('此授权不是服务器接收的原对象授权。');
  return{state:r.status==='revoked'?'revoked':r.status==='expired'?'expired':'active',target:{type:target.type,operationId:target.operationId,consentId:target.consentId,payloadHash:target.payloadHash},
   visibility:r.intent.visibility,viewers:r.intent.viewers,checkedAt:new Date().toISOString(),externalCopiesErased:false};
 };
 const remember=async result=>{const rows=await load(),id=result.target.consentId;await save([...rows.filter(x=>x.target.consentId!==id),result]);return result;};
 async function send(target){const current=await status(target);if(current.state!=='active')return remember(current);
  await remember({...current,state:'result-unknown'});
  await call(`/v1/consents/${target.consentId}/revoke`,{});
  const result=await status(target);if(result.state!=='revoked')throw new Error('撤销尚未取得当前回执，请查询原授权。');
  return remember(result);
 }
 return{
  prepare:target=>serial(async()=>{const current=await status(target);const preview=structuredClone(current);previews.set(preview,current.target);return preview;}),
  execute:(preview,{confirmed=false}={})=>serial(async()=>{const target=previews.get(preview);if(!confirmed||!target)throw new Error('请先预览并确认这项展示授权。');previews.delete(preview);return send(target);}),
  pending:load,
  reconcile:consentId=>serial(async()=>{const record=(await load()).find(x=>x.target.consentId===consentId);if(!record)throw new Error('原授权操作不存在。');return remember(await status(record.target));}),
  retry:(consentId,{confirmed=false}={})=>serial(async()=>{const record=(await load()).find(x=>x.target.consentId===consentId);if(!confirmed||!record)throw new Error('请确认继续撤销同一授权。');return send(record.target);}),
 };
}
