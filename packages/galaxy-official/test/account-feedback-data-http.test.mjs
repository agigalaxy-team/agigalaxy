import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createApi} from '../src/http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {isAccountBinaryPath,isAccountUploadPath} from '../src/shared/account-resource-routes.mjs';

// Actual registered HTTP/request policy and binary allowlist. Only the owner
// domain and login verifier are doubles; dedicated PostgreSQL leaves exercise
// account ownership, closed erasure SQL and the real minimal database roles.
test('owner feedback HTTP binds closed intents and export bytes to the current online account',{timeout:30000},async t=>{
 const endpoint='https://official.example.invalid',origin='https://galaxy.example.invalid',root='/v1/account/data/feedback/',operationId=randomUUID(),fileId=randomUUID();
 const actor={kind:'official-account',accountId:randomUUID(),endpoint},calls=[],auth=[],logs=[],bytes=Buffer.from('local owner export bytes'),sha256=createHash('sha256').update(bytes).digest('hex');
 let session=true;
 const officialAccounts={actionActor:async(request,options)=>{
  auth.push(options);if(!session||request.headers['x-local-session']!=='present')throw new ServiceError('official_account_login_required',401);
  if(options.write&&request.headers['x-galaxy-account-csrf']!=='local-only')throw new ServiceError('official_account_csrf_invalid',403);
  return actor;
 }};
 const accountFeedbackData={};
 for(const name of ['export','delete','operation','exportPage'])accountFeedbackData[name]=async(who,...args)=>{
  assert.equal(who.accountId,actor.accountId);assert.equal(who.endpoint,endpoint);calls.push({name,args});return {state:'recorded',operationId,replayed:false};
 };
 accountFeedbackData.attachmentContent=async(who,operation,attachment,{authorize})=>{
  assert.equal(who.accountId,actor.accountId);assert.equal(operation,operationId);assert.equal(attachment,fileId);
  assert.equal((await authorize()).accountId,actor.accountId);calls.push({name:'attachmentContent'});return {bytes,name:'反馈\r\n导出.txt',sha256};
 };
 const server=createApi({bindings:{endpoint},officialAccounts,accountFeedbackData,browserOrigins:[origin],rateLimit:2000,logger:entry=>logs.push(entry)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port;
 const request=(path,{method='GET',input,headers={}}={})=>fetch(base+path,{method,headers:{origin,'x-local-session':'present','content-type':'application/json','x-galaxy-account-csrf':'local-only',...headers},...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(10000)});
 for(const name of ['export','delete'])assert.equal((await request(root+name,{method:'POST',input:{operationId}})).status,201);
 assert(auth.slice(0,2).every(call=>call.write===true));
 const preflightHeaders={'access-control-request-method':'GET','access-control-request-headers':'content-type,x-galaxy-account-id,x-galaxy-account-csrf'};
 const domainCalls=calls.length,authorizations=auth.length;
 for(const path of [root+'exports/'+operationId+'?after=2&limit=5','/v1/account/archives?limit=20','/v1/account/external-credentials?after=2','/v1/account/notifications/notices?limit=20&unreadOnly=true']){
  const preflight=await request(path,{method:'OPTIONS',headers:preflightHeaders});
  assert.equal(preflight.status,204,path);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
  assert.equal(preflight.headers.get('access-control-allow-credentials'),'true');
  assert.match(preflight.headers.get('access-control-allow-headers'),/X-Galaxy-Account-CSRF/);
 }
 assert.equal(calls.length,domainCalls);assert.equal(auth.length,authorizations);
 for(const suffix of ['?after=2&after=3','?limit=51','?limit=','?accountId='+actor.accountId])
  assert.equal((await request(root+'exports/'+operationId+suffix,{method:'OPTIONS',headers:preflightHeaders})).status,400,suffix);
 assert.equal((await request(root+'exports/'+operationId+'?limit=5',{method:'OPTIONS',headers:{...preflightHeaders,'access-control-request-method':'POST'}})).status,400);
 assert.equal((await request(root+'operations/'+operationId)).status,200);
 assert.equal((await request(root+'exports/'+operationId+'?after=2&limit=5')).status,200);
 assert.deepEqual(calls.at(-1),{name:'exportPage',args:[operationId,{after:'2',limit:5}]});
 const binary=root+'exports/'+operationId+'/attachments/'+fileId+'/content';
 assert.equal(isAccountBinaryPath(binary),true);assert.equal(isAccountUploadPath(binary),false);
 const result=await request(binary,{method:'POST',input:{}});
 assert.equal(result.status,200);assert.deepEqual(Buffer.from(await result.arrayBuffer()),bytes);
 assert.equal(result.headers.get('x-galaxy-content-sha256'),sha256);assert.equal(result.headers.get('cache-control'),'private, no-store');
 assert.equal(result.headers.get('x-content-type-options'),'nosniff');assert.equal(result.headers.get('content-length'),String(bytes.length));
 assert(result.headers.get('content-disposition').includes('%0D%0A'));assert.equal(result.headers.get('content-disposition').includes('\r'),false);
 const before=calls.length;
 for(const path of [root+'exports/'+operationId+'?accountId='+actor.accountId,root+'exports/'+operationId+'?after=1&after=2',root+'exports/'+operationId+'?limit=51',root+'exports/'+operationId+'?limit=',root+'exports/'+operationId+'?after=-1',root+'operations/'+operationId+'?execute=true',binary+'?download=1'])
  assert.equal((await request(path)).status,400,path);
 for(const [path,method,input]of [[root+'export','GET',undefined],[root+'operations/'+operationId,'POST',{}],[binary,'GET',undefined],[root+'exports/'+operationId+'/erase','POST',{}]])
  assert.equal((await request(path,{method,input})).status,404,path);
 assert.equal((await request(root+'delete',{method:'POST',input:{operationId,accountId:actor.accountId}})).status,400);
 assert.equal((await request(root+'export',{method:'POST',input:{operationId},headers:{authorization:'Bearer not-an-online-account'}})).status,401);
 assert.equal((await request(root+'delete',{method:'POST',input:{operationId},headers:{'x-galaxy-account-csrf':''}})).status,403);
 assert.equal((await request(binary,{method:'POST',input:{},headers:{origin:'https://foreign.example.invalid'}})).status,403);
 assert.equal(calls.length,before,'rejected requests never enter the domain');
 session=false;assert.equal((await request(root+'operations/'+operationId)).status,401);assert.equal(calls.length,before);
 assert.equal(JSON.stringify(logs).includes('not-an-online-account'),false);
});
