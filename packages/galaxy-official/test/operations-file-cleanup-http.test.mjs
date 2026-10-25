import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApi} from '../src/http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {operationsProxyPolicy,operationsReadPath,operationsRequestBodyLimit} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';

// Real registered HTTP and BFF policies. The domain adapter and management
// authorizer are explicit local doubles: SQL authority/storage are exercised
// separately by operations-file-cleanup.test.mjs, not claimed by this leaf.
test('file cleanup HTTP/BFF confines concrete plan commands and keeps receipt reads free of execution',{timeout:30000},async t=>{
 const origin='https://admin.example.invalid',endpoint='https://official.example.invalid',root='/v1/operations/files/cleanup',id=randomUUID(),operationId=randomUUID(),
  actor={kind:'business-operator',operatorId:'local-http-operator',role:'administrator'},calls=[],authorizations=[],logs=[];
 let permitted=true;
 const authorizeOperator=async(request,options)=>{
  authorizations.push(options);
  if(!permitted)throw new ServiceError('operations_permission_denied',403);
  if(request.headers['x-local-auth']!=='present')throw new ServiceError('operations_login_required',401);
  if(options.write&&request.headers['x-galaxy-operator-csrf']!=='local-cleanup-csrf')throw new ServiceError('operations_csrf_invalid',403);
  return actor;
 };
 const service={};
 for(const name of ['candidates','plans','plan','operation'])service[name]=async(who,value)=>{
  assert.equal(who,actor);calls.push({name,value});return name==='operation'?{operationId:value,state:'recorded',result:{id,state:'queued'}}:{items:[],id,state:'awaiting-approval'};
 };
 for(const name of ['create','approve','cancel'])service[name]=async(who,...args)=>{
  assert.equal(who,actor);const options=args.pop();assert.equal(typeof options.authorize,'function');await options.authorize();calls.push({name,args});
  return {id,state:name==='approve'?'queued':name==='cancel'?'cancelled':'awaiting-approval'};
 };
 const server=createApi({bindings:{endpoint},operations:{portal:{authorizeOperator}},operationsFileCleanup:service,browserOrigins:[origin],rateLimit:2000,logger:entry=>logs.push(entry)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port;
 const request=async(path,{method='GET',input,headers={}}={})=>{
  const response=await fetch(base+path,{method,headers:{origin,'x-local-auth':'present','content-type':'application/json','x-galaxy-operator-csrf':'local-cleanup-csrf',...headers},
   ...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(10000)});
  return {status:response.status,value:await response.json()};
 };
 const policy=(path,method='GET',headers={'sec-fetch-site':'same-origin'})=>operationsProxyPolicy({url:origin+path,method,headers:new Headers(headers),publicOrigin:origin});
 const reads=[root+'/candidates?kind=chat&after=chat:'+id+'&limit=25',root+'/plans?after='+id+'&limit=25',root+'/plans/'+id,root+'/operations/'+operationId];
 for(const path of reads){assert.equal(operationsReadPath(path),true,path);assert.equal(policy(path).allowed,true,path);assert.equal((await request(path)).status,200,path);}
 assert.deepEqual(calls.map(call=>call.name),['candidates','plans','plan','operation']);
 assert.deepEqual(calls[0].value,{kind:'chat',after:'chat:'+id,limit:25});
 assert(authorizations.every(call=>!call.write&&call.action==='files.read'));
 const command={operationId,items:[{kind:'chat',id,expectedVersion:'current-only'}],reason:'LOCAL_PRIVATE_REASON'};
 for(const [path,input,action,name]of [[root+'/plans',command,'files.cleanup.plan','create'],[root+'/plans/'+id+'/approve',{operationId,expectedRevision:1},'files.cleanup.approve','approve'],[root+'/plans/'+id+'/cancel',{operationId,expectedRevision:2},'files.cleanup.plan','cancel']]){
  assert.equal(policy(path,'POST',{origin}).allowed,true);assert.equal(policy(path,'POST').allowed,false);
  const before=authorizations.length,result=await request(path,{method:'POST',input});assert.equal(result.status,200,path);
  assert.equal(calls.at(-1).name,name);assert.equal(authorizations.length,before+2,'the original authorizer is passed to the domain operation');
  assert(authorizations.slice(before).every(call=>call.write&&call.action===action));
  const count=calls.length;assert.equal((await request(path,{method:'POST',input,headers:{'x-galaxy-operator-csrf':'wrong'}})).status,403);assert.equal(calls.length,count);
 }
 const writes=calls.filter(call=>['create','approve','cancel'].includes(call.name)).length;
 for(let index=0;index<3;index++)assert.equal((await request(root+'/operations/'+operationId)).value.state,'recorded');
 assert.equal(calls.filter(call=>['create','approve','cancel'].includes(call.name)).length,writes,'original receipt GET never calls a write or worker');
 const invalidReads=[root+'/candidates?query=private',root+'/candidates?kind=chat&kind=forum',root+'/plans?limit=1&limit=2',root+'/plans/'+id+'?limit=1',root+'/operations/'+operationId+'?execute=true',root+'/plans?after='+'x'.repeat(4097)];
 const before=calls.length;
 for(const path of invalidReads){assert.equal(operationsReadPath(path),false,path);assert.equal(policy(path).allowed,false,path);assert.equal((await request(path)).status,400,path);}
 for(const path of [root+'/execute',root+'/plans/'+id+'/execute',root+'/plans/'+id+'/items/'+id+'/erase']){assert.equal(policy(path,'POST',{origin}).allowed,false);assert.equal((await request(path,{method:'POST',input:{}})).status,404);}
 assert.equal((await request(root+'/plans/'+id+'/approve',{method:'GET'})).status,404);
 assert.equal((await request(root+'/plans',{method:'DELETE'})).status,404);
 assert.equal((await request(root+'/plans?limit=1',{method:'POST',input:command})).status,400);
 assert.equal((await request(root+'/plans',{method:'POST',input:command,headers:{origin:'https://foreign.example.invalid'}})).status,403);
 assert.equal((await request(root+'/plans',{headers:{'x-local-auth':''}})).status,401);
 assert.equal((await request(root+'/plans',{method:'POST',input:{padding:'x'.repeat(262144)}})).status,413);
 assert.equal((await request(root+'/plans/'+id+'/approve',{method:'POST',input:{padding:'x'.repeat(2048)}})).status,413);
 assert.equal(calls.length,before);
 permitted=false;assert.equal((await request(root+'/plans/'+id+'/approve',{method:'POST',input:{operationId,expectedRevision:1}})).status,403);assert.equal(calls.length,before);
 assert.equal(operationsRequestBodyLimit(root+'/plans'),262144);assert.equal(operationsRequestBodyLimit(root+'/plans/'+id+'/approve'),2048);
 assert.equal(JSON.stringify(logs).includes('LOCAL_PRIVATE_REASON'),false);
});
