import test from 'node:test';
import assert from 'node:assert/strict';
import {operationsProxyPolicy,operationsReadPath} from '../src/lib/proxy-policy.mjs';

test('chat review proxy confines room paging and one-message visibility to exact routes and same-origin methods',()=>{
 const publicOrigin='https://admin.example.invalid',report='11111111-2222-4333-8444-555555555555',message='22222222-3333-4444-8555-666666666666',
  directory='/v1/operations/chat-reports',detail=directory+'/'+report,visibility=detail+'/messages/'+message+'/visibility',
  policy=(path,method='GET',headers={'sec-fetch-site':'same-origin'})=>operationsProxyPolicy({url:publicOrigin+path,method,headers:new Headers(headers),publicOrigin});
 const list=directory+'?roomId='+message+'&state=reviewing&after='+report+'&limit=20';
 assert.equal(operationsReadPath(list),true);assert.equal(policy(list).allowed,true);
 assert.equal(operationsReadPath(detail),true);assert.equal(policy(detail).allowed,true);
 for(const suffix of ['query=private','reportId='+report,'roomId='+message+'&roomId='+report,'limit=1&limit=2','trail=0','view=history','state='+'x'.repeat(8193)]){
  assert.equal(operationsReadPath(directory+'?'+suffix),false);assert.equal(policy(directory+'?'+suffix).allowed,false);
 }
 assert.equal(operationsReadPath(detail+'?roomId='+message),false);assert.equal(policy(detail+'?state=reviewing').allowed,false);
 assert.equal(policy(visibility,'POST',{origin:publicOrigin}).allowed,true);
 for(const path of [visibility+'?roomId='+message,detail+'/messages/'+message+'/delete',detail+'/messages/'+message+'/visibility/history'])
  assert.equal(policy(path,'POST',{origin:publicOrigin}).allowed,false);
 assert.equal(operationsReadPath(visibility),false);assert.equal(policy(visibility).allowed,false);
 assert.equal(policy(visibility,'DELETE',{origin:publicOrigin}).allowed,false);
 assert.equal(policy(visibility,'POST',{'sec-fetch-site':'same-origin'}).allowed,false);
 assert.equal(policy(visibility,'POST',{origin:'https://foreign.example.invalid'}).allowed,false);
 assert.equal(policy(list,'GET',{'sec-fetch-site':'cross-site'}).allowed,false);
 assert.equal(policy(list,'GET',{origin:'https://foreign.example.invalid'}).allowed,false);
});
