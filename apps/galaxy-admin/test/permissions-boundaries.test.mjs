import test from 'node:test';
import assert from 'node:assert/strict';
import {operationsProxyPolicy,operationsReadPath} from '../src/lib/proxy-policy.mjs';
import {readOperatorSession} from '../src/lib/operations.mjs';

test('permissions proxy and session projection keep exact paths and current business grants separate from login role',async()=>{
 const origin='https://admin.example.invalid',root='/v1/operations/permissions',id='11111111-2222-4333-8444-555555555555',
  policy=(path,method='GET',headers={'sec-fetch-site':'same-origin'})=>operationsProxyPolicy({url:origin+path,method,headers:new Headers(headers),publicOrigin:origin});
 for(const path of [root+'/catalog',root+'/roles',root+'/roles/'+id,root+'/personnel',root+'/automation',root+'/history?after=1&limit=30&resourceId='+id]){
  assert.equal(operationsReadPath(path),true,path);assert.equal(policy(path).allowed,true,path);
 }
 for(const path of [root+'/effective?operatorId=other',root+'/roles?scope=all',root+'/roles/'+id+'?tab=roles',root+'/personnel?query=private',root+'/automation?run=true',
  root+'/history?resourceId='+id+'&resourceId='+id,root+'/history?limit=1&limit=2',root+'/history?trail=1.2',root+'/history?after='+'1'.repeat(8193),root+'/execute',root+'/roles/'+id+'/grant']){
  assert.equal(operationsReadPath(path),false,path);assert.equal(policy(path).allowed,false,path);
 }
 for(const path of [root+'/roles',root+'/assignments',root+'/automation'])assert.equal(policy(path,'POST',{origin}).allowed,true,path);
 for(const path of [root+'/roles?operatorId=other',root+'/roles/'+id,root+'/history',root+'/execute'])assert.equal(policy(path,'POST',{origin}).allowed,false,path);
 assert.equal(policy(root+'/roles','POST',{'sec-fetch-site':'same-origin'}).allowed,false);
 assert.equal(policy(root+'/roles','POST',{origin:'https://foreign.example.invalid'}).allowed,false);
 assert.equal(policy(root+'/roles','DELETE',{origin}).allowed,false);
 const headers=new Headers({cookie:'galaxy-operator-fixture='+'a'.repeat(43),'x-forwarded-for':'127.0.0.1'}),environment={bffOrigin:'https://bff.example.invalid',publicOrigin:origin,fixtureCookies:true},
  base={state:'signed-in',operator:{id:'verified-reader',displayName:'合成管理人员',role:'reader',businessAuthorization:{version:'42',permissions:['accounts.read','accounts.restriction.apply']}},csrfToken:'synthetic-csrf',expiresAt:Math.floor(Date.now()/1000)+60};
 const session=await readOperatorSession(headers,{environment,fetcher:async()=>Response.json(base)});assert.equal(session.operator.role,'reader');assert.deepEqual(session.operator.businessAuthorization,base.operator.businessAuthorization);
 const legacy=await readOperatorSession(headers,{environment,fetcher:async()=>Response.json({...base,operator:{id:'verified-reader',role:'reader'}})});assert.equal(legacy.operator.businessAuthorization,undefined,'a missing server snapshot must not invent all permissions from a role');
 await assert.rejects(readOperatorSession(headers,{environment,fetcher:async()=>Response.json({...base,operator:{...base.operator,businessAuthorization:{version:'42',permissions:['accounts.read','accounts.read']}}})}),{code:'operator_session_invalid'});
 await assert.rejects(readOperatorSession(headers,{environment,fetcher:async()=>Response.json({...base,operator:{...base.operator,businessAuthorization:{version:'42',permissions:['PRIVATE TOKEN']}}})}),{code:'operator_session_invalid'});
});
