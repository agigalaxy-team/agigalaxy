import {ServiceError} from './shared/service-error.mjs';
import {originalBatchReceiptDetails,originalOperationTarget} from './operations-agentos-duty-receipts.mjs';

const fail=(code,status=403)=>{throw new ServiceError(code,status);};
const humanCodes=new Set(['operations_agentos_human_review_required','operations_autonomy_human_required','operations_ai_human_required']);
const project=async(callback,value)=>{
 if(!callback)return;
 try{await callback(value);}catch{
  // The original domain receipt remains authoritative. A projection outage
  // cannot turn a committed effect into a failed/replayed business command.
  console.error(JSON.stringify({event:'operations_autonomy_projection_failed',taskId:value.taskId,operationId:value.operationId}));
 }
};

/** Compose existing domain writers and the bounded AI-only role service.
 * This callback receives a server-minted actor and original operation from the
 * persistent task ledger. Native/model JSON never supplies either authority.
 */
export function createOperationsAgentOsDutyTools({authority,actions,permissions,authorizeOperation,onBusinessReceipt=null,onHumanRequired=null}){
 return async function dutyTools({task,actor,operationId,tool,arguments:args,reconcile=false}){
  if(!authority?.acceptsDuty?.(actor)||!task||actor.taskId!==task.id||actor.aiAccountId!==task.ai_account_id)fail('operations_ai_duty_operation_denied');
  if(typeof operationId!=='string'||!args||Array.isArray(args)||typeof args!=='object')fail('invalid_operations_autonomy_request',400);
  // The original private Node command ID is never replaced by model input.
  if(Object.hasOwn(args,'operationId')||Object.hasOwn(args,'actor')||Object.hasOwn(args,'role'))fail('invalid_operations_autonomy_request',400);
  try{
   if(tool==='read-ai-delegation'){
    if(Object.keys(args).length)fail('invalid_operations_autonomy_request',400);
    if(typeof permissions?.delegatedDirectory!=='function')fail('operations_autonomy_tool_not_configured',503);
    return permissions.delegatedDirectory(actor);
   }
   if(tool==='manage-ai-role'){
    if(typeof permissions?.delegatedRoleSave!=='function')fail('operations_autonomy_tool_not_configured',503);
    // The service rechecks target, AI-only scope, delegated ceiling, version
    // and the controlling AI's current task in its original transaction.
    const result=await permissions.delegatedRoleSave(actor,{...args,operationId});
    // This service returns only after its immutable delegation event commits.
    // A name, acceptance or model report is never used as a receipt.
    if(result?.operationId!==operationId||!result.recordedAt||!Number.isSafeInteger(result.delegationVersion)
      ||!(result.role?.id||result.assignment?.id))fail('operations_autonomy_original_receipt_unknown',503);
    const receipt={operationId,delegationVersion:result.delegationVersion,recordedAt:result.recordedAt,
     ...(result.role?{roleId:result.role.id,version:result.role.version}:{assignmentId:result.assignment.id,aiAccountId:result.assignment.aiAccountId,version:result.assignment.version})};
    const value={...result,state:'completed',effectState:'completed',receipt,businessReceipt:{operationId,action:'ai-role-management',targetType:result.role?'ai-role':'ai-role-assignment',targetId:result.role?.id??result.assignment.id,state:'completed',basis:'persisted-ai-role-delegation-event'}};
    await project(onBusinessReceipt,{taskId:task.id,operationId,action:'ai-role-management',result:value,reconcile});
    return value;
   }
   if(tool!=='execute-operation')fail('operations_autonomy_tool_not_configured',503);
   if(typeof actions?.executeDutyOperation!=='function'||typeof authorizeOperation!=='function')fail('operations_autonomy_tool_not_configured',503);
   const result=await actions.executeDutyOperation({actor,operationId,arguments:args,
    authorizeOperation,reconcile});
   if(result?.operationId!==operationId)fail('operations_autonomy_original_receipt_unknown',503);
   if(result.state==='waiting-human'){
    await project(onHumanRequired,{taskId:task.id,operationId,code:result.code??'operations_agentos_human_review_required'});
    return result;
   }
   const state=result.effectState;
   const batch=args.kind==='public-content-batch',details=batch?originalBatchReceiptDetails(result.receipt):null;
   const recorded=['completed','failed','unknown'].includes(state)&&['persisted-domain-operation-receipt','original-operation-query'].includes(result.basis)
    &&(state!=='completed'||result.receipt&&typeof result.receipt==='object')&&(!batch||details);
   const value=recorded?{...result,businessReceipt:{operationId,action:args.kind,...(batch?{targetType:null,targetId:null}:originalOperationTarget(result.target,args)),state,basis:result.basis,...(details?{details}:{})}}:result;
   if(recorded)await project(onBusinessReceipt,{taskId:task.id,operationId,action:args.kind,result:value,reconcile});
   return value;
  }catch(error){
   if(!humanCodes.has(error?.code))throw error;
   await project(onHumanRequired,{taskId:task.id,operationId,code:error.code});
   return {state:'waiting-human',reason:error.code,operationId,effectState:'not-confirmed'};
  }
 };
}
