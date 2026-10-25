import {z} from 'zod';
import {operationsParse,operationsFail} from '../../operations-content-visibility.mjs';
import {operationsFileRetrySchema} from '../../shared/operations-business-schema.mjs';
import {fileProcessingVersion} from './processing.mjs';
import {OperationsFilesReadModel} from './read-model.mjs';

export class OperationsFilesService extends OperationsFilesReadModel {
 async retry(operator,kind,id,input,{authorize=null}={}){
  const actor=this.require(operator,true),x=operationsParse(operationsFileRetrySchema,input);operationsParse(z.uuid(),id);const service=this.service(kind);
  if(typeof authorize!=='function')operationsFail('operations_authorization_unavailable',503);
  const current=async(db=this.db)=>{const fresh=await this.businessAdmin.authorizeAction(await authorize(),'files.scan.retry',{db});if(fresh.operatorId!==actor.operatorId||fresh.endpoint!==actor.endpoint)operationsFail('business_admin_denied',403);return fresh;};
  await current();
  if(x.kind==='cleanup')operationsFail('operations_file_cleanup_authorization_required');
  const receipt=await this.command(actor,'file-retry',{kind,id,command:x,operationId:x.operationId},async(db,operator)=>{
   await current(db);const row=await this.scopedRowWithin(db,kind,id,{write:true});
   if(fileProcessingVersion(row)!==x.expectedVersion)operationsFail('operations_file_changed');
   const file=await this.viewWithin(db,kind,row,operator);
   if(file.retriesRemaining===0)operationsFail('operations_file_retry_limit',429);
   await current(db);await service.retryProcessingWithin(db,row,x);await current(db);
   // Audit the stable scheduling receipt, then separately read the current
   // metadata. A filename is never copied into the generic audit result.
   return{id,kind,state:'scheduled',processingComplete:false};
  });
  await current();return{...receipt,file:await this.get(actor,kind,id)};
 }
}
