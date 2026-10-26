import {readFile,lstat} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {createHash,timingSafeEqual} from 'node:crypto';
import {ModelConfigurationRuntime,readModelConfigurationControl} from './model-configuration.mjs';
import {compileModelConfiguration,credentialVariable} from './model-configuration-codec.mjs';
import {modelSettingsDomains} from '../../src/shared/operations-model-settings-schema.mjs';
import {noSymlinkPath} from '../operations-stack/host.mjs';

const fail=()=>Object.assign(Error('maintenance_current_model_binding_unconfirmed'),{code:'maintenance_current_model_binding_unconfirmed'});
const sha=value=>createHash('sha256').update(value).digest();
export function modelAuthorityCaptureSql(endpoint){
 if(new URL(endpoint).origin!==endpoint||!endpoint.startsWith('https://'))throw fail();const origin="'"+endpoint.replaceAll("'","''")+"'";
 return `SELECT jsonb_build_object('endpoint',${origin},'pending',(SELECT count(*) FROM operations_model_settings_operations_v1 WHERE endpoint=${origin} AND phase IN ('prepared','submitting','pending','result-unknown')),'tables',jsonb_build_object('operations_model_settings_state_v1',jsonb_build_object('rows',(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) FROM operations_model_settings_state_v1 s WHERE endpoint=${origin})),'operations_model_settings_versions_v1',jsonb_build_object('rows',(SELECT coalesce(jsonb_agg(to_jsonb(v)),'[]'::jsonb) FROM operations_model_settings_versions_v1 v JOIN operations_model_settings_state_v1 s ON s.active_id=v.id AND s.endpoint=v.endpoint WHERE s.endpoint=${origin}))));`;
}
export function currentModelAuthority(facts){
 const state=facts.tables.operations_model_settings_state_v1.rows.find(x=>x.endpoint===facts.endpoint),version=state?.active_id?facts.tables.operations_model_settings_versions_v1.rows.find(x=>x.id===state.active_id&&x.endpoint===facts.endpoint):null;
 if(state?.active_id&&!version)throw fail();return{activeId:version?.id??null,configuration:version?.configuration??null};
}
async function privateFile(file,{groupReadable=false}={}){
 await noSymlinkPath(file);const info=await lstat(file);
 if(!info.isFile()||info.isSymbolicLink()||(info.mode&(groupReadable?0o027:0o077))||info.size>1024*1024)throw fail();return readFile(file,'utf8');
}
function environment(raw){const values={};for(const line of raw.split(/\r?\n/)){if(!line||line.startsWith('#'))continue;const m=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);if(!m||Object.hasOwn(values,m[1])||/[\p{Cc}]/u.test(m[2]))throw fail();values[m[1]]=m[2];}return values;}

// Bind current non-secret PG model versions/references to current protected
// files and native readback. This does not call a provider, apply config, create
// a key, accept an arbitrary model or silently treat an enabled draft as active.
export async function verifyCurrentModelConfiguration({facts,configuration,root='/etc/galaxy/model-settings',runtime=null,fetchImpl=fetch}){
 try{
  runtime??=new ModelConfigurationRuntime({configuration,control:await readModelConfigurationControl(),root,fetchImpl});
  const state=facts.tables.operations_model_settings_state_v1.rows.find(x=>x.endpoint===facts.endpoint),version=state?.active_id?facts.tables.operations_model_settings_versions_v1.rows.find(x=>x.id===state.active_id&&x.endpoint===facts.endpoint):null;
  if(state?.active_id&&!version)throw fail();
  const status=await runtime.overview();
  if(status.engines?.gateway?.state!=='running'||status.engines?.agentos?.state!=='running'||status.appliedVersionId!==(version?.id??null))throw fail();
  const expected=version?compileModelConfiguration(version.configuration,version.id,status.credentials):{
   configurationVersion:'unconfigured-v1',modelCount:0,configuredScenarios:[],gateway:{model_list:[],galaxy_profiles:{}},agentos:{version:'unconfigured-v1',scenarios:Object.fromEntries(modelSettingsDomains.map(domain=>[domain,null]))}};
  if(status.configurationVersion!==expected.configurationVersion||!runtime.matches(status.engines,expected))throw fail();
  const gateway=JSON.parse(await privateFile(root+'/models.yaml',{groupReadable:true})),agentos=JSON.parse(await privateFile(root+'/bindings.json',{groupReadable:true}));
  if(!isDeepStrictEqual(gateway,expected.gateway)||!isDeepStrictEqual(agentos,expected.agentos))throw fail();
  if(!isDeepStrictEqual(environment(await privateFile(root+'/active.env')),{'GALAXY_MODEL_GATEWAY_CONFIG_VERSION':expected.configurationVersion}))throw fail();
  const provider=environment(await privateFile(root+'/provider.env')),needed=[];
  for(const model of(version?.configuration.models??[]).filter(x=>x.enabled)){
   const key=await runtime.key(model.credentialRef),variable=credentialVariable(model.credentialRef);
   if(key.modelRecordId!==model.id||typeof provider[variable]!=='string'||!timingSafeEqual(sha(key.apiKey),sha(provider[variable])))throw fail();needed.push(variable);
  }
  if(!isDeepStrictEqual(Object.keys(provider).sort(),[...new Set(needed)].sort()))throw fail();
  return{state:'verified',versionId:version?.id??null,configurationVersion:expected.configurationVersion,credentialReferences:new Set(needed).size,configuredScenarios:expected.configuredScenarios};
 }catch{throw fail();}
}
