// Room-specific permissions never start or stop a host model by themselves.
export function createChatAgentClient({api,getLocal,putLocal}) {
  let subjectId=api.snapshot()?.subjectId;const endpoint=api.endpoint,locks=new Set();
  const owner=()=>{const current=api.snapshot()?.subjectId;if(!subjectId&&current)subjectId=current;if(!subjectId||current!==subjectId||api.endpoint!==endpoint)throw Error('身份或连接已改变，请重新打开房间。');};
  const serial=async(roomId,fn)=>{owner();if(locks.has(roomId))throw Error('本房间已有 Agent 权限操作正在处理。');locks.add(roomId);try{return await fn();}finally{locks.delete(roomId);}};
  const key=roomId=>`chat-agent-operation:${roomId}`;
  const path=roomId=>{if(!/^[0-9a-f-]{36}$/i.test(roomId))throw Error('无效房间。');return `/v2/chat/rooms/${roomId}`;};
  async function reconcile(record,{retry=false}={}) {
    owner();const current=await api.call(path(record.roomId)+'/agent-grants',{grantId:record.input.grantId});owner();
    const found=current.items?.[0];
    if(record.kind==='grant'&&found){
      if(found.bindingId!==record.input.bindingId||found.mode!==record.input.mode||found.expiresAt!==record.input.expiresAt)throw Error('原授权内容冲突。');
      await putLocal(key(record.roomId),null);return found;
    }
    if(record.kind==='revoke'&&found?.state==='revoked'){await putLocal(key(record.roomId),null);return found;}
    if(!retry)return {state:'unconfirmed'};
    const response=await api.call(path(record.roomId)+(record.kind==='grant'?'/agent-grant':'/agent-revoke'),record.input);
    await putLocal(key(record.roomId),null);return response;
  }
  async function commit(roomId,kind,input,confirmed) {
    return serial(roomId,async()=>{if(!confirmed)throw Error('请连接当前身份并确认房间与客户端权限。');
    if(await getLocal(key(roomId)))throw Error('请先查询原Agent授权操作。');
    const record={roomId,kind,input};await putLocal(key(roomId),record);return reconcile(record,{retry:true});});
  }
  return Object.freeze({
    pending:roomId=>{owner();return getLocal(key(roomId));},
    async retry(roomId,{confirmed=false}={}){return serial(roomId,async()=>{if(!confirmed)throw Error('请确认查询并继续原操作。');const record=await getLocal(key(roomId));return record?reconcile(record,{retry:true}):{state:'none'};});},
    grant:(roomId,input,{confirmed=false}={})=>commit(roomId,'grant',{...input,grantId:crypto.randomUUID()},confirmed),
    revoke:(roomId,grantId,{confirmed=false}={})=>commit(roomId,'revoke',{grantId},confirmed),
    list:(roomId,input={})=>{owner();return api.call(path(roomId)+'/agent-grants',input);},
    participants:(roomId,input={})=>{owner();return api.call(path(roomId)+'/agent-participants',input);},
  });
}
