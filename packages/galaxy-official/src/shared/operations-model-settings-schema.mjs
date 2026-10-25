import {z} from 'zod';
import {ServiceError} from './service-error.mjs';

export const modelSettingsDomains=Object.freeze(['overview','governance','messaging','discovery','maintenance']);
export const modelSettingsFormats=Object.freeze(['openai-chat','openai-responses','anthropic','gemini']);
const uuid=z.uuid().transform(value=>value.toLowerCase());
const revision=z.number().int().min(0).max(2147483646);
const modelId=z.string().min(1).max(200).refine(value=>!/[\s\p{Cc}]/u.test(value)).nullable();
export const modelSettingsEfforts=Object.freeze(['none','minimal','low','medium','high','xhigh','max']);
const effort=z.enum(modelSettingsEfforts);
const credentialRef=z.string().regex(/^model-key:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const baseUrl=z.string().trim().min(1).max(2048).refine(value=>{
 try{
  if(!/^https?:\/\//i.test(value)||/[\s\p{Cc}]/u.test(value))return false;
  const u=new URL(value);
  if(!u.hostname||u.username||u.password||u.search||u.hash)return false;
  if(u.protocol==='https:')return true;
  // Match the native loader's literal loopback hosts. URL.hostname alone
  // canonicalizes addresses such as 127.1, which the native loader rejects.
  const authority=/^http:\/\/([^/]+)/i.exec(value)?.[1];
  return u.protocol==='http:'&&/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/i.test(authority??'');
 }catch{return false;}
}).nullable();
export const modelSettingsReasoningSchema=z.strictObject({
 mode:z.enum(['default','effort']),effort:effort.nullable(),supportedEfforts:z.array(effort).max(16).refine(values=>new Set(values).size===values.length),supportSource:z.literal('manual'),
}).superRefine((value,ctx)=>{
 if(value.mode==='default'&&value.effort!==null||value.mode==='effort'&&(value.effort===null||!value.supportedEfforts.includes(value.effort)))
  ctx.addIssue({code:'custom',message:'Select a declared effort only when effort mode is selected'});
});
export const modelSettingsModelSchema=z.strictObject({
 id:uuid,displayName:z.string().trim().min(1).max(100),modelId,apiFormat:z.enum(modelSettingsFormats),
 baseUrl,credentialRef:credentialRef.nullable(),contextWindow:z.number().int().positive().max(100000000).nullable(),
 maxOutputTokens:z.number().int().positive().max(100000000).nullable(),timeoutSeconds:z.number().int().min(1).max(1800).nullable(),
 reasoning:modelSettingsReasoningSchema,toolCalling:z.boolean(),structuredOutput:z.boolean(),enabled:z.boolean(),
}).superRefine((value,ctx)=>{
 if(value.contextWindow!==null&&value.maxOutputTokens!==null&&value.maxOutputTokens>=value.contextWindow)
  ctx.addIssue({code:'custom',path:['maxOutputTokens'],message:'Output limit must leave room for input'});
 if(value.apiFormat==='openai-responses'&&value.maxOutputTokens!==null&&value.maxOutputTokens<16)
  ctx.addIssue({code:'custom',path:['maxOutputTokens'],message:'Responses output limit must be at least16'});
 if(value.apiFormat==='gemini'&&value.reasoning.mode==='effort'&&!['none','minimal','low','medium','high'].includes(value.reasoning.effort))
  ctx.addIssue({code:'custom',path:['reasoning','effort'],message:'Unsupported Gemini effort'});
});
const binding=z.strictObject({modelId:uuid,dataPolicyApproved:z.boolean()}).nullable();
export const modelSettingsConfigurationSchema=z.strictObject({
 models:z.array(modelSettingsModelSchema).max(50).refine(models=>new Set(models.map(model=>model.id)).size===models.length),
 scenarios:z.strictObject(Object.fromEntries(modelSettingsDomains.map(domain=>[domain,binding]))),
}).superRefine((value,ctx)=>{
 for(const domain of modelSettingsDomains){const selected=value.scenarios[domain];if(selected&&!value.models.some(model=>model.id===selected.modelId))
  ctx.addIssue({code:'custom',path:['scenarios',domain,'modelId'],message:'Select an existing model record'});}
});
export const emptyModelSettingsConfiguration=()=>({models:[],scenarios:Object.fromEntries(modelSettingsDomains.map(domain=>[domain,null]))});
export function parseModelSettings(schema,input){const result=schema.safeParse(input);if(!result.success)throw new ServiceError('invalid_model_settings_request',400);return result.data;}
export function assertModelSettingsApplicable(configuration){
 const value=parseModelSettings(modelSettingsConfigurationSchema,configuration);
 for(const model of value.models.filter(model=>model.enabled)){
  if([model.modelId,model.baseUrl,model.contextWindow,model.maxOutputTokens,model.timeoutSeconds,model.credentialRef].some(part=>part===null))
   throw new ServiceError('model_settings_model_incomplete',409);
 }
 for(const domain of modelSettingsDomains){const selected=value.scenarios[domain];if(!selected)continue;
  const model=value.models.find(model=>model.id===selected.modelId);if(!model?.enabled)throw new ServiceError('model_settings_binding_unavailable',409);
  if(!selected.dataPolicyApproved)throw new ServiceError('model_settings_data_policy_unapproved',409);
 }
 return value;
}
export const modelSettingsDraftSchema=z.strictObject({operationId:uuid,expectedRevision:revision,configuration:modelSettingsConfigurationSchema,reason:z.string().trim().min(1).max(500)});
export const modelSettingsApplySchema=z.strictObject({operationId:uuid,expectedRevision:revision,versionId:uuid,reason:z.string().trim().min(1).max(500)});
export const modelSettingsCredentialSchema=z.strictObject({operationId:uuid,modelRecordId:uuid,apiKey:z.string().min(1).max(16384).refine(value=>value.trim()===value&&!/[\p{Cc}]/u.test(value))});
export const modelSettingsHistorySchema=z.strictObject({after:z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>BigInt(value)<=9223372036854775807n).optional(),limit:z.number().int().min(1).max(50).default(20)});
export const modelSettingsUsageSchema=z.strictObject({days:z.union([z.literal(7),z.literal(30)]).default(7)});
export const modelSettingsOperationSchema=uuid;
export const modelSettingsNativeCommandSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('models-overview')}),
 z.strictObject({kind:z.literal('models-usage'),days:z.union([z.literal(7),z.literal(30)])}),
 z.strictObject({kind:z.literal('models-operation'),operationId:uuid}),
 z.strictObject({kind:z.literal('models-apply'),operationId:uuid,operatorId:z.string().min(1).max(500),versionId:uuid,revision,configuration:modelSettingsConfigurationSchema}),
 z.strictObject({kind:z.literal('models-credential-provision'),operationId:uuid,operatorId:z.string().min(1).max(500),modelRecordId:uuid,apiKey:modelSettingsCredentialSchema.shape.apiKey}),
]);
export const modelSettingsNativeAuthorizationSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('models-apply'),operationId:uuid,operatorId:z.string().min(1).max(500),versionId:uuid,revision,configuration:modelSettingsConfigurationSchema}),
 z.strictObject({kind:z.literal('models-credential-provision'),operationId:uuid,operatorId:z.string().min(1).max(500),modelRecordId:uuid}),
]);

