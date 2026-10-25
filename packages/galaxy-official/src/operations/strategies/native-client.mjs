import {ServiceError} from '../../shared/service-error.mjs';
import {z} from 'zod';
import {p13NativeRunMetadataSchema as nativeRun} from '../../shared/p13-native-run-metadata.mjs';
const nativeId=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),pauseId=z.string().regex(/^[A-Za-z0-9_-]{1,128}:[0-9]{1,6}$/);

const continuation=z.strictObject({operationId:z.uuid(),runId:z.uuid(),nativeRunId:nativeId,pauseId,state:z.enum(['accepted','not-recorded','unknown'])});
const historicalContinuations=z.strictObject({state:z.enum(['available','unavailable']),complete:z.boolean(),items:z.array(continuation.extend({state:z.literal('accepted')})).max(50)});

// Reuses the existing private AgentOS transport and current-execution JWT.
// No provider URL, model name, secret or browser-supplied native run is accepted.
export class P13StrategiesNativeClient{
 constructor({client}){this.client=client;}
 async status(){const status=await this.client.status();if(status.state!=='connected')return {...status,workflow:'galaxy-p13-selected-content-v1'};
  try{const response=await this.client.fetchImpl(this.client.url+'/health',{redirect:'error',signal:AbortSignal.timeout(5000)}),v=await response.json();if(!response.ok||v.strategies?.state!=='ready'||v.strategies?.workflowId!=='galaxy-p13-selected-content-v1'||v.strategies.workflowVersion!==1)throw Error();return {...status,workflow:'galaxy-p13-selected-content-v1'};}
  catch{return {...status,state:'not-connected',workflow:'galaxy-p13-selected-content-v1'};}
 }
 async start(row){const status=await this.status();if(status.state!=='connected')throw new ServiceError('p13_native_workflow_not_connected',503);
  return this.client.request({id:row.execution_id},'/galaxy/p13-strategies/'+row.id+'/start',{idempotencyKey:row.id,form:{session_id:row.session_id}});}
 async read(row,{history=false}={}){
  try{
   if(history){
    // The caller already checked current strategies.read and ownership. A
    // stopped execution cannot re-run, but its metadata remains auditable.
    if(!nativeId.safeParse(row.native_run_id).success)return null;
    const raw=await this.client.runDetail(row.native_run_id),run=raw?.run;
    if(raw?.metadataOnly!==true||run?.runId!==row.native_run_id||run.executionId!==row.execution_id||run.sessionId!==row.session_id||run.componentId!=='galaxy-p13-selected-content-v1'||run.componentType!=='workflow')return null;
    const value=nativeRun.safeParse(raw.strategyWorkflow);return value.success&&value.data.runId===row.native_run_id?value.data:null;
   }
   const value=nativeRun.safeParse(await this.client.request({id:row.execution_id},'/galaxy/p13-strategies/'+row.id));if(!value.success)throw new ServiceError('p13_native_response_invalid',503);return value.data;
  }catch(error){if(!history&&error.status===403)throw error;return null;}
 }
 async continuation(row,operationId,{history=false,expectedPauseId=null}={}){
  try{
   if(history){
    if(!nativeId.safeParse(row.native_run_id).success||!z.uuid().safeParse(operationId).success||!pauseId.safeParse(expectedPauseId).success)return null;
    const raw=await this.client.runDetail(row.native_run_id),run=raw?.run;
    if(raw?.metadataOnly!==true||run?.runId!==row.native_run_id||run.executionId!==row.execution_id||run.sessionId!==row.session_id||run.componentId!=='galaxy-p13-selected-content-v1'||run.componentType!=='workflow')return null;
    const parsed=historicalContinuations.safeParse(raw.strategyContinuations);
    if(!parsed.success||parsed.data.state!=='available'||!parsed.data.complete)return null;
    const original=parsed.data.items.find(item=>item.operationId===operationId);
    if(original)return original.runId===row.id&&original.nativeRunId===row.native_run_id&&original.pauseId===expectedPauseId?original:null;
    // Positive absence comes only from the retained, matched original ticket.
    // A missing/expired ticket above remains unknown, never send permission.
    return {operationId,runId:row.id,nativeRunId:row.native_run_id,pauseId:expectedPauseId,state:'not-recorded'};
   }
   const value=continuation.safeParse(await this.client.request({id:row.execution_id},'/galaxy/p13-strategies/'+row.id+'/continuations/'+operationId));if(!value.success)throw new ServiceError('p13_native_response_invalid',503);return value.data;
  }catch(error){if(!history&&error.status===403)throw error;return null;}
 }
 continue(row,{confirmed,inputDecision,operationId}){return this.client.request({id:row.execution_id},'/galaxy/p13-strategies/'+row.id+'/continue',{
  idempotencyKey:operationId,form:{...(confirmed===undefined?{input_decision:inputDecision}:{confirmed:String(confirmed)}),session_id:row.session_id}});}
}
