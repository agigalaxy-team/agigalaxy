import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {dispatchExternalCredentials} from '../src/adapters/http/external-credentials-http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

test('private credential routes use the current account actor, CSRF and no-store without a Galaxy identity',async()=>{
  const endpoint='https://official.example.org',id='10000000-0000-4000-8000-000000000001',calls=[];
  const officialAccounts={actionActor:async(request,{write})=>{calls.push(['actor',write]);if(request.headers['x-galaxy-account-id']!=='account-a')throw new ServiceError('official_account_changed',409);
    if(write&&request.headers['x-galaxy-account-csrf']!=='fixture-csrf')throw new ServiceError('account_csrf_invalid',403);return{kind:'official-account',accountId:'account-a',endpoint};}};
  const service={list:async actor=>{assert.equal(actor.kind,'official-account');return{available:false,issuers:[],items:[],nextAfter:null};},
    withdraw:async(actor,credentialId)=>{assert.equal(credentialId,id);return{id:credentialId,withdrawn:true,issuerRevoked:false};}};
  async function dispatch(method,path,headers={}){const request=Readable.from([]);request.method=method;request.headers={'x-galaxy-account-id':'account-a',...headers};
    const responseHeaders={},response={setHeader:(name,value)=>{responseHeaders[name]=value;}};let sent;
    const handled=await dispatchExternalCredentials({externalCredentials:service,officialAccounts,request,response,url:new URL(path,endpoint),send:(status,data)=>{sent={status,data};}});
    return {handled,sent,headers:responseHeaders};}
  const result=await dispatch('GET','/v1/account/external-credentials');assert.equal(result.sent.status,200);assert.equal(result.sent.data.available,false);
  assert.equal(result.headers['Cache-Control'],'no-store');assert.equal(result.headers['Referrer-Policy'],'no-referrer');
  await assert.rejects(dispatch('DELETE','/v1/account/external-credentials/'+id),{code:'account_csrf_invalid'});
  await assert.rejects(dispatch('GET','/v1/account/external-credentials',{'x-galaxy-account-id':'stale-account'}),{code:'official_account_changed'});
  const withdrawn=await dispatch('DELETE','/v1/account/external-credentials/'+id,{'x-galaxy-account-csrf':'fixture-csrf'});
  assert.equal(withdrawn.sent.data.withdrawn,true);assert.equal(withdrawn.sent.data.issuerRevoked,false);
  assert.ok(calls.some(([kind,write])=>kind==='actor'&&write===true));
});
