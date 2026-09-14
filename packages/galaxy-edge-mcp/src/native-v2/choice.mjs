import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createRequestStateCodec,inputRequired,acceptedContent,PROTOCOL_VERSION_META_KEY,CLIENT_CAPABILITIES_META_KEY} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {createNativeReview} from './review.mjs';
const answer=z.strictObject({confirm:z.boolean()});
const schema={type:'object',properties:{confirm:{type:'boolean',title:'Authorize this exact scope'}},required:['confirm']};
export const nativeResult=value=>({content:[{type:'text',text:JSON.stringify(value)}]});

// New scope choices only. Reads, exact signed retries and existing delegated
// actions skip this gate. Actual input comes from the MCP client user surface,
// never a `confirmed:true` tool argument written by the model.
export function createNativeChoice({identity=()=>'',website,store}){
 const review=createNativeReview();
 const pending=new Map(),codec=createRequestStateCodec({key:randomBytes(32),ttlSeconds:300,bind:ctx=>ctx.mcpReq.method+'\0'+identity()});
 const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
 async function run(server,name,input,ctx,operation){
  const hash=digest([name,input]),modern=ctx.mcpReq.envelope?.[PROTOCOL_VERSION_META_KEY]==='2026-07-28';
  for(const [id,value]of pending)if(value.expires<Date.now())pending.delete(id);
  const approvalKey='native-exact-choice:'+website+':'+identity()+':'+hash;
  const already=await store?.get(approvalKey);
  if(already?.hash===hash&&already.expires>Date.now())return nativeResult(await operation());
  const execute=async()=>{await store?.put(approvalKey,{hash,expires:Date.now()+30*60000});return operation();};
  const capabilities=modern?ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY]:server.server.getClientCapabilities();
  const message='Galaxy '+name+'\n'+JSON.stringify(input,null,2)+'\nOnly this shown operation and scope. Existing data is not uploaded unless this operation explicitly selects it.';
  if(!capabilities?.elicitation||capabilities.elicitation.form===undefined&&Object.keys(capabilities.elicitation).length>0){
   const reviewed=await review.request({key:approvalKey,name,input,identity:identity()});
   if(reviewed.state==='accepted')return nativeResult(await execute());
   return nativeResult({...reviewed,state:reviewed.state==='pending'?'user-choice-needs-browser':'declined',operation:name,preview:input,
    retryOriginalOperation:true,reason:'host-form-elicitation-unavailable'});
  }
  if(!modern){const response=await ctx.mcpReq.elicitInput({mode:'form',message,requestedSchema:schema});
   if(response.action!=='accept'||answer.safeParse(response.content).data?.confirm!==true)return nativeResult({state:'declined',sideEffect:false});
   return nativeResult(await execute());}
  const state=ctx.mcpReq.requestState();
  if(!state){const nonce=randomUUID();pending.set(nonce,{hash,expires:Date.now()+300000});
   return inputRequired({inputRequests:{choice:inputRequired.elicit({message,requestedSchema:schema})},requestState:await codec.mint({nonce,hash},ctx)});}
  const record=pending.get(state.nonce);if(!record||record.hash!==hash||state.hash!==hash||record.expires<Date.now())throw new Error('native_choice_changed_or_expired');
  if(record.result)return record.result;if(record.running)throw new Error('native_choice_in_progress');
  const accepted=acceptedContent(ctx.mcpReq.inputResponses,'choice',answer);
  if(accepted?.confirm!==true){pending.delete(state.nonce);return nativeResult({state:'declined',sideEffect:false});}
  record.running=true;try{record.result=nativeResult(await execute());return record.result;}finally{record.running=false;}
 }
 return{run,verify:codec.verify,close:review.close};
}
