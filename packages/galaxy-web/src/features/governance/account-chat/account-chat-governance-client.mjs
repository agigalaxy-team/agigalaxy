import {accountChatReportSchema,accountChatReportEventSchema} from "../../../../../galaxy-official/src/shared/account-chat-governance-schema.mjs";

// The journal belongs to the real online account. It stores the user's own
// statement and selected source locators, never copies of chat message bodies.
export function createAccountChatGovernanceClient({client,session,runtime}){
 const owner='account:'+session.account.id,key='account-chat-governance:'+runtime.api.endpoint;
 const call=(method,input,options={})=>client.call('/v1/account/chat-reports/'+method,input,{session,...options});
 const read=()=>runtime.getLocal(key,owner);
 const update=fn=>runtime.updateLocal(key,current=>fn(current&&current.accountId===session.account.id?current:{accountId:session.account.id,drafts:{},pending:{}}),owner);
 const remove=(operationId,settled=null)=>update(current=>{
  const pending={...current.pending};delete pending[operationId];const drafts={...current.drafts};
  if(settled){const locator=settled.reportId?'case:'+settled.reportId:'room:'+settled.roomId,draft=drafts[locator];
   if(draft&&draft.summary.trim()===settled.summary&&JSON.stringify(draft.selections??[])===JSON.stringify(settled.materials??[]))drafts[locator]={...draft,summary:'',action:'',selections:[]};
  }
  return{...current,pending,drafts};
 });
 return{
  call,
  async draft(locator){return(await read())?.drafts?.[locator]??null;},
  saveDraft(locator,draft){return update(current=>({...current,drafts:{...current.drafts,[locator]:structuredClone(draft)}}));},
  async pending(){return Object.values((await read())?.pending??{});},
  async submit(kind,input){
   const payload=(kind==='report'?accountChatReportSchema:accountChatReportEventSchema).parse(input);
   await update(current=>({...current,pending:{...current.pending,[payload.operationId]:{kind,payload}}}));
   try{const result=await call(kind,payload);await remove(payload.operationId,payload);return result;}
   catch(error){if(error?.outcome==='rejected')await remove(payload.operationId);throw error;}
  },
  async resume(operation){
   const receipt=await call('receipt',{operationId:operation.payload.operationId});
   if(receipt.state==='recorded'){await remove(operation.payload.operationId,operation.payload);return receipt;}
   if(receipt.state!=='absent')throw Error('chat_report_operation_conflict');
   try{const result=await call(operation.kind,operation.payload);await remove(operation.payload.operationId,operation.payload);return{state:'recorded',reportId:result.reportId};}
   catch(error){if(error?.outcome==='rejected')await remove(operation.payload.operationId);throw error;}
  }
 };
}
