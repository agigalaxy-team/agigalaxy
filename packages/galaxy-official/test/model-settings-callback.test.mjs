import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {clientAddressReader} from '../src/adapters/http/policy.mjs';
import {dispatchOperationsModelSettings} from '../src/adapters/http/operations-model-settings-http.mjs';
import {ModelSettingsNativeClient} from "../src/operations/model-settings/native.mjs";
import {ModelConfigurationRuntime} from '../deploy/maintenance-agent/model-configuration.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

test('model authorization crosses the real trusted-loopback policy and signed HTTP adapter; transport rejection is not a revoked role',async()=>{
 const key='synthetic-internal-control-key-not-a-provider',reader=clientAddressReader(['127.0.0.1']);
 const native=new ModelSettingsNativeClient({key});let mode='allowed',calls=0;
 const server=createServer(async(request,response)=>{
  const send=(status,value)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
  try{
   assert.equal(reader(request),'127.0.0.1');
   if(mode==='bad-proxy')throw new ServiceError('invalid_forwarded_address');
   if(mode==='unavailable')throw new ServiceError('service_unavailable',503);
   const accepted=await dispatchOperationsModelSettings({request,response,url:new URL(request.url,'http://127.0.0.1'),send,modelSettingsNative:native,
    operationsModelSettings:{authorizeNative:async input=>{
     calls++;assert.equal('apiKey'in input,false);
     if(mode==='denied')throw new ServiceError('business_admin_denied',403);
     return{authorized:true,operationId:mode==='wrong-operation'?randomUUID():input.operationId,operatorId:input.operatorId,kind:input.kind};
    }}});
   if(!accepted)send(404,{error:'not_found'});
  }catch(error){send(error.status??500,{error:error.code??'test_callback_failed'});}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const runtime=new ModelConfigurationRuntime({configuration:{authorizationUrl:'http://127.0.0.1:'+server.address().port+'/v1/internal/maintenance/authorize',serviceKey:key,controlDirectory:'/not-used'},control:{}});
 const intent={kind:'models-credential-provision',operationId:randomUUID(),operatorId:randomUUID(),modelRecordId:randomUUID(),apiKey:'synthetic-never-transmitted'};
 try{
  await runtime.authorize(intent);assert.equal(calls,1);
  for(const [value,code]of [['bad-proxy','model_settings_authorization_unavailable'],['unavailable','model_settings_authorization_unavailable'],['denied','model_settings_permission_denied'],['wrong-operation','model_settings_authorization_unavailable']]){
   mode=value;await assert.rejects(runtime.authorize(intent),{code});
  }
  assert.equal(calls,3);assert.equal(intent.apiKey,'synthetic-never-transmitted');
 }finally{server.close();server.closeAllConnections();await once(server,'close');}
});
