import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {applyBrowserPolicy} from '../src/adapters/http/browser-policy.mjs';
import {dispatchAccountFeedbackData} from '../src/adapters/http/account-feedback-data-http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

test('current owner-data dispatcher and exact credentialed CORS preserve closed route, method, and account transport',async()=>{
 const website='https://agigalaxy.org',accountId='499160e2-41e7-42fd-9d7a-e926781934c3',operationId='d870128f-2d39-407d-979a-b945c3688ad9',fileId='7b2a9ae1-6318-4c41-bd7a-54e80610b1c7';
 const calls=[],authorizations=[];
 // Authentication/storage are deliberate doubles; this leaf checks the actual
 // HTTP adapter, body parser, and changed browser-policy, without PG or people.
 const officialAccounts={async actionActor(request,{write}){
  authorizations.push({write});
  if(request.headers.cookie!=='website-session=controlled')throw new ServiceError('official_account_login_required',401);
  if(request.headers['x-galaxy-account-id']!==accountId||request.headers['x-galaxy-account-csrf']!=='controlled-csrf')throw new ServiceError('account_csrf_invalid',403);
  return {kind:'official-account',accountId};
 }};
 const result=(kind)=>({replayed:false,operationId,kind,state:'recorded',phase:kind==='export'?'ready':'pending'});
 const accountFeedbackData={
  async export(actor,input){calls.push({kind:'export',actor,input});return result('export');},
  async delete(actor,input){calls.push({kind:'delete',actor,input});return result('delete');},
  async operation(actor,id){calls.push({kind:'operation',actor,id});return {state:'not-recorded',operationId:id};},
  async exportPage(actor,id,query){calls.push({kind:'page',actor,id,query});return {operationId:id,accountId,items:[],nextAfter:null};},
  async attachmentContent(actor,id,attachmentId,{authorize}){await authorize();calls.push({kind:'content',actor,id,attachmentId});return {bytes:Buffer.from('own'),name:'note.txt',sha256:'1'.repeat(64)};}
 };
 const server=createServer(async(request,response)=>{
  const send=(status,value)=>{response.statusCode=status;response.setHeader('Content-Type','application/json');response.end(JSON.stringify(value));};
  try{
   if(applyBrowserPolicy(request,response,[website]))return;
   const consumed=await dispatchAccountFeedbackData({accountFeedbackData,officialAccounts,request,response,requestId:'controlled-request',url:new URL(request.url,'http://localhost'),send});
   if(!consumed)send(404,{error:'not_found'});
  }catch(reason){send(reason.status??500,{error:reason.code??'internal_error'});}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address='http://127.0.0.1:'+server.address().port;
 const call=(route,options={})=>fetch(address+route,{...options,signal:AbortSignal.timeout(5000)});
 const headers={Origin:website,'Content-Type':'application/json',Cookie:'website-session=controlled','X-Galaxy-Account-ID':accountId,'X-Galaxy-Account-CSRF':'controlled-csrf'};
 const prefix='/v1/account/data/feedback/';
 const routes=[
  {path:prefix+'export',method:'POST',body:{operationId},status:201,kind:'export'},
  {path:prefix+'delete',method:'POST',body:{operationId},status:201,kind:'delete'},
  {path:prefix+'operations/'+operationId,method:'GET',status:200,kind:'operation'},
  {path:prefix+'exports/'+operationId+'?limit=50',method:'GET',status:200,kind:'page'},
  {path:prefix+'exports/'+operationId+'/attachments/'+fileId+'/content',method:'POST',body:{},status:200,kind:'content'}
 ];
 try{
  for(const row of routes){
   const previous=calls.length;
   const preflight=await call(row.path,{method:'OPTIONS',headers:{Origin:website,'Access-Control-Request-Method':row.method,'Access-Control-Request-Headers':'content-type,x-galaxy-account-id,x-galaxy-account-csrf'}});
   assert.equal(preflight.status,204,row.path);assert.equal(preflight.headers.get('access-control-allow-origin'),website);
   assert.equal(preflight.headers.get('access-control-allow-credentials'),'true');
   assert.equal(preflight.headers.get('access-control-allow-methods'),'GET, POST');
   assert.equal(preflight.headers.get('access-control-allow-headers'),'Authorization, Content-Type, Accept, X-Galaxy-Account-ID, X-Galaxy-Account-CSRF');
   assert.equal(calls.length,previous,'preflight performs no domain action');
   const response=await call(row.path,{method:row.method,headers,...(row.body?{body:JSON.stringify(row.body)}:{})});
   assert.equal(response.status,row.status,row.path);assert.equal(response.headers.get('access-control-allow-credentials'),'true');
   assert.equal(response.headers.get('access-control-allow-origin'),website);
   if(row.kind==='content'){assert.equal(await response.text(),'own');assert.equal(response.headers.get('cache-control'),'private, no-store');}
   else{const value=await response.json();assert.equal(value.operationId,operationId);}
   assert.equal(calls.at(-1).kind,row.kind);assert.equal(calls.at(-1).actor.accountId,accountId);
  }
  for(const route of [prefix+'export-all',prefix+'exports',prefix+'operations/not-a-uuid','/v1/account/data/other/operations/'+operationId,prefix+'exports/'+operationId+'/unknown']){
   const before=calls.length,response=await call(route,{method:'OPTIONS',headers:{Origin:website,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'x-galaxy-account-id,x-galaxy-account-csrf'}});
   assert.equal(response.status,403,route);assert.equal(response.headers.get('access-control-allow-credentials'),null);assert.equal(calls.length,before);await response.json();
  }
  const rejected=[
   {path:prefix+'export',method:'GET',headers,status:404},
   {path:prefix+'operations/'+operationId,method:'POST',headers,body:{},status:404},
   {path:prefix+'operations/'+operationId+'?other=1',method:'GET',headers,status:404},
   {path:prefix+'exports/'+operationId+'?limit=20&limit=30',method:'GET',headers,status:400},
   {path:prefix+'export',method:'POST',headers,body:{operationId,reason:'not allowed'},status:400},
   {path:prefix+'export',method:'POST',headers:{...headers,Origin:'https://other.example'},body:{operationId},status:403},
   {path:prefix+'export',method:'POST',headers:{...headers,Authorization:'Bearer not-an-account-session'},body:{operationId},status:401},
   {path:prefix+'export',method:'POST',headers:{...headers,Cookie:''},body:{operationId},status:401},
   {path:prefix+'export',method:'POST',headers:{...headers,'X-Galaxy-Account-CSRF':''},body:{operationId},status:403}
  ];
  for(const row of rejected){const before=calls.length,response=await call(row.path,{method:row.method,headers:row.headers,...(row.body?{body:JSON.stringify(row.body)}:{})});assert.equal(response.status,row.status,row.path);await response.json();assert.equal(calls.length,before,'rejected request performs no domain action');}
  const preflight=await call(prefix+'export',{method:'OPTIONS',headers:{Origin:website,'Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'x-galaxy-account-id'}});
  assert.equal(preflight.status,403);await preflight.json();
  assert.equal(calls.length,5);assert.ok(authorizations.some(row=>row.write===false));assert.ok(authorizations.some(row=>row.write===true));
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
