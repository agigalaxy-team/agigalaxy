// Withdrawal always addresses the accepted object's exact original Consent.
// It does not delete sources, replace their licenses, or create a new Consent.
/** @param {{api:any,getLocal:(key:string)=>any,putLocal:(key:string,value:any)=>any,
 * updateLocal?:((key:string,change:(value:any)=>any)=>any)|null,subjectId:string|null,
 * now?:()=>number}} options */
export function createCapsuleVisibilityClient({api,getLocal,putLocal,updateLocal=null,subjectId,now=()=>Math.floor(Date.now()/1000)}){
  const endpoint=api.endpoint,key=`capsule-visibility:${endpoint}:${subjectId}`,previews=new WeakMap();
  let queue=Promise.resolve(),activeLease=null;
  const capture=()=>{const s=api.snapshot();return s?JSON.stringify([api.endpoint,s.subjectId,s.bindingId,s.generation,s.control?.deviceId,s.control?.epoch]):null;};
  const check=(lease=activeLease)=>{if(!subjectId||api.endpoint!==endpoint||api.snapshot()?.subjectId!==subjectId
    ||lease!==null&&lease!==capture()||activeLease!==null&&activeLease!==capture())
    throw Object.assign(new Error('身份或连接已变化，请重新读取这项分享。'),{code:'capsule_visibility_identity_changed'});};
  const serial=fn=>{const lease=capture(),invoke=async()=>{check(lease);activeLease=lease;try{return await fn();}finally{activeLease=null;}};
    const run=queue.then(invoke,invoke);queue=run.catch(()=>{});return run;};
  const call=async(path,input)=>{const lease=capture();check(lease);const r=await api.call(path,input);check(lease);return r;};
  const load=async()=>{const lease=capture();check(lease);const rows=await getLocal(key);check(lease);return rows??[];};
  const update=async change=>{const lease=capture();check(lease);
    const apply=rows=>{check(lease);return change(rows??[]);},next=typeof updateLocal==='function'?await updateLocal(key,apply):apply(await load());
    if(typeof updateLocal!=='function'){check(lease);await putLocal(key,next);}check(lease);return next;};
  const targetOf=target=>{
    if(!['publication','use'].includes(target?.type)||!['operationId','consentId'].every(name=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target[name]??''))
      ||!/^[a-f0-9]{64}$/.test(target.payloadHash??''))throw Error('未知方法分享授权。');
    return{type:target.type,operationId:target.operationId,consentId:target.consentId,payloadHash:target.payloadHash};
  };
  const sameTarget=(a,b)=>a?.type===b?.type&&a?.operationId===b?.operationId&&a?.consentId===b?.consentId&&a?.payloadHash===b?.payloadHash;
  const changed=()=>Object.assign(new Error('原停止操作已变化，请重新读取。'),{code:'capsule_visibility_operation_changed'});
  async function status(input){
    const target=targetOf(input),accepted=r=>{
      const i=r.intent;
      if(r.state!=='recorded'||r.consentId!==target.consentId||!i||i.subjectId!==subjectId||i.endpoint!==endpoint||i.recipient!==endpoint
        ||i.objectId!==target.operationId||i.payloadHash!==target.payloadHash||i.action!==(target.type==='use'?'capsule.use':'capsule.publish')
        ||!['active','revoked','expired'].includes(r.status)||!['Private','Public'].includes(i.visibility)||!Array.isArray(i.viewers)
        ||!Number.isSafeInteger(i.expiresAt))throw Error('未取得本人精确对象授权。');return r;
    };
    const first=accepted(await call('/v2/consents/receipt',{consentId:target.consentId}));
    const exact=await call('/v2/capsules/receipt',{type:target.type,operationId:target.operationId,payloadHash:target.payloadHash});
    if(exact.state!=='acknowledged'||exact.operationId!==target.operationId||exact.consentId!==target.consentId
      ||exact.payloadHash!==undefined&&exact.payloadHash!==target.payloadHash)throw Error('此授权不是服务器接收的原对象授权。');
    const current=accepted(await call('/v2/consents/receipt',{consentId:target.consentId}));
    if(JSON.stringify(current.intent)!==JSON.stringify(first.intent))throw Error('原授权内容已变化。');
    return{state:current.status==='revoked'?'revoked':current.status==='expired'||current.intent.expiresAt<=now()?'expired':'active',target,
      visibility:current.intent.visibility,viewers:current.intent.viewers,expiresAt:current.intent.expiresAt,
      checkedAt:new Date(now()*1000).toISOString(),externalCopiesErased:false};
  }
  async function rememberCurrent(record,current){
    await update(rows=>rows.map(row=>{
      if(!sameTarget(row.target,record.target))return row;
      // Current receipt reading must not restart a locally stopped dispatch.
      return {...row,...current,...(current.state==='active'?{state:row.state}:{}),
        ...(row.state==='stopped-local'?{localRetryStopped:true}: {})};
    }));return current;
  }
  async function replace(record,next){
    const expected=JSON.stringify(record),rows=await update(rows=>rows.map(row=>{
      if(!sameTarget(row.target,record.target))return row;
      if(JSON.stringify(row)!==expected)throw changed();return structuredClone(next);
    }));
    const found=rows.find(row=>sameTarget(row.target,record.target));if(!found)throw changed();return found;
  }
  const definiteRejection=error=>error?.outcome==='rejected'&&Number.isInteger(error.status)&&error.status>=400&&error.status<500
    &&![401,408,429].includes(error.status)&&!['unauthorized','binding_revoked','invalid_session','session_expired','access_denied'].includes(error.code);
  async function continueRecord(record,{explicitRetry=false}={}){
    const current=await status(record.target);
    if(current.state!=='active')return rememberCurrent(record,current);
    if(record.state==='stopped-local'&&!explicitRetry)return{...current,state:'stopped-local',localRetryStopped:true};
    if(record.automaticRetryBlock&&!explicitRetry)return{...current,state:'result-unknown',reason:'business-rejected',rejection:record.automaticRetryBlock};
    const binding=api.snapshot()?.bindingId;
    if(!explicitRetry&&(!record.authorizationBindingId||record.authorizationBindingId!==binding))return{...current,state:'result-unknown',
      reason:record.authorizationBindingId?'original-binding-changed':'original-binding-unavailable'};
    const sending={...record,...current,state:'result-unknown',authorizationBindingId:binding};
    delete sending.automaticRetryBlock;delete sending.localRetryStopped;
    record=await replace(record,sending);
    try{
      await call(`/v1/consents/${record.target.consentId}/revoke`,{});
      const result=await status(record.target);if(result.state!=='revoked')throw Error('停止分享尚未取得原授权回执。');
      return rememberCurrent(record,result);
    }catch(error){
      if(definiteRejection(error))try{await replace(record,{...record,automaticRetryBlock:{code:error.code,status:error.status,rejectedAt:now()}});}
      catch(persistError){if(persistError.code!=='capsule_visibility_operation_changed')throw persistError;}
      throw Object.assign(error,{consentId:record.target.consentId,operationId:record.target.operationId,resultUnknown:error.outcome!=='rejected'});
    }
  }
  async function find(consentId){const record=(await load()).find(row=>row.target?.consentId===consentId);if(!record)throw Error('原授权操作不存在。');return record;}
  return{
    prepare:target=>serial(async()=>{const current=await status(target),preview=structuredClone(current);
      previews.set(preview,{target:current.target,exact:JSON.stringify(preview),lease:capture()});return preview;}),
    /** @param {any} preview @param {{confirmed?:boolean,onJournal?:(locator:any)=>any}} [options] */
    execute:(preview,{confirmed=false,onJournal}={})=>serial(async()=>{
      const prepared=previews.get(preview);if(!confirmed||!prepared||prepared.exact!==JSON.stringify(preview))throw Error('请核对这次停止分享的对象。');
      check(prepared.lease);const current=await status(prepared.target);if(current.state!=='active')return current;
      let selected;await update(rows=>{const previous=rows.find(row=>sameTarget(row.target,prepared.target));
        selected={...previous,...current,state:'result-unknown',authorizationBindingId:api.snapshot()?.bindingId,confirmedAt:now()};
        delete selected.automaticRetryBlock;delete selected.localRetryStopped;
        return[...rows.filter(row=>row.target?.consentId!==prepared.target.consentId),selected];});
      previews.delete(preview);
      if(onJournal){await onJournal(Object.freeze({kind:'capsule-visibility',...prepared.target,endpoint,subjectId}));check(prepared.lease);}
      return continueRecord(selected,{explicitRetry:true});
    }),
    pending:()=>serial(load),
    reviewPending:consentId=>serial(async()=>{const record=await find(consentId),current=await status(record.target);
      return{...current,endpoint,subjectId,originalBindingId:record.authorizationBindingId??null,
        localRetryStopped:record.state==='stopped-local',canContinue:current.state==='active',
        ...(record.automaticRetryBlock?{reason:'business-rejected',rejection:record.automaticRetryBlock}: {})};}),
    reconcile:consentId=>serial(async()=>{const record=await find(consentId);return rememberCurrent(record,await status(record.target));}),
    /** @param {string} consentId @param {{explicitRetry?:boolean}} [options] */
    resumePending:(consentId,{explicitRetry=false}={})=>serial(async()=>continueRecord(await find(consentId),{explicitRetry})),
    retry:(consentId,{confirmed=false}={})=>serial(async()=>{if(!confirmed)throw Error('请确认继续停止同一项分享。');return continueRecord(await find(consentId),{explicitRetry:true});}),
    receiptFor:locator=>serial(async()=>{const target=targetOf(locator),current=await status(target);return{
      ...current,...target,endpoint,subjectId,state:current.state==='revoked'?'acknowledged':'absent',
      businessState:current.state,revocationConfirmed:current.state==='revoked',currentReadPermissionConfirmed:false};}),
  };
}
