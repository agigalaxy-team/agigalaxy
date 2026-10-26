import {isDeepStrictEqual} from 'node:util';
import {transaction} from "../../infrastructure/database.mjs";
import {ServiceError} from "../../shared/service-error.mjs";

export const operationsStamp=value=>value?new Date(value).toISOString():null;
export async function operationsProductCommand(service,operator,action,input,operation){
  service.businessAdmin.require(operator,{write:true});
  return transaction(service.db,async db=>{
    const actor=await service.businessAdmin.authorizeOperation(operator,action,input,{db});
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[service.endpoint+':operations-product:'+input.operationId]);
    const previous=(await db.query('SELECT * FROM operations_product_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[service.endpoint,input.operationId])).rows[0];
    if(previous){
      if(previous.operator_id!==actor.operatorId||previous.action!==action||!isDeepStrictEqual(previous.input,input))throw new ServiceError('operations_command_changed',409);
      return {...previous.result,replayed:true};
    }
    const {result,selection={},auditResult={}}=await operation(db,actor);
    await service.businessAdmin.recordWithin(db,actor,action,{operationId:input.operationId,selection,result:auditResult});
    await db.query(`INSERT INTO operations_product_commands_v1(endpoint,operation_id,operator_id,action,input,result,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[service.endpoint,input.operationId,actor.operatorId,action,JSON.stringify(input),JSON.stringify(result),new Date(service.now()*1000).toISOString()]);
    return {...result,replayed:false};
  });
}
