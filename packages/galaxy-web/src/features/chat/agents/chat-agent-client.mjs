// Room-specific permissions never start or stop a host model by themselves.
/** @param {any} options */
export function createChatAgentClient({api,getLocal,putLocal,updateLocal,receiptStatus,now=()=>Math.floor(Date.now()/1000)}) {
  let subjectId=api.snapshot()?.subjectId;const endpoint=api.endpoint,locks=new Set();
  const owner=()=>{const current=api.snapshot()?.subjectId;if(!subjectId&&current)subjectId=current;if(!subjectId||current!==subjectId||api.endpoint!==endpoint)throw Error('身份或连接已改变，请重新打开房间。');};
  function captureLease(){
    owner();const binding=api.snapshot(),runtimeLease=receiptStatus?.captureLease?.();
    if(runtimeLease&&(typeof runtimeLease.assertCurrent!=='function'||runtimeLease.subjectId!==subjectId||runtimeLease.endpoint!==endpoint))throw Error('当前身份租约不可用，请重新打开房间。');
    const check=()=>{runtimeLease?.assertCurrent();owner();const current=api.snapshot();
      if(['subjectId','endpoint','bindingId','generation'].some(k=>binding[k]!==current?.[k]))throw Error('身份或连接已改变，请重新核对原操作。');};
    check();return{subjectId,endpoint,check,async wait(action){check();const result=await action();check();return result;}};
  }
  const serial=async(roomId,fn)=>{const lease=captureLease();if(locks.has(roomId))throw Error('本房间已有 Agent 权限操作正在处理。');locks.add(roomId);try{return await fn(lease);}finally{locks.delete(roomId);}};
  const key=roomId=>`chat-agent-operation:${roomId}`;
  const previousKey=roomId=>`chat-agent-previous-operations:${roomId}`;
  const path=roomId=>{if(!/^[0-9a-f-]{36}$/i.test(roomId))throw Error('无效房间。');return `/v2/chat/rooms/${roomId}`;};
  function ownRecord(record,roomId,lease){
    if(record&&(record.roomId!==roomId||!['grant','revoke'].includes(record.kind)||!record.input?.grantId
      ||record.subjectId&&record.subjectId!==lease.subjectId||record.endpoint&&record.endpoint!==lease.endpoint))throw Error('原 Agent 权限操作不属于当前身份或房间。');
    return record;
  }
  async function acknowledge(record,lease){
    // Keep the exact original locator even if the journal completion is late.
    // A known ACK is not pending; a new explicit action may replace this row.
    await lease.wait(()=>putLocal(key(record.roomId),{...record,acknowledged:true}));
    record.acknowledged=true;
  }
  const canStartNewSelection=record=>record?.state==='stopped-local'||record?.kind==='grant'&&Number.isInteger(record.input?.expiresAt)&&record.input.expiresAt<=now();
  async function rememberPrevious(record,lease){
    const locator={roomId:record.roomId,kind:record.kind,input:structuredClone(record.input),subjectId:lease.subjectId,endpoint:lease.endpoint,
      state:record.state==='stopped-local'?'stopped-local':'expired-original',acknowledged:!!record.acknowledged};
    const merge=current=>{lease.check();const list=current??[];if(!Array.isArray(list))throw Error('原Agent权限记录格式不匹配。');
      return[...list.filter(row=>row.input?.grantId!==record.input.grantId),locator];};
    if(typeof updateLocal==='function')await lease.wait(()=>updateLocal(previousKey(record.roomId),merge));
    else{const prior=await lease.wait(()=>getLocal(previousKey(record.roomId)));await lease.wait(()=>putLocal(previousKey(record.roomId),merge(prior)));}
  }
  async function reconcile(record,lease,{retry=false,automatic=false}={}) {
    const current=await lease.wait(()=>api.call(path(record.roomId)+'/agent-grants',{grantId:record.input.grantId}));
    const found=current.items?.[0];
    if(record.kind==='grant'&&found){
      if(found.grantId!==record.input.grantId||found.bindingId!==record.input.bindingId||found.mode!==record.input.mode||found.expiresAt!==record.input.expiresAt)throw Error('原授权内容冲突。');
      await acknowledge(record,lease);return found;
    }
    if(record.kind==='revoke'&&found?.grantId===record.input.grantId&&found.state==='revoked'){await acknowledge(record,lease);return found;}
    if(!retry)return {state:'unconfirmed'};
    if(record.state==='stopped-local')return {state:'stopped-local',grantId:record.input.grantId,canStartNewSelection:true};
    if(automatic&&record.acknowledged)return {state:'unconfirmed',reason:'original-receipt-unavailable',grantId:record.input.grantId};
    if(record.acknowledged)throw Error('原操作已有回执，但当前查询未能核对；不能重新发送。');
    if(automatic&&record.kind==='grant'){
      if(!Number.isInteger(record.input.expiresAt)||record.input.expiresAt<=now())
        return {state:'unconfirmed',reason:'authorization-expired',grantId:record.input.grantId,canStartNewSelection:Number.isInteger(record.input.expiresAt)};
      if(!['read','draft','respond'].includes(record.input.mode)||typeof record.input.bindingId!=='string')
        return {state:'unconfirmed',reason:'authorization-review-required',grantId:record.input.grantId};
    }
    const response=await lease.wait(()=>api.call(path(record.roomId)+(record.kind==='grant'?'/agent-grant':'/agent-revoke'),record.input));
    await acknowledge(record,lease);return response;
  }
  async function commit(roomId,kind,input,confirmed) {
    const selected=structuredClone(input);
    return serial(roomId,async lease=>{if(!confirmed)throw Error('请连接当前身份并确认房间与客户端权限。');
    const previous=ownRecord(await lease.wait(()=>getLocal(key(roomId))),roomId,lease);
    if(previous&&!previous.acknowledged){
      if(!canStartNewSelection(previous))throw Error('请先查询原Agent授权操作。');
      // Starting a new permission is an explicit user action. Keep the old
      // fixed permission independently queryable and never revive or extend it.
      await reconcile(previous,lease);await rememberPrevious(previous,lease);
    }
    const record={roomId,kind,input:selected,subjectId:lease.subjectId,endpoint:lease.endpoint};
    await lease.wait(()=>putLocal(key(roomId),record));return reconcile(record,lease,{retry:true});});
  }
  return Object.freeze({
    pending:async roomId=>{const lease=captureLease();const record=ownRecord(await lease.wait(()=>getLocal(key(roomId))),roomId,lease);return record?.acknowledged?null:record?{...record,canStartNewSelection:canStartNewSelection(record)}:null;},
    resumePending:roomId=>serial(roomId,async lease=>{const record=ownRecord(await lease.wait(()=>getLocal(key(roomId))),roomId,lease);
      return record?reconcile(record,lease,{retry:true,automatic:true}):{state:'none'};}),
    reviewPending:async roomId=>{const lease=captureLease(),record=ownRecord(await lease.wait(()=>getLocal(key(roomId))),roomId,lease);
      return record?structuredClone({...record,state:record.acknowledged?'acknowledged':record.state??'awaiting-receipt'}):null;},
    previousOperations:async roomId=>{const lease=captureLease(),rows=await lease.wait(()=>getLocal(previousKey(roomId)));
      if(rows&&!Array.isArray(rows))throw Error('原Agent权限记录格式不匹配。');return(rows??[]).map(record=>structuredClone(ownRecord(record,roomId,lease)));},
    reconcilePrevious:(roomId,grantId)=>serial(roomId,async lease=>{
      const rows=await lease.wait(()=>getLocal(previousKey(roomId))),record=ownRecord(rows?.find(row=>row.input?.grantId===grantId),roomId,lease);
      if(!record)return{state:'none'};
      const current=await lease.wait(()=>api.call(path(roomId)+'/agent-grants',{grantId})),found=current.items?.[0];
      if(found&&(found.grantId!==grantId||record.kind==='grant'&&(found.bindingId!==record.input.bindingId||found.mode!==record.input.mode||found.expiresAt!==record.input.expiresAt)))throw Error('原授权内容冲突。');
      return{state:found?'recorded':'absent',grantId,roomId,originalState:record.state,grant:found??null,currentAccessGranted:false,automaticReplayStopped:true};
    }),
    async retry(roomId,{confirmed=false}={}){return serial(roomId,async lease=>{if(!confirmed)throw Error('请确认查询并继续原操作。');const record=ownRecord(await lease.wait(()=>getLocal(key(roomId))),roomId,lease);return record?reconcile(record,lease,{retry:true}):{state:'none'};});},
    grant:(roomId,input,{confirmed=false}={})=>commit(roomId,'grant',{...input,grantId:crypto.randomUUID()},confirmed),
    revoke:(roomId,grantId,{confirmed=false}={})=>commit(roomId,'revoke',{grantId},confirmed),
    list:(roomId,input={})=>{const lease=captureLease();const selected=structuredClone(input);return lease.wait(()=>api.call(path(roomId)+'/agent-grants',selected));},
    participants:(roomId,input={})=>{const lease=captureLease();const selected=structuredClone(input);return lease.wait(()=>api.call(path(roomId)+'/agent-participants',selected));},
  });
}
