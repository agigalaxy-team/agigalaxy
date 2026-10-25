import {z} from 'zod';
import {OperationsAgentOsGateway} from '../../operations-agentos-gateway.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

const request=z.strictObject({executionId:z.uuid(),tool:z.enum(['read-selected-strategy','save-selected-strategy-draft','publish-selected-strategy']),arguments:z.record(z.string(),z.unknown()),runId:z.string().min(1).max(128),callId:z.string().min(1).max(128)});
const tools=new Set(['read-selected-strategy','save-selected-strategy-draft','publish-selected-strategy']);
export class P13StrategiesGateway extends OperationsAgentOsGateway{
 async execute(input,options={}){if(!tools.has(input?.tool))return super.execute(input,options);
  // Ordinary strategy tools belong to their independently authorized native
  // execution. Current chat supports selected content work only; never drop a
  // human caller restriction to enter the automatic ordinary-strategy path.
  if(options.caller)throw new ServiceError('operations_agentos_scope_denied',403);
  const parsed=request.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_p13_strategy_request',400);if(!this.ordinaryStrategies)throw new ServiceError('p13_not_configured',503);const x=parsed.data;
  if(x.tool==='read-selected-strategy'){const args=z.strictObject({strategyId:z.uuid()}).safeParse(x.arguments);if(!args.success)throw new ServiceError('invalid_p13_strategy_request',400);return this.ordinaryStrategies.read(x.executionId,args.data.strategyId);}
  return this.ordinaryStrategies.command(x.executionId,x.tool==='save-selected-strategy-draft'?'draft':'publish',x.arguments);
 }
}
