import {sha256Hex} from '../../../../galaxy-official/src/shared/web-primitives.mjs';
import {readWithTransientRecovery} from '../../../../../integrations/shared/read-task.mjs';
import {accountFollowCommandSchema,accountFollowStatusSchema,accountFollowPageSchema,accountFollowReceiptSchema} from '../../../../galaxy-official/src/shared/account-follows-schema.mjs';
import {createCurrentOfficialAccount} from "../accounts/official-account-reading.mjs";

const fail=(code)=>{throw Object.assign(Error(code),{code});};
/** No local storage and no automatic command replay. The current account scope
 * owns only one closed, non-secret original intent per target.
 * @param {{client:ReturnType<typeof import('../accounts/official-account-client.mjs').createOfficialAccountClient>,
 * lease:import('../accounts/online-account-draft-memory').AccountSettingsDraftLease,
 * memory:import('../accounts/online-account-draft-memory').OnlineAccountDraftMemory,
 * getCurrent:()=>import('../accounts/official-account-panel').OfficialAccountModel}} options
 */
export function createAccountFollowsClient({client,lease,memory,getCurrent}){
 const ownerId=lease.accountId,current=createCurrentOfficialAccount({client,accountId:ownerId,csrfToken:lease.csrfToken,getCurrent});
 const call=(method,input,options={})=>{
  const action=()=>current.call('/v1/account/follows/'+method,input,options);
  return ['query','status','receipt'].includes(method)?readWithTransientRecovery(action,{signal:options.signal,check:current.assertCurrent}):action();
 };
 const verifyOwner=value=>{if(value.accountId!==ownerId)fail('account_follow_response_invalid');return value;};
 const pending=target=>memory.readFollowIntent(lease,target);
 async function status(targetAccountId,options={}){
  const result=verifyOwner(accountFollowStatusSchema.parse(await call('status',{targetAccountId},options)));
  if(result.relationship.targetAccountId!==targetAccountId)fail('account_follow_response_invalid');return result;
 }
 function verifyReceipt(value,record){
  const result=verifyOwner(accountFollowReceiptSchema.parse(value));
  if(result.operationId!==record.command.operationId||result.payloadHash!==record.payloadHash||result.state==='acknowledged'&&
   (result.relationship.targetAccountId!==record.command.targetAccountId||result.relationship.following!==record.command.following||
    result.relationship.revision<record.command.expectedRevision||result.relationship.revision>record.command.expectedRevision+1))fail('account_follow_response_invalid');
  return result;
 }
 async function recover(targetAccountId,options={}){
  current.assertCurrent();const record=pending(targetAccountId);if(!record)return null;
  if(await sha256Hex(JSON.stringify(record.command))!==record.payloadHash)fail('account_follow_original_changed');
  current.assertCurrent();const result=verifyReceipt(await call('receipt',{operationId:record.command.operationId,payloadHash:record.payloadHash},options),record);
  if(result.state==='acknowledged')memory.clearFollowIntent(lease,targetAccountId,record.command.operationId);
  return result;
 }
 return {
  ownerId,current:()=>current.assertCurrent(),pending,pendingAll:()=>memory.listFollowIntents(lease),status,recover,
  async query(input={},options={}){
   // Returning to the owner list also reads original outcomes whose relation
   // already disappeared (for example a canceled choice with a lost ACK).
   for(const record of memory.listFollowIntents(lease)){
    try{await recover(record.command.targetAccountId,options);}catch{current.assertCurrent();}
   }
   const page=verifyOwner(accountFollowPageSchema.parse(await call('query',input,options))),seen=new Set();
   if(page.readExpiresAt<=page.checkedAt||page.readExpiresAt*1000<=Date.now())fail('account_follow_response_invalid');
   for(const item of page.items){const id=item.relationship.targetAccountId;
    if(!item.relationship.following||seen.has(id)||item.source.state==='available'&&item.source.profile.accountId!==id)fail('account_follow_response_invalid');seen.add(id);
   }
   return page;
  },
  async change(targetAccountId,following){
   current.assertCurrent();if(pending(targetAccountId)){await recover(targetAccountId);return {state:'recovered',pending:!!pending(targetAccountId)};}
   const previous=await status(targetAccountId);
   if(previous.relationship.following===following)return {state:'unchanged',pending:false};
   if(following&&!previous.canFollow)fail('account_follow_target_unavailable');
   const command=accountFollowCommandSchema.parse({operationId:crypto.randomUUID(),targetAccountId,following,expectedRevision:previous.relationship.revision}),
    record={command,payloadHash:await sha256Hex(JSON.stringify(command))};
   current.assertCurrent();if(!memory.writeFollowIntent(lease,record))fail('account_follow_pending');
   try{
    const result=verifyReceipt(await call('command',command),record);
    if(result.state!=='acknowledged')fail('account_follow_response_invalid');
    memory.clearFollowIntent(lease,targetAccountId,command.operationId);return {state:'acknowledged',pending:false};
   }catch(error){
    current.assertCurrent();
    if(error?.outcome==='rejected'&&['account_follow_changed','account_follow_self','account_follow_target_unavailable','invalid_account_follow_request','account_follow_operation_conflict'].includes(error.code)){
     memory.clearFollowIntent(lease,targetAccountId,command.operationId);throw error;
    }
    // A missing ACK, 500 or an unreadable receipt cannot establish non-execution.
    return {state:'pending',pending:true};
   }
  },
 };
}
