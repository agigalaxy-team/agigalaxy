import test from 'node:test';
import assert from 'node:assert/strict';
import {operationsProxyPolicy,operationsReadPath} from '../src/lib/proxy-policy.mjs';

test('audit proxy forwards only exact metadata filter keys on the two audit reads',()=>{
 const publicOrigin='https://admin.example.invalid',id='11111111-2222-4333-8444-555555555555',account='/v1/operations/users/'+id+'/audit',
  policy=(path,method='GET',headers={'sec-fetch-site':'same-origin'})=>operationsProxyPolicy({url:publicOrigin+path,method,headers:new Headers(headers),publicOrigin}),
  filters='action=community-content-read&kind=reads&day=2026-10-22&query='+id+'&resourceId='+id+'&after=1&limit=30';
 for(const path of ['/v1/operations/audit?'+filters+'&accountId='+id,account+'?'+filters]){
  assert.equal(operationsReadPath(path),true);assert.equal(policy(path).allowed,true);
  assert.equal(policy(path,'GET',{'sec-fetch-site':'cross-site'}).allowed,false);
  assert.equal(policy(path,'GET',{origin:'https://foreign.example.invalid'}).allowed,false);
  assert.equal(policy(path,'POST',{origin:publicOrigin}).allowed,false);
 }
 for(const path of ['/v1/operations/audit',account])for(const suffix of ['state=closed','result=success','query=a&query=b','day=2026-10-22&day=2026-10-23','query='+'a'.repeat(8193)]){
  assert.equal(operationsReadPath(path+'?'+suffix),false);assert.equal(policy(path+'?'+suffix).allowed,false);
 }
 assert.equal(operationsReadPath(account+'?accountId='+id),false);assert.equal(policy(account+'?accountId='+id).allowed,false);
 for(const path of ['/v1/operations/audit/notes','/v1/operations/users/'+id+'/audit/notes'])assert.equal(policy(path).allowed,false);
 assert.equal(operationsReadPath('/v1/operations/users/'+id+'/summary?days=7'),true);
 assert.equal(policy('/v1/operations/users/'+id+'/summary?days=7').allowed,true);
});
