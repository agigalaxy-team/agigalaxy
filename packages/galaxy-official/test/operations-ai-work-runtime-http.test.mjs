import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createApi} from '../src/http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {operationsProxyPolicy} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';

const endpoint='https://ai-runtime.synthetic.invalid',root='/v1/operations/ai-work-accounts',domains=['overview','governance','messaging','discovery','maintenance'];
async function fixture(t){
 const actor={kind:'business-operator',operatorId:'runtime-http-reader',role:'reader',endpoint},calls=[],authorizations=[];
 let permitted=true;
 // The engine transport is explicit. This test exercises createApi's real
 // canonical URL policy, route dispatch and current human read authorization.
 const server=createApi({bindings:{endpoint},aiWorkAccounts:{async runtimeStatus(current,domain){assert.equal(current,actor);calls.push(domain);return{domain,runtime:{state:'connected',modelState:domain==='overview'?'configured':'not-configured'}};}},
  operations:{portal:{async authorizeOperator(_request,options){authorizations.push(options);if(!permitted)throw new ServiceError('operations_permission_denied',403);return actor;}}}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 return{calls,authorizations,revoke(){permitted=false;},async send(path,method='GET'){const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method});return{status:response.status,value:await response.json()};}};
}

test('real HTTP AI account runtime reads dispatch all five exact domains through the existing read permission',async t=>{
 const f=await fixture(t);
 for(const domain of domains){const response=await f.send(root+'/'+domain+'/runtime');assert.equal(response.status,200);assert.equal(response.value.domain,domain);assert.equal(response.value.runtime.state,'connected');}
 assert.deepEqual(f.calls,domains);assert.ok(f.authorizations.every(options=>options.write===false&&options.action==='ai.accounts.read'));
 f.revoke();const denied=await f.send(root+'/overview/runtime');assert.equal(denied.status,403);assert.equal(denied.value.error,'operations_permission_denied');assert.equal(f.calls.length,5,'a denied reader never reaches runtime metadata');
});

test('real runtime HTTP and BFF routes reject query injection, unknown domains and writes',async t=>{
 const f=await fixture(t),target=root+'/overview/runtime';
 for(const path of [target+'?after=1',target+'?url=https://other.invalid',root+'/unknown/runtime',target+'/extra'])assert.ok((await f.send(path)).status>=400,path);
 assert.equal((await f.send(target,'POST')).status,404);assert.equal(f.calls.length,0);assert.equal(f.authorizations.length,0);
 const publicOrigin='https://admin.example.invalid',policy=(path,method='GET')=>operationsProxyPolicy({url:publicOrigin+path,method,headers:new Headers({origin:publicOrigin}),publicOrigin});
 assert.equal(policy(target).allowed,true);assert.equal(policy(target,'POST').allowed,false);assert.equal(policy(target+'?after=1').allowed,false);assert.equal(policy(root+'/unknown/runtime').allowed,false);
});
