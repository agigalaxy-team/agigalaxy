import test from 'node:test';
import assert from 'node:assert/strict';
import {modelSettingsModelSchema,modelSettingsConfigurationSchema,modelSettingsNativeCommandSchema,emptyModelSettingsConfiguration,assertModelSettingsApplicable} from '../src/shared/operations-model-settings-schema.mjs';

test('model settings reject native-incompatible base URLs and model identifiers before apply',()=>{
 const row={id:'00000000-0000-4000-8000-000000000001',displayName:'Local contract only',modelId:'actual/model-id:1',apiFormat:'openai-chat',baseUrl:'https://provider.invalid/v1',credentialRef:'model-key:00000000-0000-4000-8000-000000000002',contextWindow:8192,maxOutputTokens:512,timeoutSeconds:60,reasoning:{mode:'default',effort:null,supportedEfforts:[],supportSource:'manual'},toolCalling:true,structuredOutput:false,enabled:true};
 const configuration=value=>({...emptyModelSettingsConfiguration(),models:[value]});
 for(const baseUrl of ['https://provider.invalid/v1','http://127.0.0.1:9000/v1','http://localhost:9000/v1','http://[::1]:9000/v1']){
  assert.equal(modelSettingsModelSchema.safeParse({...row,baseUrl}).success,true,baseUrl);
  assert.equal(assertModelSettingsApplicable(configuration({...row,baseUrl})).models[0].baseUrl,baseUrl);
 }
 for(const baseUrl of ['http://provider.invalid/v1','http://10.0.0.1/v1','http://127.1/v1','http://127.000.0.1/v1','http://localhost./v1','http://[::ffff:127.0.0.1]/v1','https:provider.invalid/v1','https://user:password@provider.invalid/v1','https://provider.invalid/v1?q=1','https://provider.invalid/v1#part','https://pro\nvider.invalid/v1']){
  const value=configuration({...row,baseUrl});
  assert.equal(modelSettingsConfigurationSchema.safeParse(value).success,false,baseUrl);
  assert.throws(()=>assertModelSettingsApplicable(value),{code:'invalid_model_settings_request'});
  assert.equal(modelSettingsNativeCommandSchema.safeParse({kind:'models-apply',operationId:'00000000-0000-4000-8000-000000000003',operatorId:'contract-human',versionId:'00000000-0000-4000-8000-000000000004',revision:1,configuration:value}).success,false,baseUrl);
 }
 for(const modelId of [' model','model ','model name','model\tname','model\nname','model\u0000name','model\u007fname','model\u0085name','model\u00a0name','model\u2028name'])
  assert.equal(modelSettingsModelSchema.safeParse({...row,modelId}).success,false,JSON.stringify(modelId));
 assert.equal(modelSettingsModelSchema.safeParse({...row,modelId:null,baseUrl:null}).success,true,'Incomplete draft remains possible');
 assert.deepEqual(assertModelSettingsApplicable(emptyModelSettingsConfiguration()),emptyModelSettingsConfiguration());
});
