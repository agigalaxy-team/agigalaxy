import { postPublicJson,validatePublicUrl } from "../infrastructure/public-fetch.mjs";
import { bindingQuerySchema,bindingPageSchema } from "../shared/binding-management-schema.mjs";
import { digest } from "../shared/digest.mjs";

export function createBindingManagementClient({endpoint,sessions,send=postPublicJson}){
  if(validatePublicUrl(endpoint).origin!==endpoint||!sessions)throw new Error('Invalid binding management configuration.');
  const pending=new WeakMap();
  async function check(actor,signal){
    signal?.throwIfAborted();
    if(!actor?.scopes.includes('binding')||!await sessions.isAuthorizationCurrent(actor)||!sessions.matchesAuthorization(actor))
      throw new Error('Current binding authorization required.');
    signal?.throwIfAborted();
  }
  async function read(actor,input,signal){
    const query=bindingQuerySchema.parse(input);await check(actor,signal);
    try{
      const raw=await send(endpoint+'/v1/bindings/query',{bodyJson:JSON.stringify(query),credential:actor.credential,signal});
      await check(actor,signal);const result=bindingPageSchema.parse(raw);
      if(result.subjectId!==actor.subjectId||result.currentBindingId!==actor.bindingId||result.items.length>query.limit
        ||result.items.some((item,i)=>query.bindingId&&item.bindingId!==query.bindingId||query.installationId&&item.installationId!==query.installationId
          ||item.bindingId<=(i?result.items[i-1].bindingId:query.after??'')
          ||item.state!==(item.revokedAt?'revoked':Date.parse(item.expiresAt)<=result.checkedAt*1000?'expired':'active'))
        ||result.nextAfter!==null&&(result.items.length!==query.limit||result.nextAfter!==result.items.at(-1)?.bindingId))
        throw new Error('Binding list response mismatch.');
      return result;
    }catch(error){if(error.code==='GALAXY_REMOTE_REJECTED')sessions.invalidateAuthorization(actor,'remote-rejected');throw error;}
  }
  async function query(input={}, {signal}={}){return read(await sessions.readAuthorization(endpoint),input,signal);}
  async function prepareRevoke(bindingId,{signal}={}){
    const actor=await sessions.readAuthorization(endpoint),page=await read(actor,{bindingId,limit:1},signal),item=page.items[0];
    if(!item||item.state==='revoked')throw new Error('Binding unavailable or already revoked; refresh the list.');
    const currentSession=item.bindingId===actor.bindingId;
    const previewJson=JSON.stringify({endpoint,subjectId:actor.subjectId,callerBindingId:actor.bindingId,target:item,
      currentSession,action:'revoke-binding',effect:'Revoke this binding and its sessions; dependent grants lose access.',
      keyRecoverySupported:false,keyRotationPreservingIdSupported:false,keyHolderCanBindAgain:true},null,2);
    const preview=Object.freeze({endpoint,bindingId,installationId:item.installationId,currentSession,previewJson,
      confirmation:`REVOKE BINDING ${bindingId} ${digest(previewJson)}`});
    pending.set(preview,{actor,state:'prepared',controller:new AbortController()});return preview;
  }
  function cancel(preview){const operation=pending.get(preview);if(operation){operation.state='canceled';operation.controller.abort();}}
  async function executeRevoke(preview,confirmation){
    const operation=pending.get(preview);
    if(!operation||operation.state!=='prepared'||confirmation!==preview.confirmation)throw new Error('Exact binding revocation confirmation required.');
    operation.state='executing';const {actor,controller}=operation;let dispatched=false,acknowledged=false;
    try{
      await check(actor,controller.signal);dispatched=true;
      const result=await send(`${endpoint}/v1/bindings/${preview.bindingId}/revoke`,{bodyJson:'{}',credential:actor.credential,signal:controller.signal});
      controller.signal.throwIfAborted();
      if(!result||Object.keys(result).sort().join(',')!=='bindingId,state'||result.bindingId!==preview.bindingId||result.state!=='revoked')
        throw new Error('Binding revocation acknowledgement mismatch; refresh its status.');
      await check(actor,controller.signal);acknowledged=true;operation.state='completed';
      return {endpoint,bindingId:preview.bindingId,state:'revoked',currentSessionEnded:preview.currentSession};
    }catch(error){if(operation.state!=='canceled')operation.state='failed';
      if(error.code==='GALAXY_REMOTE_REJECTED')sessions.invalidateAuthorization(actor,'remote-rejected');throw error;
    }finally{
      if(dispatched&&preview.currentSession)sessions.invalidateAuthorization(actor,acknowledged?'disconnected':'remote-outcome-unknown');
    }
  }
  return Object.freeze({query,prepareRevoke,executeRevoke,cancel});
}
