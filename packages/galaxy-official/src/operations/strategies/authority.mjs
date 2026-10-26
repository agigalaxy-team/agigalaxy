import {OperationsAgentOsAuthority} from "../agentos/authority.mjs";
import {p13Workflow} from '../../shared/p13-strategies-schema.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

// The existing authority remains the only mint for an executor actor. This
// adapter only advertises the fixed native workflow for a stored P13 binding;
// it cannot turn a workflow or model name into an object/action grant.
export class P13StrategiesAuthority extends OperationsAgentOsAuthority{
 constructor(options){super({...options,supportedActions:['strategies.read','strategies.ordinary.configure','strategies.ordinary.publish']});}
 async nativeAuthorization(input){
  if(input.resourceId!==p13Workflow.id&&(input.resourceId||input.resourceType!=='workflows'))return super.nativeAuthorization(input);
  if(input.resourceType!=='workflows'||!this.strategies)return super.nativeAuthorization(input);
  const base=await super.nativeAuthorization({...input,resourceId:null});
  const row=(await this.db.query('SELECT id FROM operations_p13_strategy_runs_v1 WHERE endpoint=$1 AND execution_id=$2',[this.endpoint,input.executionId])).rows[0];
  if(!row){if(input.resourceId===p13Workflow.id)throw new ServiceError('p13_native_binding_denied',403);return base;}
  await this.strategies.nativeContext({runId:row.id,executionId:input.executionId,operation:input.operation});
  return {...base,resourceIds:[...base.resourceIds,p13Workflow.id]};
 }
}
