import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {applyBrowserPolicy} from '../src/adapters/http/browser-policy.mjs';
import {dispatchOperationsFeedback} from '../src/adapters/http/operations-feedback-http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

test('feedback original receipt is credentialed GET through the real CORS and HTTP routes',async()=>{
 const origin='https://agigalaxy.org',id='7491670c-f7e4-4241-9102-a70fa91ed9f2',path='/v1/account/feedback/operations/'+id,calls=[];
 const officialAccounts={async actionActor(request,{write}){assert.equal(write,false);if(request.headers.cookie!=='session=owner')throw new ServiceError('official_account_login_required',401);return{accountId:'owner'};}};
 const operationsFeedback={async submissionOperation(actor,operationId){calls.push({actor,operationId});return{state:'recorded',operationId};}};
 const server=createServer(async(request,response)=>{
  const send=(status,value)=>{response.statusCode=status;response.setHeader('Content-Type','application/json');response.end(JSON.stringify(value));};
  try{if(applyBrowserPolicy(request,response,[origin]))return;if(!await dispatchOperationsFeedback({request,response,url:new URL(request.url,'http://local'),officialAccounts,operationsFeedback,send}))send(404,{});}
  catch(error){send(error.status??500,{error:error.code});}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  const preflight=await fetch(base+path,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'x-galaxy-account-id,x-galaxy-account-csrf'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-credentials'),'true');assert.match(preflight.headers.get('access-control-allow-headers'),/X-Galaxy-Account-ID/);assert.equal(calls.length,0);
  const receipt=await fetch(base+path,{headers:{Origin:origin,Cookie:'session=owner'}});assert.equal(receipt.status,200);assert.equal(receipt.headers.get('access-control-allow-origin'),origin);assert.equal(receipt.headers.get('access-control-allow-credentials'),'true');assert.equal((await receipt.json()).operationId,id);assert.deepEqual(calls,[{actor:{accountId:'owner'},operationId:id}]);
  assert.equal((await fetch(base+path,{headers:{Origin:origin}})).status,401);
  assert.equal((await fetch(base+path,{method:'POST',headers:{Origin:origin,Cookie:'session=owner'}})).status,404);
  assert.equal((await fetch(base+path,{headers:{Origin:'https://other.invalid',Cookie:'session=owner'}})).status,403);
  for(const wrong of ['/v1/account/feedback/operations/not-an-id','/v1/account/feedback/operations/'+id+'/extra']){
   const r=await fetch(base+wrong,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'x-galaxy-account-id'}});assert.equal(r.status,403);
  }
  assert.equal(calls.length,1);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
