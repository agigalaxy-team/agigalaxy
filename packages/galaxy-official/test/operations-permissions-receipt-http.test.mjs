import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApi} from '../src/http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {operationsProxyPolicy,operationsReadPath} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';

// Actual HTTP URL policy, registered dispatcher and admin BFF policy. Current
// identity and permission persistence are tested by the dedicated PG leaf;
// this fixture makes only those two service contracts explicit doubles.
test('permission receipts remain read-only and person history crosses the exact registered API and BFF routes',async t=>{
  const origin='https://admin.example.invalid',root='/v1/operations/permissions',id=randomUUID(),person='synthetic-operator';
  const calls=[],actor={kind:'business-operator',operatorId:person,role:'reader',endpoint:'https://api.example.invalid'};let denied=false;
  const server=createApi({bindings:{endpoint:actor.endpoint},browserOrigins:[origin],rateLimit:100,
    operations:{portal:{authorizeOperator:async(request,options)=>{calls.push({kind:'authorize',...options});assert.equal(options.action,'permissions.read');assert.equal(options.write,false);if(denied)throw new ServiceError('operations_permission_denied',403);return actor;}}},
    operationsPermissions:{operation:async(who,operationId)=>{assert.equal(who,actor);assert.equal(operationId,id);calls.push({kind:'operation'});return {state:'not-recorded',operationId};},history:async(who,selection)=>{assert.equal(who,actor);calls.push({kind:'history',selection});return {items:[],nextAfter:null};}}});
  t.after(()=>new Promise(resolve=>server.close(resolve)));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port,headers={origin};
  const receipt=root+'/operations/'+id,history=root+'/history?'+new URLSearchParams({targetOperatorId:person,resourceId:id,after:'1',limit:'2'});
  for(const path of [receipt,history]){
    assert.equal(operationsReadPath(path),true);assert.equal(operationsProxyPolicy({url:origin+path,method:'GET',headers:new Headers(headers),publicOrigin:origin}).allowed,true);
    const response=await fetch(base+path,{headers});assert.equal(response.status,200);await response.json();
  }
  assert.deepEqual(calls.find(item=>item.kind==='history').selection,{targetOperatorId:person,resourceId:id,after:'1',limit:2});
  for(const path of [receipt+'?scope=all',receipt+'?targetOperatorId='+person,root+'/operations/not-an-id',history+'&targetOperatorId=other',history+'&operatorId=forged']){
    assert.equal(operationsReadPath(path),false,path);assert.equal(operationsProxyPolicy({url:origin+path,method:'GET',headers:new Headers(headers),publicOrigin:origin}).allowed,false,path);
    const response=await fetch(base+path,{headers});assert([400,404].includes(response.status),path);await response.text();
  }
  const before=calls.length;
  for(const method of ['POST','PUT','DELETE']){
    assert.equal(operationsProxyPolicy({url:origin+receipt,method,headers:new Headers(headers),publicOrigin:origin}).allowed,false);
    const response=await fetch(base+receipt,{method,headers});assert.equal(response.status,404);await response.text();
  }
  assert.equal(calls.length,before,'unknown receipt methods never reach authorization or service');
  denied=true;const response=await fetch(base+receipt,{headers});assert.equal(response.status,403);assert.equal((await response.json()).error,'operations_permission_denied');
});
