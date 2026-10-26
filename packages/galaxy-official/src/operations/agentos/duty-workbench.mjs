/** Native observations and original human-card receipts for new workbench tasks.
 * These are projections of the trusted Node/native ledgers, never model claims.
 */
import {originalBatchReceiptDetails,originalOperationTarget} from "./duty-receipts.mjs";
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const duration=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const states={PENDING:['accepted','running'],RUNNING:['running','running'],COMPLETED:['completed','completed'],PAUSED:['running','waiting-human'],ERROR:['failed','failed'],CANCELLED:['cancelled','stopped']};
export function workbenchRunFact(run){
 const [modelState,status]=states[run?.status]??['unknown','unknown'],usage=run?.usage??run?.metrics??{};
 return{nativeRunId:run?.runId??null,modelState,status,
  usage:{calls:count(usage.calls),inputTokens:count(usage.inputTokens),outputTokens:count(usage.outputTokens),totalTokens:count(usage.totalTokens),durationMs:duration(usage.durationMs)}};
}
export function workbenchCardFact(card){
 const operationId=card?.operation_id??card?.operationId,proposal=card?.proposal??card,
  result=card?.result,kind=proposal?.kind,target=proposal?.target;
 if(card?.state==='prepared')return{status:'waiting-human'};
 if(card?.state==='processing')return{status:'running'};
 if(card?.state==='not-available'&&result?.state==='cancelled')return{status:'stopped'};
 if(!operationId||result?.operationId!==operationId)return null;
 const state=card?.state==='completed'&&result?.state==='completed'&&result?.receipt&&typeof result.receipt==='object'?'completed':
  card?.state==='unknown'?'unknown':null;
 if(!state)return null;
 const batch=kind==='public-content-batch',details=batch?originalBatchReceiptDetails(result?.receipt):null;
 if(batch&&!details)return null;
 return{status:state,businessReceipt:{operationId,action:kind,...(batch?{targetType:null,targetId:null}:originalOperationTarget(target,proposal.request)),
  state,basis:'workbench-original-domain-receipt',...(details?{details}:{})}};
}
