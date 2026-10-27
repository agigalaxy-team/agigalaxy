import {createChatClient} from './chat-client.mjs';
import {isCancelledError} from '@tanstack/react-query';
import {readWithTransientRecovery} from "../../../../../integrations/shared/read-task.mjs";

const readPost = path => ['/v2/chat/rooms/directory','/v2/chat/invitations/query','/v2/chat/accounts/query','/v2/chat/attachments/config','/v2/chat/attachments/query'].includes(path)
  || /^\/v2\/chat\/rooms\/[0-9a-f-]{36}\/(?:read|decisions|history)$/.test(path)
  || /^\/v2\/chat\/rooms\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}\/context$/.test(path);

let generation=0;
// Adapt the real website account session to the existing chat journal and local
// draft store. This reference is not a Galaxy identity, binding or device key.
/**
 * @param {{base: any, endpoint: string, client: any, getSession: () => any,
 * getNetworkSession?: () => any, getGeneration?: () => number, onSessionError?: () => void,
 * query?: import('@tanstack/react-query').QueryClient | null,
 * queryKey?: ((...parts: any[]) => readonly unknown[]) | null}} options
 */
export function createOfficialChatRuntime({base,endpoint,client,getSession,getNetworkSession=getSession,getGeneration=()=>0,onSessionError=()=>{},query=null,queryKey=null}){
  const initial=getSession();
  if(initial?.state!=='signed-in'||!initial.account?.id)throw Error('official_account_session_expired');
  const accountId=initial.account.id,subjectId='account:'+accountId,csrf=initial.csrfToken,epoch=++generation,sessionGeneration=getGeneration();
  let invalidated=false;
  const invalidate=()=>{invalidated=true;};
  const assertCurrent=()=>{const value=getSession();if(invalidated||getGeneration()!==sessionGeneration||value?.state!=='signed-in'||value.account.id!==accountId||value.csrfToken!==csrf||value.expiresAt*1000<=Date.now()){
    invalidated=true;throw Object.assign(Error('账户会话已变化，请重新打开对话。'),{code:'official_account_changed'});}};
  const snapshot=()=>{try{assertCurrent();return{subjectId,bindingId:'official-account-session',generation:epoch,endpoint,scopes:[],control:null};}catch{return null;}};
  const captureLease=()=>{assertCurrent();return Object.freeze({subjectId,deviceId:'official-account-session',endpoint,bindingId:'official-account-session',generation:epoch,assertCurrent});};
  const guard=async action=>{assertCurrent();try{const result=await action();assertCurrent();return result;}catch(error){
    if(['official_account_session_expired','official_account_changed','account_csrf_invalid'].includes(error.code))onSessionError();throw error;}};
  const networkSession=()=>{const value=getNetworkSession();if(value?.state!=='signed-in'||value.account?.id!==accountId||value.csrfToken!==csrf||value.expiresAt*1000<=Date.now())throw Object.assign(Error('账户暂时无法核对，联网后重新确认。'),{code:'official_account_unavailable'});return value;};
  const networkGuard=action=>guard(async()=>{const result=await action(networkSession());networkSession();return result;});
  const owner=value=>{if(value!==undefined&&value!==subjectId)throw Error('official_account_changed');assertCurrent();};
  const getLocal=(key,selected)=>{owner(selected);return guard(()=>base.getLocal(key,subjectId));};
  const putLocal=(key,value,selected)=>{owner(selected);return guard(()=>base.putLocal(key,value,subjectId));};
  const updateLocal=(key,update,selected)=>{owner(selected);return guard(()=>base.updateLocal(key,current=>{assertCurrent();return update(current);},subjectId));};
  const queryRead=async(path,input,options,action)=>{
    const key=queryKey(path,input??null);
    for(let attempt=0;;attempt++){
      try{return await query.query({queryKey:key,queryFn:()=>readWithTransientRecovery(action,{signal:options.signal,check:()=>{assertCurrent();networkSession();}})});}
      catch(error){
        // An event reset cancels imperative readers as well as observers. Rejoin
        // that same authorized read; never replay writes or a removed scope.
        if(!isCancelledError(error)||attempt>=2||options.signal?.aborted||!query.getQueryCache().find({queryKey:key,exact:true}))throw error;
        assertCurrent();networkSession();
      }
    }
  };
  const api={endpoint,snapshot,call:(path,input,options={})=>{
    assertCurrent();
    const action=()=>networkGuard(session=>client.call(path,input,{...options,session}));
    if(query&&queryKey&&readPost(path)){
      const key=queryKey(path,input??null),saved=query.getQueryData(key);
      const deadlines=[saved?.readExpiresAt,...(saved?.rooms??[]).map(room=>room.readExpiresAt)].filter(value=>typeof value==='number');
      if(deadlines.some(value=>value*1000<=Date.now()))query.removeQueries({queryKey:key,exact:true});
    }
    return (options.method??'POST')==='POST'&&(readPost(path)||(/\/(?:receipt|operation-receipt)$/.test(path)||path==='/v2/chat/attachments/read'))
      ?(query&&queryKey&&readPost(path)?queryRead(path,input,options,action):readWithTransientRecovery(action,{signal:options.signal,check:()=>{assertCurrent();networkSession();}}))
      :action().then(result=>{if(query&&queryKey&&(options.method??'POST')!=='GET')void query.invalidateQueries({queryKey:queryKey()});return result;});
  },
    attachmentTransfer:(path,{bytes,signal}={})=>networkGuard(async session=>{
      const response=await client.transfer(path,bytes??{},{method:bytes?'PUT':'POST',session,signal});
      if(bytes)return response.json();
      return{bytes:new Uint8Array(await response.arrayBuffer()),sha256:response.headers.get('X-Galaxy-Content-Sha256')};
    })};
  const chat=createChatClient({api,subjectId,captureLease,getLocal,putLocal,updateLocal,readOnlyRecovery:true});
  // The base runtime owns Native getters. Copying or inheriting it would either
  // invoke those leases here or expose unrelated ID capabilities to account UI.
  return Object.freeze({api,chat,accountId,actorKind:'official-account',invalidate,getLocal,putLocal,updateLocal,
    subscribe:listener=>query?query.getQueryCache().subscribe(event=>{if(event.type==='updated'&&queryKey&&JSON.stringify(event.query.queryKey.slice(0,5))===JSON.stringify(queryKey())){if(event.action.type==='invalidate')listener(false);else if(event.action.type==='setState'&&event.query.state.data===undefined)listener(true);}}):()=>{},
    receiptStatus:{captureLease},status:async()=>({identity:null,connection:null}),
    notesAuthority:{endpoint,captureLease,get:getLocal,update:updateLocal}});
}
