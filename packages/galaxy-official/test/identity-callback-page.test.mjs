import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,get} from 'node:http';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
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
async function returnPage(f,headers={}){
 const redirect=await navigation(f.url,headers);
 assert.equal(redirect.status,303);assert.equal(await redirect.text(),'');
 const location=redirect.headers.get('location');assert.match(location,/^\/v1\/identity\/return\/[0-9a-f-]{36}$/);
 const clean=new URL(location,f.url);assert.equal(clean.origin,new URL(f.url).origin);assert.equal(clean.search,'');
 assert.equal(redirect.headers.get('referrer-policy'),'no-referrer');assert.equal(redirect.headers.get('cache-control'),'no-store');
 return {redirect,clean,response:await navigation(clean)};
}
test('browser callback completes the original association login without reflecting callback data',async t=>{
 const f=await fixture(t,()=>({state:'awaiting-local-signature',galaxyAuthorization:false}));
 const {response}=await returnPage(f,{accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'});
 const html=await response.text();
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/html/);
 assert.match(html,/继续关联账户/);assert.match(html,/在原窗口确认后即可完成/);
 assert.match(html,/class="secondary" href="https:\/\/agigalaxy.org\/app\/account"/);
 assert.match(html,/id="return-to-origin"[^>]*hidden/);assert.match(html,/回到原网页或银河客户端继续/);
 assert.doesNotMatch(html,/do-not-reflect|awaiting-local-signature|<details|<iframe|opencode:\/\/|<strong>线上账户已登录/);
 assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
 assert.equal(response.headers.get('vary'),'Origin, Accept');assert.equal(response.headers.get('x-frame-options'),'DENY');
 const css=/<style>([\s\S]*?)<\/style>/.exec(html)[1];
 assert.match(response.headers.get('content-security-policy'),new RegExp(createHash('sha256').update(css).digest('base64').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 const script=/<script>([\s\S]*?)<\/script>/.exec(html)[1];
 assert.match(response.headers.get('content-security-policy'),new RegExp(createHash('sha256').update(script).digest('base64').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 assert.doesNotMatch(response.headers.get('content-security-policy'),/unsafe-inline|unsafe-eval|https:/);
 assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(f.calls.length,1);assert.equal(f.failures.length,0);
});
test('JSON callback contract and error codes remain available for API clients',async t=>{
 const value={state:'awaiting-local-signature',message:'Return to your Galaxy host to review and sign the account association.',galaxyAuthorization:false};
 const f=await fixture(t,()=>value);
 for(const accept of ['application/json','text/html;q=0,application/json','text/html;q=0.5,application/json;q=1']){
  const response=await fetch(f.url,{headers:{accept}});assert.deepEqual(await response.json(),value);assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(response.headers.get('location'),null);
 }
 const bad=await fixture(t,()=>{throw new ServiceError('identity_login_unavailable',409);});
 const response=await fetch(bad.url,{headers:{accept:'application/json'}});assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'identity_login_unavailable'});
});
test('expired, rejected and unknown callbacks have safe actionable HTML and retain failure auditing',async t=>{
 for(const error of [new ServiceError('identity_login_unavailable',409),new ServiceError('identity_login_failed',401),new Error('private upstream body must not be shown')]){
  const f=await fixture(t,()=>{throw error;});f.url+='&error_description=do-not-reflect-description';const {response,clean}=await returnPage(f);const html=await response.text();
  assert.equal(response.status,error.status??500);assert.match(html,/账户中心/);assert.match(html,/请返回原窗口重试|请稍后重试/);
  assert.doesNotMatch(html,/do-not-reflect|private upstream|identity_login_|本次登录材料已取得/);
  assert.equal(f.failures.length,1);assert.equal(f.failures[0][0],error.status??500);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);
  assert.equal((await navigation(clean)).status,error.status??500);assert.equal(f.calls.length,1,'refreshing the clean return page never consumes the callback again');
 }
});
test('expired and unknown display tickets show an honest 404 and strip appended callback queries',async t=>{
 let clock=Date.now();t.mock.method(Date,'now',()=>clock);
 const f=await fixture(t,()=>({state:'awaiting-local-signature',galaxyAuthorization:false})),{clean}=await returnPage(f);
 clock+=300001;
 const expired=await navigation(clean),html=await expired.text();assert.equal(expired.status,404);
 assert.match(html,/链接已过期/);assert.match(html,/请回到原窗口重新登录/);assert.doesNotMatch(html,/本次登录材料已取得/);
 const extra=new URL(clean);extra.search='code=do-not-reflect-code&state=do-not-reflect-state&error_description=do-not-reflect-description';
 const redirect=await navigation(extra);assert.equal(redirect.status,303);assert.equal(redirect.headers.get('location'),clean.pathname);
 const unknown=await navigation(new URL('/v1/identity/return/10000000-0000-4000-8000-000000000001',f.url));
 assert.equal(unknown.status,404);assert.equal(f.calls.length,1);
});
test('a known opener automatically resumes with only a fixed-origin refresh hint',async t=>{
 const f=await fixture(t,()=>({state:'awaiting-local-signature',galaxyAuthorization:false})),{response}=await returnPage(f),html=await response.text();
 const script=/<script>([\s\S]*?)<\/script>/.exec(html)[1];
 function execute(opener,ready=true){const button={hidden:true,click:null,addEventListener:(name,handler)=>{assert.equal(name,'click');button.click=handler;}},help={textContent:''};let closed=0;
  runInNewContext(script,{window:{opener,close:()=>{closed++;}},document:{body:{dataset:{accountResult:ready?'ready':'failed'}},getElementById:id=>id==='return-to-origin'?button:help}});
  return {button,help,closed:()=>closed};}
 const absent=execute(null);assert.equal(absent.button.hidden,true);assert.equal(absent.button.click,null);
 const alreadyClosed=execute({closed:true});assert.equal(alreadyClosed.button.hidden,true);
 const messages=[];let focused=0;
 const present=execute({closed:false,postMessage:(message,origin)=>messages.push({message:JSON.parse(JSON.stringify(message)),origin}),focus:()=>{focused++;}});
 assert.equal(present.button.hidden,false);
 assert.deepEqual(messages,[{message:{type:'galaxy:identity-account-return'},origin:'https://agigalaxy.org'}]);
 assert.equal(focused,1);assert.equal(present.closed(),1);
 assert.match(present.help.textContent,/原窗口/);
 const failed=execute({closed:false,postMessage:()=>{},focus:()=>{}},false);
 assert.equal(failed.closed(),0,'a failed login stays readable rather than silently closing');

});
test('official account navigation errors are readable without changing the API error contract',async t=>{
 for(const error of [new ServiceError('invalid_account_return',400),new ServiceError('official_account_unavailable',503)]){
  const f=await fixture(t,()=>null,{login:async()=>{throw error;}});
  const url=new URL('/v1/account/login?returnTo=do-not-reflect-private-return',f.url);
  const response=await navigation(url),html=await response.text();
  assert.equal(response.status,error.status);assert.match(response.headers.get('content-type'),/^text\/html/);
  assert.match(html,/银河在线账户/);assert.match(html,/返回账户/);
  assert.doesNotMatch(html,/do-not-reflect|invalid_account_return|official_account_unavailable|<script/);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);assert.equal(f.failures.length,1);
  const json=await fetch(url,{headers:{accept:'application/json'}});
  assert.equal(json.status,error.status);assert.deepEqual(await json.json(),{error:error.code});
 }
});


test('real HTTP URL policy permits the clean return redirect while no OAuth query survives the resulting page',async t=>{
 const {createApi}=await import('../src/http.mjs');
 const server=createApi({bindings:{endpoint:'https://official.example.org'}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const path='/v1/identity/return/00000000-0000-4000-8000-000000000001',base='http://127.0.0.1:'+server.address().port;
 const response=await fetch(base+path+'?code=synthetic-never-retain&state=synthetic-never-retain',{redirect:'manual',headers:{Accept:'text/html'}});
 assert.equal(response.status,303);assert.equal(response.headers.get('location'),path);
 const result=await fetch(base+path,{headers:{Accept:'text/html'}});assert.equal(result.status,404);
 assert.doesNotMatch(await result.text(),/synthetic-never-retain/);
});
