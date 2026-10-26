import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from '../src/http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {operationsProxyPolicy,operationsReadPath} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';

test('domain-specific AI grant options use a closed authenticated GET through HTTP and BFF',async t=>{
 const origin='https://admin.example.invalid',path='/v1/operations/agentos/options',calls=[];
 const actor={kind:'business-operator',operatorId:'synthetic-manager',endpoint:'https://api.example.invalid'};
 let denied=false;
 const operationsAgentOs={authority:{async options(who,input){assert.equal(who,actor);calls.push(input);return {items:[],checkedAt:1,readExpiresAt:31};}}};
 const server=createApi({bindings:{endpoint:actor.endpoint},browserOrigins:[origin],rateLimit:80,operationsAgentOs,operations:{portal:{authorizeOperator:async(request,options)=>{
  assert.equal(options.action,'workbench.read');assert.equal(options.write,false);if(denied)throw new ServiceError('operations_permission_denied',403);return actor;
 }}}});
 t.after(()=>new Promise(resolve=>server.close(resolve)));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port,headers={origin};
 for(const domain of ['overview','governance','messaging','discovery','maintenance']){
  const url=path+'?domain='+domain;
  assert.equal(operationsReadPath(url),true);assert.equal(operationsProxyPolicy({url:origin+url,method:'GET',headers:new Headers(headers),publicOrigin:origin}).allowed,true);
  const response=await fetch(base+url,{headers});assert.equal(response.status,200);await response.json();assert.deepEqual(calls.at(-1),{domain});
 }
 let response=await fetch(base+path,{headers});assert.equal(response.status,200);await response.json();assert.deepEqual(calls.at(-1),{});
 for(const suffix of ['?domain=other','?domain=','?domain=overview&domain=governance','?grantId=someone','?domain=overview&mode=automatic']){
  assert.equal(operationsReadPath(path+suffix),false);response=await fetch(base+path+suffix,{headers});assert([400,404].includes(response.status));await response.text();
 }
 for(const method of ['POST','PUT','DELETE']){
  assert.equal(operationsProxyPolicy({url:origin+path,method,headers:new Headers(headers),publicOrigin:origin}).allowed,false);
  response=await fetch(base+path,{method,headers});assert.equal(response.status,404);await response.text();
 }
 denied=true;response=await fetch(base+path+'?domain=governance',{headers});assert.equal(response.status,403);await response.text();
 assert.equal(calls.length,6);
});
