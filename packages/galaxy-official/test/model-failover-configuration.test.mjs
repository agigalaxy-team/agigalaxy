import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertModelSettingsApplicable,modelSettingsConfigurationSchema} from '../src/shared/operations-model-settings-schema.mjs';
import {compileModelConfiguration,modelAlias} from '../deploy/maintenance-agent/model-configuration-codec.mjs';
const row=id=>({id,displayName:'模型',modelId:'provider-model',apiFormat:'openai-chat',baseUrl:'https://models.example.invalid/v1',credentialRef:'model-key:'+randomUUID(),contextWindow:8192,maxOutputTokens:512,timeoutSeconds:60,reasoning:{mode:'default',effort:null,supportedEfforts:[],supportSource:'manual'},toolCalling:true,structuredOutput:true,enabled:true});
function fixture(){const a=row(randomUUID()),b=row(randomUUID());return{models:[a,b],scenarios:{overview:{modelId:a.id,dataPolicyApproved:true},governance:null,messaging:null,discovery:null,maintenance:null}};}
test('old model configuration remains byte-shape compatible; explicit backups compile only into approved scene admission',()=>{
 const config=fixture(),before=structuredClone(config);assert.deepEqual(modelSettingsConfigurationSchema.parse(config),before);
 config.models[0].imageUnderstanding=true;config.models[1].imageUnderstanding=true;
 config.models[0].fallbacks=[{modelId:config.models[1].id,dataPolicyApproved:true}];
 const credentials=config.models.map(model=>({reference:model.credentialRef,modelRecordId:model.id,configured:true}));
 const compiled=compileModelConfiguration(config,randomUUID(),credentials);
 assert.equal(compiled.agentos.scenarios.overview.alias,modelAlias(config.models[0].id));
 assert.equal(compiled.agentos.scenarios.overview.fallbacks[0].alias,modelAlias(config.models[1].id));
 assert.deepEqual(compiled.gateway.galaxy_profiles[modelAlias(config.models[1].id)].scenarios,['overview']);
 assert.equal(compiled.agentos.scenarios.governance,null);assert.equal(config.models[0].credentialRef,before.models[0].credentialRef);
});
test('unapproved, unavailable, incompatible, duplicate and self fallback targets fail closed',()=>{
 const value=fixture(),a=value.models[0],b=value.models[1];a.fallbacks=[{modelId:b.id,dataPolicyApproved:false}];
 assert.throws(()=>assertModelSettingsApplicable(value),{code:'model_settings_fallback_data_policy_unapproved'});
 a.fallbacks[0].dataPolicyApproved=true;b.enabled=false;assert.throws(()=>assertModelSettingsApplicable(value),{code:'model_settings_fallback_unavailable'});
 b.enabled=true;a.imageUnderstanding=true;assert.throws(()=>assertModelSettingsApplicable(value),{code:'model_settings_fallback_capability_incompatible'});
 b.imageUnderstanding=true;a.fallbacks.push(a.fallbacks[0]);assert.equal(modelSettingsConfigurationSchema.safeParse(value).success,false);
 a.fallbacks=[{modelId:a.id,dataPolicyApproved:true}];assert.equal(modelSettingsConfigurationSchema.safeParse(value).success,false);
});
