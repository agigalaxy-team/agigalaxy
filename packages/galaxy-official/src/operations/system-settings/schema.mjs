import {z} from 'zod';
import {ServiceError} from '../../shared/service-error.mjs';
import {smtpConfigurationSchema,smtpHostSchema} from '../../shared/operations-smtp-schema.mjs';
import {serviceConnectionsConfigurationSchema,serviceCredentialProvisionSchema,serviceConnectionBindingSchema} from './service-connections-schema.mjs';

export const systemSettingsSections=Object.freeze(['mail','service-connections']);
export const systemSettingsMailPurposes=Object.freeze(['operations','account-authentication','runtime-alerts']);
export const systemSettingsOperationStates=Object.freeze(['accepted','completed','partial','failed','unknown']);
export const systemSettingsPhaseStates=Object.freeze(['pending','running','completed','failed','unknown']);
export const systemSettingsErrorCodes=Object.freeze([
 'system_settings_native_not_configured','system_settings_native_unavailable','system_settings_native_response_invalid',
 'system_settings_permission_denied','system_settings_authorization_unavailable','system_settings_version_changed',
 'system_settings_operation_changed','system_settings_operation_unknown','system_settings_credential_unavailable',
 'system_settings_credential_binding_mismatch','system_settings_configuration_incomplete','system_settings_target_unavailable',
 'system_settings_adoption_unconfirmed','system_settings_apply_failed','system_settings_apply_unknown',
 'system_settings_test_failed','system_settings_connection_failed','system_settings_private_configuration_invalid',
 'system_settings_native_busy','system_settings_source_changed','system_settings_mail_submission_unknown',
 'system_settings_mail_not_submitted','system_settings_consumer_not_configured','system_settings_control_not_configured',
]);
export const systemSettingsUuidSchema=z.uuid().transform(value=>value.toLowerCase());
export const systemSettingsRevisionSchema=z.number().int().min(0).max(2147483646);
export const systemSettingsCredentialRefSchema=z.string().regex(/^system-key:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const text=max=>z.string().trim().min(1).max(max).refine(value=>!/[\p{Cc}]/u.test(value));
const secret=z.string().min(1).max(4096).refine(value=>!/[\p{Cc}]/u.test(value));
const operatorId=z.string().regex(/^[0-9a-f]{64}$/);
const uuid=systemSettingsUuidSchema,revision=systemSettingsRevisionSchema;
const mailTransportFields=Object.fromEntries(Object.entries(smtpConfigurationSchema.shape).filter(([key])=>!['enabled','credentialRef'].includes(key)));
export const systemSettingsMailConnectionSchema=z.strictObject({
 id:uuid,name:text(100),...mailTransportFields,
 credentialRef:systemSettingsCredentialRefSchema.nullable(),
});
export const systemSettingsMailConfigurationSchema=z.strictObject({
 connections:z.array(systemSettingsMailConnectionSchema).max(16).refine(rows=>new Set(rows.map(row=>row.id)).size===rows.length),
 bindings:z.strictObject(Object.fromEntries(systemSettingsMailPurposes.map(purpose=>[purpose,uuid.nullable()]))),
}).superRefine((value,context)=>{
 for(const purpose of systemSettingsMailPurposes){const id=value.bindings[purpose];
  if(id!==null&&!value.connections.some(row=>row.id===id))context.addIssue({code:'custom',path:['bindings',purpose],message:'Select an existing connection'});
 }
});
const configurationSchemas={'mail':systemSettingsMailConfigurationSchema,'service-connections':serviceConnectionsConfigurationSchema};
export function systemSettingsConfiguration(section,input){
 const schema=configurationSchemas[section];if(!schema)throw new ServiceError('invalid_system_settings_request',400);
 return parseSystemSettings(schema,input);
}
export function assertSystemSettingsEffectConfiguration(section,input,{kind,connectionId}={}){
 const value=systemSettingsConfiguration(section,input),selected=kind==='test'?value.connections.filter(row=>!connectionId||row.id===connectionId):
  section==='mail'?value.connections.filter(row=>Object.values(value.bindings).includes(row.id)):value.connections;
 const fail=()=>{throw new ServiceError('system_settings_configuration_incomplete',409);};
 if(!selected.length)fail();
 for(const row of selected){
  if(section==='mail'){
   if(!row.host||!row.port||!row.tls||!row.credentialRef)fail();
   if(kind==='apply'&&value.bindings.operations===row.id&&['connectionTimeoutMs','greetingTimeoutMs','socketTimeoutMs','maxConnections','rateLimit','rateWindowSeconds'].some(key=>row[key]===null))fail();
  }else if(row.kind!=='file-scanning'&&!row.credentialRef)fail();
 }
 return value;
}
const base={operationId:uuid,expectedRevision:revision};
export const systemSettingsSaveSchema=z.strictObject({...base,configuration:z.unknown()});
export const systemSettingsApplySchema=z.strictObject({...base,versionId:uuid});
export const systemSettingsTestSchema=systemSettingsApplySchema.extend({connectionId:uuid.optional()});
const mailBinding=z.strictObject({id:uuid,host:smtpHostSchema,port:z.number().int().min(1).max(65535),tls:z.enum(['implicit','starttls'])});
const provisionBase={...base,connectionId:uuid};
const mailProvision=z.strictObject({...provisionBase,section:z.literal('mail'),binding:mailBinding,credential:z.strictObject({user:secret.max(320),password:secret})});
const serviceProvision=z.strictObject({...provisionBase,section:z.literal('service-connections'),binding:z.unknown(),credential:z.unknown()});
export const systemSettingsCredentialSchema=z.discriminatedUnion('section',[mailProvision,serviceProvision]).superRefine((value,context)=>{
 if(value.binding?.id!==value.connectionId)context.addIssue({code:'custom',path:['connectionId'],message:'Credential binding must match the selected connection'});
 if(value.section==='service-connections'&&!serviceCredentialProvisionSchema.safeParse({binding:value.binding,credential:value.credential}).success)
  context.addIssue({code:'custom',path:['binding'],message:'Invalid service credential binding'});
});
export const systemSettingsHistorySchema=z.strictObject({after:z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>BigInt(value)<=9223372036854775807n).optional(),limit:z.number().int().min(1).max(50).default(20)});
const nativeWrite={operationId:uuid,operatorId,section:z.enum(systemSettingsSections),revision,versionId:uuid,configuration:z.unknown()};
export const systemSettingsNativeCommandSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('settings-overview'),section:z.enum(systemSettingsSections)}),
 z.strictObject({kind:z.literal('settings-operation'),operationId:uuid,operatorId,section:z.enum(systemSettingsSections)}),
 z.strictObject({kind:z.literal('settings-credential-provision'),...provisionBase,operatorId,section:z.enum(systemSettingsSections),binding:z.unknown(),credential:z.unknown()}),
 z.strictObject({kind:z.literal('settings-test'),...nativeWrite,connectionId:uuid.optional()}),
 z.strictObject({kind:z.literal('settings-apply'),...nativeWrite}),
]).superRefine((value,context)=>{
 try{
  if(['settings-test','settings-apply'].includes(value.kind))systemSettingsConfiguration(value.section,value.configuration);
  if(value.kind==='settings-credential-provision'){
   const {kind,operatorId:unused,...intent}=value;parseSystemSettings(systemSettingsCredentialSchema,intent);
  }
 }catch{context.addIssue({code:'custom',message:'Invalid fixed system settings command'});}
});
export const systemSettingsNativeAuthorizationSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('settings-credential-provision'),...provisionBase,operatorId,section:z.enum(systemSettingsSections),binding:z.unknown()}),
 z.strictObject({kind:z.literal('settings-test'),...nativeWrite,connectionId:uuid.optional()}),
 z.strictObject({kind:z.literal('settings-apply'),...nativeWrite}),
]).superRefine((value,context)=>{
 if(value.kind==='settings-credential-provision'){
  const result=(value.section==='mail'?mailBinding:serviceConnectionBindingSchema).safeParse(value.binding);
  if(!result.success||value.binding?.id!==value.connectionId)context.addIssue({code:'custom',message:'Invalid fixed credential target'});
 }else try{systemSettingsConfiguration(value.section,value.configuration);}catch{context.addIssue({code:'custom',message:'Invalid fixed configuration'});}
});
export const systemSettingsPhaseSchema=z.strictObject({
 target:text(100),state:z.enum(systemSettingsPhaseStates),code:z.enum(systemSettingsErrorCodes).nullable(),
 adoptedVersionId:uuid.nullable(),
 checks:z.array(z.strictObject({kind:z.enum(['transport','authentication','index','reader-authentication','writer-authentication','scanner-signatures','runtime','execution-signature']),state:z.enum(['passed','failed','not-tested'])})).max(12).optional(),
});
export const systemSettingsOperationSchema=z.strictObject({
 operationId:uuid,section:z.enum(systemSettingsSections),kind:z.enum(['save','test','apply','credential']),
 state:z.enum(systemSettingsOperationStates),versionId:uuid.nullable(),revision,
 credentialRef:systemSettingsCredentialRefSchema.optional(),
 phases:z.array(systemSettingsPhaseSchema).max(20),startedAt:z.iso.datetime({offset:true}),finishedAt:z.iso.datetime({offset:true}).nullable(),
});
export function parseSystemSettings(schema,input){const result=schema.safeParse(input);if(!result.success)throw new ServiceError('invalid_system_settings_request',400);return result.data;}
export function safeSystemSettingsError(error,fallback='system_settings_native_unavailable'){
 return systemSettingsErrorCodes.includes(error?.code)?error.code:fallback;
}
export function credentialMetadata(input){const {credential,...metadata}=input;return metadata;}
