import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {transaction} from "../../infrastructure/database.mjs";
import {ServiceError} from '../../shared/service-error.mjs';
import {systemSettingsNativeAuthorizationSchema,parseSystemSettings} from './schema.mjs';
import {operationsSmtpCredentialAlias} from './smtp-credentials.mjs';

const failure=(code,status=409)=>{throw new ServiceError(code,status);};
const childId=id=>{const h=createHash('sha256').update('system-settings-operations-smtp\0'+id).digest('hex').slice(0,32).split('');h[12]='5';h[16]='a';const s=h.join('');return[s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join('-');};
const requestSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('operations-overview')}),
 z.strictObject({kind:z.literal('operations-apply'),intent:systemSettingsNativeAuthorizationSchema}),
 z.strictObject({kind:z.literal('operations-readback'),operationId:z.uuid(),operatorId:z.string().regex(/^[a-f0-9]{64}$/)}),
]);

/** Fixed internal mail bridge. It cannot choose another SMTP action, recipient
 * or message. The original SMTP CAS, operation ledger and audit are reused. */
export class SystemSettingsOperationsMailBridge{
 constructor({settings,operationsSmtp}){Object.assign(this,{settings,smtp:operationsSmtp});}
 async overview(){
  if(!this.smtp)return{state:'not-configured',version:0,configuration:null};
  const current=await this.smtp.current();return{state:(await this.smtp.status(current)).state,...current};
 }
 async claim(intent){
  await this.settings.authorizeNative(intent);
  return transaction(this.settings.db,async db=>{
   await this.settings.operationLock(db,intent.operationId);
   const row=await this.settings.row(db,intent.operationId);
   if(!row||row.operator_id!==intent.operatorId||row.section!=='mail'||row.kind!=='apply')failure('system_settings_permission_denied',403);
   const version=await this.settings.version(db,row.version_id,'mail'),id=version?.configuration.bindings.operations;
   const connection=version?.configuration.connections.find(item=>item.id===id);
   if(!connection||!connection.credentialRef)failure('system_settings_configuration_incomplete');
   if(row.result.operationsSmtp)return{row,command:row.result.operationsSmtp};
   const current=await this.smtp.current(db),{id:_unused,name:_name,credentialRef,...transport}=connection;
   const command={operationId:childId(row.operation_id),expectedVersion:current.version,
    configuration:{enabled:true,...transport,credentialRef:operationsSmtpCredentialAlias(credentialRef)}};
   await db.query('UPDATE operations_system_settings_commands_v1 SET result=$3 WHERE endpoint=$1 AND operation_id=$2',
    [this.settings.endpoint,row.operation_id,JSON.stringify({...row.result,operationsSmtp:command})]);
   return{row,command};
  });
 }
 async apply(intent){
  if(!this.smtp)failure('system_settings_consumer_not_configured',503);
  if(intent.kind!=='settings-apply'||intent.section!=='mail')failure('system_settings_permission_denied',403);
  const {row,command}=await this.claim(intent),settings=this.settings;
  const actor={kind:'business-operator',operatorId:row.operator_id,role:row.operator_role,endpoint:settings.endpoint};
  const fresh=async()=>{await settings.authorizeNative(intent);return actor;};
  // The only remapped operation is this fixed settings-derived save. No CMS,
  // SMTP delivery/test, arbitrary action or elevated actor is exposed.
  const scopedAdmin=Object.assign(Object.create(this.smtp.businessAdmin),{
   authorizeAction:(current,action,options)=>{
    if(action!=='smtp.configure')failure('system_settings_permission_denied',403);
    return settings.require(current,'system.settings.apply',options?.db??settings.db);
   },
  });
  const scoped=Object.assign(Object.create(this.smtp),{businessAdmin:scopedAdmin});
  let result;try{result=await scoped.save(actor,command,{authorize:fresh});}
  catch(error){if(error?.code==='smtp_configuration_changed')failure('system_settings_source_changed');throw error;}
  await fresh();return{state:'completed',configurationVersion:result.version,configuration:result.configuration};
 }
 async readback(input){
  const row=await this.settings.row(this.settings.db,input.operationId);
  if(!row||row.operator_id!==input.operatorId||row.section!=='mail'||row.kind!=='apply')failure('system_settings_permission_denied',403);
  const command=row.result.operationsSmtp;if(!command||!this.smtp)return{state:'unknown',configurationVersion:null};
  const current=await this.smtp.current(),status=await this.smtp.status(current);
  return{state:current.version===command.expectedVersion+1&&isDeepStrictEqual(current.configuration,command.configuration)&&status.credentialAvailable?'completed':'unknown',
   configurationVersion:current.version,configuration:current.configuration};
 }
 async call(raw){const value=parseSystemSettings(requestSchema,raw);return value.kind==='operations-overview'?this.overview():value.kind==='operations-apply'?this.apply(value.intent):this.readback(value);}
}
