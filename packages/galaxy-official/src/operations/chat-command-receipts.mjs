import {z} from 'zod';
import {digest} from '../shared/digest.mjs';
import {ServiceError} from '../shared/service-error.mjs';
import {chatReceiptInput,chatReceiptHash} from '../shared/operations-chat-receipt-intent.mjs';
import {readReceipt} from './command-receipts.mjs';
const id=z.uuid(),positive=z.number().int().positive(),state=z.enum(['received','reviewing','resolved','appealed','withdrawn']);
const auditResult=z.object({version:positive,state});
// The operator event and the same-transaction business audit are the evidence.
// Ordinary-account receipts and current material/head views are never a fallback.
export function chatCommandResult({db,endpoint,operator,authorize,now},operationId,reportId){
 if(!id.safeParse(reportId).success)throw new ServiceError('invalid_operations_command_receipt',400);
 return readReceipt({endpoint,operator,authorize,operationId,now,
  load:async op=>(await db.query(`SELECT e.operator_id,e.actor_kind,e.report_id,e.kind,e.version,e.input,e.erased_at,e.created_at,
   a.operator_id AS audit_operator_id,a.actor_kind AS audit_actor_kind,a.action AS audit_action,a.operation_id AS audit_operation_id,a.created_at AS audit_created_at,a.selection,a.result
   FROM account_chat_governance_events_v1 e JOIN account_chat_reports_v1 r ON r.id=e.report_id
   LEFT JOIN business_admin_audit_v1 a ON a.endpoint=r.endpoint AND a.operation_id=e.id
   WHERE r.endpoint=$1 AND e.id=$2`,[endpoint,op])).rows,
  project:row=>{
   try{
    if(row.actor_kind!=='business-operator'||row.audit_actor_kind!=='business-operator'||row.audit_operator_id!==row.operator_id||row.audit_action!=='chat-report-event'||row.erased_at||row.report_id!==reportId)return null;
    const x=chatReceiptInput(row.kind,row.input),r=auditResult.parse(row.result),s=row.selection;
    if(x.operationId!==operationId||row.audit_operation_id!==operationId||x.reportId!==reportId||row.version!==x.expectedVersion+1||r.version!==row.version||s?.reportId!==reportId||s.kind!==row.kind)return null;
    const message=row.kind.startsWith('message-');
    if((row.kind==='review'||row.kind==='pause')&&r.state!=='reviewing'||row.kind==='resolve'&&r.state!=='resolved')return null;
    const recordedAt=z.iso.datetime().parse(new Date(row.audit_created_at).toISOString());
    const result={reportId,version:r.version,state:r.state,recordedAt,intentHash:chatReceiptHash(row.kind,x,digest)};
    if(message){
     if(s.messageId!==x.messageId||s.sourceRevision!==x.messageRevision||row.result.revision!==x.expectedRevision+1||typeof row.result.hidden!=='boolean')return null;
     Object.assign(result,{messageId:x.messageId,messageRevision:x.messageRevision,dispositionRevision:row.result.revision,overallHiddenAtCommit:row.result.hidden});
    }
    return {kind:row.kind,result};
   }catch{return null;}
  }});
}
