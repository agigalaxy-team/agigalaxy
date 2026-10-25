import test from 'node:test';
import assert from 'node:assert/strict';
import {operationsProxyPolicy,operationsReadPath} from '../src/lib/proxy-policy.mjs';

test('public-content proxy keeps exact read and manual-write paths separate from other operations',()=>{
 const publicOrigin='https://admin.example.invalid',id='11111111-1111-4111-8111-111111111111',
  policy=(path,method='GET',headers={'sec-fetch-site':'same-origin'})=>operationsProxyPolicy({url:publicOrigin+path,method,headers:new Headers(headers),publicOrigin});
 for(const path of ['/v1/operations/community/content?kind=reply&days=7','/v1/operations/community/content/post/'+id+'?historyAfter=1','/v1/operations/community/tags']){
  assert.equal(operationsReadPath(path),true);assert.equal(policy(path).allowed,true);assert.equal(policy(path,'GET',{'sec-fetch-site':'cross-site'}).allowed,false);
 }
 for(const path of ['/v1/operations/community/content/post/'+id+'/visibility','/v1/operations/community/content/reply/'+id+'/curation',
  '/v1/operations/community/content/visibility/preview','/v1/operations/community/content/visibility/batch','/v1/operations/community/tags','/v1/operations/community/tags/'+id,
  '/v1/operations/community/content/post/'+id+'/attachments/'+id+'/content']){
  assert.equal(policy(path,'POST',{origin:publicOrigin}).allowed,true);assert.equal(policy(path,'POST',{'sec-fetch-site':'same-origin'}).allowed,false);
  assert.equal(policy(path,'POST',{origin:'https://foreign.example.invalid'}).allowed,false);
 }
 for(const path of ['/v1/operations/community/content/post/'+id+'/body','/v1/operations/community/content/accounts/'+id+'/visibility','/v1/operations/community/content/curation/batch',
  '/v1/operations/community/tags/'+id+'/ai','/v1/operations/community/content/post/'+id+'/visibility/reply'])assert.equal(policy(path,'POST',{origin:publicOrigin}).allowed,false);
});
