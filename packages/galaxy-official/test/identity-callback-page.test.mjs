import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,get} from 'node:http';
import {createHash} from 'node:crypto';
import {createRoutes} from '../src/adapters/http/routes.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

async function navigation(url,headers={}){
 const result=await new Promise((resolve,reject)=>{get(url,{headers:{accept:'text/html','sec-fetch-mode':'navigate',...headers}},resolve).on('error',reject);});
 const chunks=[];for await(const chunk of result)chunks.push(chunk);
 return new Response(Buffer.concat(chunks),{status:result.statusCode,headers:result.headers});
}

async function fixture(t,callback,officialAccounts){
 const failures=[],calls=[];
 const dispatch=createRoutes({officialAccounts,identity:{callback:async(...args)=>{calls.push(args);return callback(...args);}}});
 const server=createServer(async(request,response)=>{
  response.setHeader('Content-Type','application/json; charset=utf-8');response.setHeader('Vary','Origin');
  const send=(status,payload)=>{response.statusCode=status;response.end(JSON.stringify(payload));};
  try{await dispatch({request,response,url:new URL(request.url,'http://127.0.0.1'),send,recordFailure:async(...args)=>{failures.push(args);}});}
  catch(error){send(error.status??500,{error:error.code??'internal_error'});}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/v1/identity/callback/galaxy-account?code=do-not-reflect-code&state=do-not-reflect-state`;
 return {url,calls,failures};
}
test('browser callback completes the original association login without reflecting callback data',async t=>{
 const f=await fixture(t,()=>({state:'awaiting-local-signature',galaxyAuthorization:false}));
 const response=await navigation(f.url,{accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'});
 const html=await response.text();
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/html/);
 assert.match(html,/账户登录已完成/);assert.match(html,/回原页面继续关联/);assert.match(html,/https:\/\/agigalaxy.org\/app\/account/);
 assert.doesNotMatch(html,/do-not-reflect|awaiting-local-signature|<script|<details|<iframe/);
 assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
 assert.equal(response.headers.get('vary'),'Origin, Accept');assert.equal(response.headers.get('x-frame-options'),'DENY');
 const css=/<style>([\s\S]*?)<\/style>/.exec(html)[1];
 assert.match(response.headers.get('content-security-policy'),new RegExp(createHash('sha256').update(css).digest('base64').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(f.calls.length,1);assert.equal(f.failures.length,0);
});
test('JSON callback contract and error codes remain available for API clients',async t=>{
 const value={state:'awaiting-local-signature',message:'Return to your Galaxy host to review and sign the account association.',galaxyAuthorization:false};
 const f=await fixture(t,()=>value);
 for(const accept of ['application/json','text/html;q=0,application/json','text/html;q=0.5,application/json;q=1']){
  const response=await fetch(f.url,{headers:{accept}});assert.deepEqual(await response.json(),value);assert.equal(response.headers.get('referrer-policy'),'no-referrer');
 }
 const bad=await fixture(t,()=>{throw new ServiceError('identity_login_unavailable',409);});
 const response=await fetch(bad.url,{headers:{accept:'application/json'}});assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'identity_login_unavailable'});
});
test('expired, rejected and unknown callbacks have safe actionable HTML and retain failure auditing',async t=>{
 for(const error of [new ServiceError('identity_login_unavailable',409),new ServiceError('identity_login_failed',401),new Error('private upstream body must not be shown')]){
  const f=await fixture(t,()=>{throw error;});const response=await navigation(f.url);const html=await response.text();
  assert.equal(response.status,error.status??500);assert.match(html,/前往账户中心/);assert.doesNotMatch(html,/do-not-reflect|private upstream|identity_login_|账户登录已完成/);
  assert.equal(f.failures.length,1);assert.equal(f.failures[0][0],error.status??500);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);
 }
});
test('official account navigation errors are readable without changing the API error contract',async t=>{
 for(const error of [new ServiceError('invalid_account_return',400),new ServiceError('official_account_unavailable',503)]){
  const f=await fixture(t,()=>null,{login:async()=>{throw error;}});
  const url=new URL('/v1/account/login?returnTo=do-not-reflect-private-return',f.url);
  const response=await navigation(url),html=await response.text();
  assert.equal(response.status,error.status);assert.match(response.headers.get('content-type'),/^text\/html/);
  assert.match(html,/银河在线账户/);assert.match(html,/前往账户中心/);
  assert.doesNotMatch(html,/do-not-reflect|invalid_account_return|official_account_unavailable|<script/);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);assert.equal(f.failures.length,1);
  const json=await fetch(url,{headers:{accept:'application/json'}});
  assert.equal(json.status,error.status);assert.deepEqual(await json.json(),{error:error.code});
 }
});
