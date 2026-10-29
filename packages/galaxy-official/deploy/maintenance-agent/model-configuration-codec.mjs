import {assertModelSettingsApplicable,modelSettingsDomains} from '../../../galaxy-contracts/src/operations-model-settings-schema.mjs';
import {modelProtocolBase} from '../../../galaxy-contracts/src/model-endpoint.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=()=>Object.assign(new Error('model_settings_configuration_invalid'),{code:'model_settings_configuration_invalid'});
export const modelAlias=id=>{if(!uuid.test(id))throw fail();return 'galaxy-m'+id.replaceAll('-','');};
export function recordIdFromAlias(alias){
 const x=/^galaxy-m([a-f0-9]{32})$/.exec(alias??'');if(!x)return null;
 return x[1].slice(0,8)+'-'+x[1].slice(8,12)+'-'+x[1].slice(12,16)+'-'+x[1].slice(16,20)+'-'+x[1].slice(20);
}
export function credentialVariable(reference){
 const id=reference?.startsWith('model-key:')?reference.slice(10):'';if(!uuid.test(id))throw fail();
 return 'GALAXY_MODEL_PROVIDER_C'+id.replaceAll('-','').toUpperCase()+'_KEY';
}
export function compileModelConfiguration(configuration,versionId,credentials){
 if(!uuid.test(versionId))throw fail();
 const value=assertModelSettingsApplicable(configuration),version='models-'+versionId;
 const selected=value.models.filter(model=>model.enabled),scenarios=Object.fromEntries(modelSettingsDomains.map(domain=>[domain,null]));
 const rows=[],profiles={};
 for(const model of selected){
  const available=credentials.find(item=>item.reference===model.credentialRef&&item.modelRecordId===model.id&&item.configured);
  if(!available)throw Object.assign(new Error('model_settings_credential_unavailable'),{code:'model_settings_credential_unavailable'});
  const alias=modelAlias(model.id),responses=model.apiFormat==='openai-responses';
  const nativePrefix={'openai-chat':'custom_openai','openai-responses':'custom_openai',anthropic:'anthropic',gemini:'gemini'}[model.apiFormat];
  const profile={apiFormat:model.apiFormat,contextWindow:model.contextWindow,maxOutputTokens:model.maxOutputTokens,
   reasoningEffort:model.reasoning.mode==='effort'?model.reasoning.effort:null,timeoutSeconds:model.timeoutSeconds,
   toolCalling:model.toolCalling,structuredOutput:model.structuredOutput};
  for(const key of ['imageUnderstanding','parallelToolCalls','verbosity'])if(Object.hasOwn(model,key))profile[key]=model[key];
  const domains=modelSettingsDomains.filter(domain=>value.scenarios[domain]?.modelId===model.id);
  if(domains.includes('governance')&&!model.toolCalling)throw fail();
  rows.push({model_name:alias,litellm_params:{model:nativePrefix+'/'+model.modelId,api_base:modelProtocolBase(model.baseUrl,model.apiFormat),
   api_key:'os.environ/'+credentialVariable(model.credentialRef)},model_info:{mode:responses?'responses':'chat',
   max_input_tokens:model.contextWindow-model.maxOutputTokens,max_output_tokens:model.maxOutputTokens,
   supported_endpoints:[responses?'/v1/responses':'/v1/chat/completions']}});
  profiles[alias]={...profile,scenarios:domains};
  for(const domain of domains)scenarios[domain]={alias,dataPolicyApproved:true,runtimeProfile:{...profile}};
 }
 // Backups are model-level choices; a request never follows a backup's own
 // chain recursively. Grant scenario admission only for an approved direct
 // fallback of that scenario's explicitly selected primary model.
 for(const domain of modelSettingsDomains){
  const binding=value.scenarios[domain];if(!binding)continue;
  const primary=value.models.find(model=>model.id===binding.modelId),backups=[];
  for(const item of primary.fallbacks??[]){
   const alias=modelAlias(item.modelId),profile=profiles[alias];
   if(!item.dataPolicyApproved||!profile)throw fail();
   if(!profile.scenarios.includes(domain))profile.scenarios.push(domain);
   const {scenarios:_unused,...runtimeProfile}=profile;
   backups.push({alias,dataPolicyApproved:true,runtimeProfile});
  }
  if(backups.length)scenarios[domain].fallbacks=backups;
 }
 return {configurationVersion:version,modelCount:selected.length,configuredScenarios:modelSettingsDomains.filter(domain=>scenarios[domain]!==null),
  gateway:{model_list:rows,galaxy_profiles:profiles},agentos:{version,scenarios}};
}
