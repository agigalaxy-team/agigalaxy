import test from 'node:test';
import assert from 'node:assert/strict';
import {operationsProxyPolicy,operationsReadPath} from '../src/lib/proxy-policy.mjs';

test('new summary reads retain the same-origin GET-only business proxy boundary',()=>{
 const publicOrigin='https://admin.example.invalid',accountId='11111111-1111-4111-8111-111111111111';
 for(const path of ['/v1/operations/users/summary?days=7','/v1/operations/users/'+accountId+'/summary?days=28']){
  assert.equal(operationsReadPath(path),true);
  assert.equal(operationsProxyPolicy({url:publicOrigin+path,method:'GET',headers:new Headers({'sec-fetch-site':'same-origin'}),publicOrigin}).allowed,true);
  assert.equal(operationsProxyPolicy({url:publicOrigin+path,method:'GET',headers:new Headers({'sec-fetch-site':'cross-site'}),publicOrigin}).allowed,false);
  assert.equal(operationsProxyPolicy({url:publicOrigin+path,method:'POST',headers:new Headers({origin:publicOrigin}),publicOrigin}).allowed,false);
 }
 assert.equal(operationsReadPath('/v1/operations/users/summary/private'),false);
 assert.equal(operationsReadPath('/v1/operations/users/'+accountId+'/summary/private'),false);
});
