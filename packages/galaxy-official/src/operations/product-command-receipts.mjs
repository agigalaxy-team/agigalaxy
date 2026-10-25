import {z} from 'zod';
import {digest} from '../shared/digest.mjs';
import {ServiceError} from '../shared/service-error.mjs';
import {productReceiptInput,productReceiptHash} from '../shared/operations-product-receipt-intent.mjs';
import {readReceipt} from './command-receipts.mjs';
const id=z.uuid(),positive=z.number().int().positive(),iso=z.iso.datetime();
const notice=z.object({id,version:positive,state:z.enum(['draft','queued','withdrawn']),jobId:id.nullable()});
const run=z.object({id,target:z.enum(['private-conversation-archives','data-exports','information-watches']),state:z.literal('queued'),jobId:id,createdAt:iso});
const stamp=value=>{try{const x=new Date(value).toISOString();return iso.parse(x);}catch{return null;}};
// Only the immutable original product ledger. No current notice, recipient
// delivery counts, retention run result or input text is exposed here.
export function productCommandResult({db,endpoint,operator,authorize,now},operationId,family){
 if(!['notices','retention'].includes(family))throw new ServiceError('invalid_operations_command_receipt',400);
 return readReceipt({endpoint,operator,authorize,operationId,now,
  load:async op=>(await db.query('SELECT operator_id,action,input,result,created_at FROM operations_product_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[endpoint,op])).rows,
  project:row=>{
   try{
    const x=productReceiptInput(row.action,row.input),recordedAt=stamp(row.created_at);
    if(x.operationId!==operationId||!recordedAt)return null;
    const intentHash=productReceiptHash(row.action,x,digest);
    if(family==='retention'){
     if(row.action!=='retention-request')return null;
     const r=run.parse(row.result?.run);
     return r.id===operationId&&r.target===x.target?{kind:row.action,result:{runId:r.id,target:r.target,state:'queued',jobId:r.jobId,createdAt:r.createdAt,recordedAt,intentHash}}:null;
    }
    if(!row.action.startsWith('notice-'))return null;
    const n=notice.parse(row.result?.notice),expectedState=row.action==='notice-publish'?'queued':row.action==='notice-withdraw'?'withdrawn':'draft';
    if(n.id!==(x.noticeId??operationId)||n.version!==(x.expectedVersion??0)+1||n.state!==expectedState||row.action==='notice-publish'&&!n.jobId)return null;
    return {kind:row.action,result:{noticeId:n.id,version:n.version,state:n.state,submittedJobId:n.jobId,recordedAt,intentHash}};
   }catch{return null;}
  }});
}
