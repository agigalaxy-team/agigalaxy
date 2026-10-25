import test from 'node:test';
import assert from 'node:assert/strict';
import {operationsReadPath,operationsProxyPolicy,operationsRequestBodyLimit} from '../src/lib/proxy-policy.mjs';

test('registered user BFF keeps exact routes, query keys, methods and same-origin writes',()=>{
  const origin='https://admin.example.invalid',id='11111111-1111-4111-8111-111111111111',root='/v1/operations/registered-users';
  const policy=(path,method='GET',extra={})=>operationsProxyPolicy({url:origin+path,method,publicOrigin:origin,headers:new Headers({'sec-fetch-site':'same-origin',...(method==='POST'?{origin}:{}),...extra})});
  assert.equal(operationsReadPath(root+'?page=2&pageSize=50&business=not-formed&login=enabled'),true);
  assert.equal(operationsReadPath(root+'?page=1&page=2'),false);
  assert.equal(operationsReadPath(root+'?scope=all'),false);
  assert.equal(operationsReadPath(root+'/'+id),true);
  assert.equal(operationsReadPath(root+'/'+id+'/history?after=1&limit=20'),true);
  assert.equal(operationsReadPath(root+'/operations/'+id),true);
  assert.equal(operationsReadPath(root+'/'+id+'/commands'),false);
  assert.equal(policy(root).allowed,true);
  assert.equal(policy(root+'/'+id+'/commands','POST').allowed,true);
  assert.equal(policy(root+'/'+id+'/commands','POST',{origin:'https://other.example.invalid'}).status,403);
  assert.equal(policy(root+'/'+id+'/commands?force=true','POST').status,404);
  assert.equal(policy(root+'/'+id+'/commands').status,404);
  assert.equal(policy(root+'/'+id,'DELETE').status,404);
  assert.equal(policy(root+'/operations/'+id+'?force=true').status,404);
  assert.equal(policy(root+'/'+id+'/history?after=1&unexpected=2').status,404);
  assert.equal(operationsRequestBodyLimit(root+'/'+id+'/commands'),8192);
});
