import test from 'node:test';
import assert from 'node:assert/strict';
import {operationsProxyPolicy,operationsReadPath} from '../src/lib/proxy-policy.mjs';

test('file transit proxy confines directory and aggregate filters without adding storage or private-content paths',()=>{
 const publicOrigin='https://admin.example.invalid',id='11111111-2222-4333-8444-555555555555',directory='/v1/operations/files',summary=directory+'/summary',detail=directory+'/chat/'+id,retry=detail+'/retry',
  policy=(path,method='GET',headers={'sec-fetch-site':'same-origin'})=>operationsProxyPolicy({url:publicOrigin+path,method,headers:new Headers(headers),publicOrigin});
 for(const path of [directory+'?kind=chat&state=scan-pending&processing=scan&issue=scan&after=chat:'+id+'&limit=25',summary+'?kind=chat&state=expired&processing=cleanup&issue=cleanup',detail]){
  assert.equal(operationsReadPath(path),true,path);assert.equal(policy(path).allowed,true,path);
 }
 for(const path of [directory+'?query=private',directory+'?issue=scan&issue=cleanup',directory+'?limit=1&limit=2',directory+'?view=exceptions',directory+'?trail=old',
  directory+'?state='+'x'.repeat(8193),summary+'?after=chat:'+id,summary+'?limit=25',summary+'?scope=all',summary+'?kind=chat&kind=forum',detail+'?issue=scan',detail+'/content',directory+'/feedback/'+id]){
  assert.equal(operationsReadPath(path),false,path);assert.equal(policy(path).allowed,false,path);
 }
 assert.equal(policy(retry,'POST',{origin:publicOrigin}).allowed,true);
 for(const path of [retry+'?issue=scan',detail+'/erase',summary])assert.equal(policy(path,'POST',{origin:publicOrigin}).allowed,false,path);
 assert.equal(policy(retry,'DELETE',{origin:publicOrigin}).allowed,false);assert.equal(policy(retry,'POST',{'sec-fetch-site':'same-origin'}).allowed,false);
 assert.equal(policy(retry,'POST',{origin:'https://foreign.example.invalid'}).allowed,false);assert.equal(policy(summary,'GET',{'sec-fetch-site':'cross-site'}).allowed,false);
});
