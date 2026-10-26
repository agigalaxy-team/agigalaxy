import {z} from 'zod';
import {transaction} from "../../infrastructure/database.mjs";
import {autonomyDefaults,parse,fail} from './contract.mjs';
export const autonomySettingsSchema=z.strictObject({operationId:z.uuid(),expectedRevision:z.number().int().positive(),concurrency:z.number().int().min(1).max(2),healthSeconds:z.number().int().min(10).max(300),startGraceSeconds:z.number().int().min(30).max(1800),roundSeconds:z.number().int().min(60).max(3600),eventCoalesceSeconds:z.number().int().min(1).max(300)});
export async function runtimeSettingsWithin(service,db){
 await db.query('INSERT INTO operations_autonomy_runtime_v1(endpoint,revision,configuration,updated_at) VALUES($1,1,$2,$3) ON CONFLICT DO NOTHING',[service.endpoint,JSON.stringify(autonomyDefaults),service.at()]);
 const row=(await db.query('SELECT * FROM operations_autonomy_runtime_v1 WHERE endpoint=$1',[service.endpoint])).rows[0];
 return{revision:row.revision,...row.configuration};
}
export async function readAutonomySettings(service,operator){await service.actor(operator);const settings=await runtimeSettingsWithin(service,service.db);await service.actor(operator);return{settings,limits:{concurrencyMaximum:2},...service.stamp()};}
export async function saveAutonomySettings(service,operator,input,{authorize}={}){
 const x=parse(autonomySettingsSchema,input);return transaction(service.db,async db=>{const actor=await service.actor(operator,'autonomy.configure',{db,authorize}),prior=await service.previousWithin(db,actor,x.operationId,'settings',x);if(prior)return prior;
  await runtimeSettingsWithin(service,db);const row=(await db.query('SELECT * FROM operations_autonomy_runtime_v1 WHERE endpoint=$1 FOR UPDATE',[service.endpoint])).rows[0];if(row.revision!==x.expectedRevision)fail('operations_autonomy_revision_changed');const {operationId,expectedRevision:_expectedRevision,...configuration}=x;
  await db.query('UPDATE operations_autonomy_runtime_v1 SET revision=revision+1,configuration=$2,updated_by=$3,updated_at=$4 WHERE endpoint=$1',[service.endpoint,JSON.stringify(configuration),actor.operatorId,service.at()]);
  await db.query('INSERT INTO operations_autonomy_runtime_versions_v1(endpoint,revision,configuration,operator_id,created_at) VALUES($1,$2,$3,$4,$5)',[service.endpoint,row.revision+1,JSON.stringify(configuration),actor.operatorId,service.at()]);
  return service.recordWithin(db,actor,operationId,'settings',x,{operationId,settings:{revision:row.revision+1,...configuration},replayed:false});
 });
}
