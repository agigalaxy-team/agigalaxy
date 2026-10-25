import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApi} from '../src/http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {operationsProxyPolicy,operationsReadPath} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';

// Actual URL policy, registered dispatchers and BFF allowlist. Service ledger
// projections/current PG authority have their own real SQL leaf; these are
// explicit contracts, with no external identity, provider or native effects.
test('four settings original-receipt routes are exact authenticated GETs across the actual HTTP and BFF policies',async t=>{
  const origin='https://admin.example.invalid',id=randomUUID(),actor={kind:'business-operator',operatorId:'synthetic-manager',endpoint:'https://api.example.invalid'},calls=[];
  const routes=[['smtp','operationsSmtp','smtp.read','operations'],['messaging','operationsMessaging','notices.read','operations'],['recommendation','operationsRecommendation','recommendations.read','operations'],['maintenance','operationsMaintenance','maintenance.read','command-results']];
  let denied=false,state='recorded';const services={};
  for(const[module,service]of routes)services[service]={commandResult:async(who,operationId)=>{assert.equal(who,actor);assert.equal(operationId,id);calls.push({module});return {state,operationId,kind:state==='recorded'?'synthetic-kind':null,result:state==='recorded'?{version:1}:null,metadataOnly:true,checkedAt:1,readExpiresAt:31};}};
  const server=createApi({bindings:{endpoint:actor.endpoint},browserOrigins:[origin],rateLimit:200,...services,operations:{portal:{authorizeOperator:async(request,options)=>{
    assert.equal(options.write,false);const row=routes.find(item=>request.url.startsWith('/v1/operations/'+item[0]+'/'));assert(row);assert.equal(options.action,row[2]);if(denied)throw new ServiceError('operations_permission_denied',403);return actor;
  }}}});
  t.after(()=>new Promise(resolve=>server.close(resolve)));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port,headers={origin};
  for(const[module,,action,part]of routes){
    const path='/v1/operations/'+module+'/'+part+'/'+id;
    assert.equal(operationsReadPath(path),true,path);assert.equal(operationsProxyPolicy({url:origin+path,method:'GET',headers:new Headers(headers),publicOrigin:origin}).allowed,true,path);
    state='recorded';let response=await fetch(base+path,{headers});assert.equal(response.status,200,action);assert.equal((await response.json()).metadataOnly,true);
    state='not-recorded';response=await fetch(base+path,{headers});assert.equal(response.status,200);assert.equal((await response.json()).state,'not-recorded');
    for(const invalid of [path+'?after=1',path+'?operatorId=someone',path+'/extra',path.replace(id,'not-a-uuid')]){
      assert.equal(operationsReadPath(invalid),false,invalid);assert.equal(operationsProxyPolicy({url:origin+invalid,method:'GET',headers:new Headers(headers),publicOrigin:origin}).allowed,false,invalid);
      response=await fetch(base+invalid,{headers});assert([400,404].includes(response.status),invalid);await response.text();
    }
    const before=calls.length;
    for(const method of ['POST','PUT','DELETE']){assert.equal(operationsProxyPolicy({url:origin+path,method,headers:new Headers(headers),publicOrigin:origin}).allowed,false);response=await fetch(base+path,{method,headers});assert.equal(response.status,404);await response.text();}
    assert.equal(calls.length,before);
    denied=true;response=await fetch(base+path,{headers});assert.equal(response.status,403);assert.equal((await response.json()).error,'operations_permission_denied');denied=false;
  }
  assert.equal(calls.length,8,'only the eight authorized original-result reads reach their services');
});
