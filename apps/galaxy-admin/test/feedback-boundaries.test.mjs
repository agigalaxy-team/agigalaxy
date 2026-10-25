import test from 'node:test';
import assert from 'node:assert/strict';
import {operationsProxyPolicy,operationsReadPath} from '../src/lib/proxy-policy.mjs';

test('feedback proxy permits only same-origin list/detail reads and exact event POSTs',()=>{
 const publicOrigin='https://admin.example.invalid',id='11111111-1111-4111-8111-111111111111',
  policy=(path,method='GET',headers={'sec-fetch-site':'same-origin'})=>operationsProxyPolicy({url:publicOrigin+path,method,headers:new Headers(headers),publicOrigin});
 for(const path of ['/v1/operations/feedback?days=7','/v1/operations/feedback/'+id+'?historyAfter=1']){
  assert.equal(operationsReadPath(path),true);assert.equal(policy(path).allowed,true);assert.equal(policy(path,'GET',{'sec-fetch-site':'cross-site'}).allowed,false);
  assert.equal(policy(path,'POST',{origin:publicOrigin}).allowed,false);
 }
 const event='/v1/operations/feedback/'+id+'/events';assert.equal(operationsReadPath(event),false);
 assert.equal(policy(event,'POST',{origin:publicOrigin}).allowed,true);assert.equal(policy(event,'POST',{'sec-fetch-site':'same-origin'}).allowed,false);
 assert.equal(policy(event,'POST',{origin:'https://foreign.example.invalid'}).allowed,false);
 for(const path of [event+'/reply','/v1/operations/feedback/batch','/v1/operations/feedback/'+id+'/assign','/v1/account/feedback'])assert.equal(policy(path,'POST',{origin:publicOrigin}).allowed,false);
});
