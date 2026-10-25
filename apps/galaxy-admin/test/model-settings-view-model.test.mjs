import test from 'node:test';
import assert from 'node:assert/strict';
import {modelSettingsLocation,modelSettingsHref,modelSettingsPath,modelSettingsEmpty,modelSettingsNewModel,modelSettingsSafeConfiguration,modelSettingsValidation,modelSettingsMerge,modelSettingsCredential,modelSettingsEffective,modelSettingsOperationLabel,modelSettingsHistoryLines} from '../src/lib/model-settings-view-model.ts';

const id='f4a43fd1-4eb3-486f-966d-642b06c008cc',versionId='2a6f0bd2-a81c-496d-9156-bf18982ed344',operationId='65ed7357-e6de-425b-9e3a-1a15850a229f';
function configured(){const value=modelSettingsEmpty();value.models=[{...modelSettingsNewModel(id),displayName:'人工配置连接',modelId:'provider-real-model',baseUrl:'https://provider.example/v1',credentialRef:'model-key:'+operationId,contextWindow:128000,maxOutputTokens:4096,timeoutSeconds:60,enabled:true}];return value;}
test('model settings keeps selection and history context while API paths retain only exact read parameters',()=>{
 const location=modelSettingsLocation({tab:'scenarios',id,days:'30',historyAfter:'9223372036854775807',historyTrail:'["","4"]',apiKey:'private',accountId:id});
 const href=modelSettingsHref(location,{tab:'usage'}),url=new URL(href,'https://admin.example');
 assert.equal(url.searchParams.get('id'),id);assert.equal(url.searchParams.get('days'),'30');assert.equal(url.searchParams.has('apiKey'),false);
 assert.equal(modelSettingsPath('overview',location),'/v1/operations/model-settings/overview');assert.equal(modelSettingsPath('usage',location),'/v1/operations/model-settings/usage?days=30');
 assert.equal(modelSettingsPath('history',location),'/v1/operations/model-settings/history?limit=20&after=9223372036854775807');assert.equal(modelSettingsPath('operation',location,'not-an-id'),null);
 assert.deepEqual(modelSettingsLocation({tab:'bad',days:'14',id:'null',historyAfter:'9223372036854775808',historyTrail:'["secret"]'}),{tab:'models',days:7,id:'',historyAfter:'',historyTrail:[]});
});
test('model settings builds a closed configuration without write-only keys, temperature or inferred capability settings',()=>{
 const configuration=configured();configuration.models[0].apiKey='must-not-leave-input';configuration.models[0].temperature=.3;configuration.models[0].providerSecret='private';configuration.models[0].reasoning.extra='private';configuration.scenarios.overview={modelId:id,dataPolicyApproved:false,extra:'private'};
 const value=modelSettingsSafeConfiguration(configuration),json=JSON.stringify(value);
 assert.equal(/must-not-leave-input|temperature|providerSecret|extra/.test(json),false);assert.equal(value.models[0].toolCalling,false);assert.equal(value.models[0].structuredOutput,false);assert.equal(value.models[0].reasoning.mode,'default');assert.equal(value.models[0].reasoning.supportSource,'manual');
 assert.deepEqual(value.scenarios.overview,{modelId:id,dataPolicyApproved:false});assert.equal(modelSettingsNewModel(id).contextWindow,null);assert.equal(modelSettingsNewModel(id).enabled,false);
});
test('model settings distinguishes incomplete draft from applicable settings and validates supported thinking formats',()=>{
 const configuration=modelSettingsEmpty();configuration.models=[{...modelSettingsNewModel(id),displayName:'待配置连接'}];assert.deepEqual(modelSettingsValidation(configuration),[]);
 configuration.models[0].enabled=true;assert.match(modelSettingsValidation(configuration,{applying:true}).join(' '),/补齐|API Key/);
 const ready=configured();ready.scenarios.governance={modelId:id,dataPolicyApproved:false};assert.match(modelSettingsValidation(ready,{applying:true}).join(' '),/确认该服务/);ready.scenarios.governance.dataPolicyApproved=true;assert.deepEqual(modelSettingsValidation(ready,{applying:true}),[]);
 ready.models[0].reasoning={mode:'effort',effort:'high',supportedEfforts:['low'],supportSource:'manual'};assert.match(modelSettingsValidation(ready).join(' '),/实际支持/);
 ready.models[0].reasoning={mode:'effort',effort:'xhigh',supportedEfforts:['xhigh'],supportSource:'manual'};ready.models[0].apiFormat='gemini';assert.match(modelSettingsValidation(ready).join(' '),/Gemini/);
 ready.models[0].apiFormat='openai-responses';ready.models[0].reasoning.mode='default';ready.models[0].reasoning.effort=null;ready.models[0].maxOutputTokens=8;assert.match(modelSettingsValidation(ready).join(' '),/至少为 16/);ready.models[0].maxOutputTokens=ready.models[0].contextWindow;assert.match(modelSettingsValidation(ready).join(' '),/小于上下文/);
 ready.models[0].baseUrl='https://name:private@example.invalid/v1';assert.match(modelSettingsValidation(ready).join(' '),/接口地址/);
});
test('model settings merges disjoint admin edits and requires an explicit choice for real field conflicts',()=>{
 const base=configured(),mine=structuredClone(base),current=structuredClone(base);mine.models[0].displayName='我的名称';current.models[0].timeoutSeconds=120;current.scenarios.discovery={modelId:id,dataPolicyApproved:true};
 let result=modelSettingsMerge(base,mine,current);assert.equal(result.conflicts.length,0);assert.equal(result.configuration.models[0].displayName,'我的名称');assert.equal(result.configuration.models[0].timeoutSeconds,120);assert.deepEqual(result.configuration.scenarios.discovery,current.scenarios.discovery);
 current.models[0].displayName='其他管理者名称';result=modelSettingsMerge(base,mine,current);assert.equal(result.conflicts.length,1);assert.equal(result.configuration.models[0].displayName,'其他管理者名称');
 result=modelSettingsMerge(base,mine,current,{['models.'+id+'.displayName']:'mine'});assert.equal(result.configuration.models[0].displayName,'我的名称');assert.equal(result.configuration.models[0].timeoutSeconds,120);
 const removed=structuredClone(current);removed.models=[];removed.scenarios.discovery=null;assert.equal(modelSettingsMerge(base,mine,removed).conflicts.length,1);assert.equal(modelSettingsMerge(base,base,removed).configuration.models.length,0);
});
test('model settings reads matching native versions and credential versions without treating drafts or metadata as model connectivity',()=>{
 const configuration=configured(),native={availability:{state:'available'},configurationVersion:'real-config-2',appliedVersionId:versionId,engines:{gateway:{state:'configured',configurationVersion:'real-config-2',modelCount:1},agentos:{state:'configured',configurationVersion:'real-config-2',configuredScenarios:[]}},credentials:[{reference:'model-key:'+operationId,modelRecordId:id,configured:true}]};
 const value={active:{id:versionId,version:2,configuration},native};assert.equal(modelSettingsCredential(configuration.models[0],native),'configured');assert.equal(modelSettingsCredential({...configuration.models[0],credentialRef:'model-key:'+versionId},native),'missing');assert.equal(modelSettingsCredential(configuration.models[0],null),'unknown');
 assert.equal(modelSettingsEffective(value),'applied');assert.equal(modelSettingsEffective({...value,native:{...native,engines:{...native.engines,gateway:{...native.engines.gateway,configurationVersion:'old'}}}}),'drift');assert.equal(modelSettingsEffective({...value,native:{...native,engines:{...native.engines,gateway:{...native.engines.gateway,modelCount:null}}}}),'unknown');assert.equal(modelSettingsEffective({active:null,native:{...native,appliedVersionId:null}}),'not-configured');
 assert.equal(modelSettingsOperationLabel({kind:'draft',phase:'applied'}),'草稿已保存');assert.equal(modelSettingsOperationLabel({kind:'apply',phase:'applied'}),'配置已生效');assert.equal(modelSettingsOperationLabel({kind:'credential-provision',phase:'applied'}),'凭据已配置');
 const lines=modelSettingsHistoryLines({changes:{models:[{id,kind:'changed',fields:[{field:'apiKey',after:'private'},{field:'enabled',after:true}]}],scenarios:[]}});assert.deepEqual(lines,['修改模型：启用状态']);assert.equal(lines.join(' ').includes('private'),false);
});
