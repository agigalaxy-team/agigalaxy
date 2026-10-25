import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApi} from '../src/http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {failureRoute} from '../src/adapters/http/failure-audit.mjs';
import {businessAuditMetadata} from '../src/business-admin-audit-view.mjs';
import {operationsProxyPolicy,operationsReadPath,operationsRequestBodyLimit} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';

// Actual registered Node HTTP, URL, BFF and audit projections. Authorization
// and the domain are explicit local doubles; the separate PG leaf exercises
// actual file gates, permissions, receipts and storage qualification.
test('file access HTTP keeps explicit human commands closed and original result reads side-effect free',{timeout:30000},async t=>{
 const origin='https://admin.example.invalid',endpoint='https://official.example.invalid',id=randomUUID(),operationId=randomUUID(),
  actor={kind:'business-operator',operatorId:'file-access-http-operator',role:'administrator',endpoint},calls=[],authorizations=[],logs=[];
 let allowed=true;
 const authorizeOperator=async(request,options)=>{
  authorizations.push(options);
  if(!allowed)throw new ServiceError('operations_permission_denied',403);
  if(request.headers['x-local-auth']!=='present')throw new ServiceError('operations_login_required',401);
  if(options.write&&request.headers['x-galaxy-operator-csrf']!=='local-file-access-csrf')throw new ServiceError('operations_csrf_invalid',403);
  return actor;
 };
 const service={
  async change(who,kind,target,input,{authorize}){
   assert.equal(who,actor);assert.equal(await authorize(),actor);calls.push({name:'change',kind,target,input});
   return {operationId:input.operationId,kind,id:target,action:input.action,revision:1,stopped:input.action==='stop',until:input.until??null};
  },
  async operation(who,operation){assert.equal(who,actor);calls.push({name:'operation',operation});return{state:'recorded',operationId:operation,kind:'chat',id,action:'stop',revision:1,stopped:true,until:2000000000};},
 };
 const server=createApi({bindings:{endpoint},operations:{portal:{authorizeOperator}},operationsFileAccess:service,browserOrigins:[origin],rateLimit:2000,logger:entry=>logs.push(entry)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port;
 const request=async(path,{method='GET',input,headers={}}={})=>{
  const response=await fetch(base+path,{method,headers:{origin,'x-local-auth':'present','content-type':'application/json','x-galaxy-operator-csrf':'local-file-access-csrf',...headers},
   ...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(10000)});
  return {status:response.status,value:await response.json()};
 };
 const writePath='/v1/operations/files/chat/'+id+'/access',readPath='/v1/operations/files/access/operations/'+operationId,
  stop={operationId,expectedVersion:'current-intrinsic-version',expectedRevision:0,action:'stop',until:2000000000,reason:'PRIVATE_FILE_ACCESS_REASON'},
  policy=(path,method='GET',headers={'sec-fetch-site':'same-origin'})=>operationsProxyPolicy({url:origin+path,method,headers:new Headers(headers),publicOrigin:origin});
 assert.equal(operationsReadPath(readPath),true);assert.equal(operationsReadPath(writePath),false);
 assert.equal(policy(readPath).allowed,true);assert.equal(policy(writePath,'POST',{origin}).allowed,true);assert.equal(policy(writePath,'POST').allowed,false);
 assert.equal((await request(writePath,{method:'POST',input:stop})).status,200);
 assert.deepEqual(calls.at(-1),{name:'change',kind:'chat',target:id,input:stop});
 assert.deepEqual(authorizations.map(item=>[item.write,item.action]),[[true,'files.read'],[true,'files.access.stop'],[true,'files.access.stop']]);
 const restore={operationId:randomUUID(),expectedVersion:stop.expectedVersion,expectedRevision:1,action:'restore',reason:'EXPLICIT_HUMAN_RESTORE_REASON'};
 assert.equal((await request(writePath.replace('/chat/','/forum/'),{method:'POST',input:restore})).status,200);
 assert.equal(calls.at(-1).kind,'forum');assert.equal(authorizations.at(-1).action,'files.access.restore');
 const before=calls.filter(item=>item.name==='change').length;
 for(let n=0;n<2;n++)assert.equal((await request(readPath)).value.operationId,operationId);
 assert.equal(calls.filter(item=>item.name==='change').length,before);
 assert(authorizations.slice(-2).every(item=>!item.write&&item.action==='files.read'));
 const invalid=[{...stop,operatorId:'another-person'},{...stop,storageKey:'not-an-accepted-target'},{...stop,action:'erase'},{...stop,until:undefined},{...restore,until:2000000000}];
 for(const input of invalid)assert.equal((await request(writePath,{method:'POST',input})).status,400);
 for(const path of [readPath+'?execute=true',readPath+'?accountId='+id,writePath+'?until=2000000000']){
  assert.equal(policy(path,path.includes('/operations/')&&path.startsWith('/v1/operations/files/access')?'GET':'POST',{origin}).allowed,false);
  assert.equal((await request(path,{method:path.startsWith('/v1/operations/files/access')?'GET':'POST',...(path.startsWith('/v1/operations/files/access')?{}:{input:stop})})).status,400);
 }
 assert.equal((await request(writePath)).status,404);assert.equal((await request(readPath,{method:'POST',input:stop})).status,404);
 assert.equal((await request(writePath,{method:'POST',input:stop,headers:{origin:'https://foreign.example.invalid'}})).status,403);
 assert.equal((await request(writePath,{method:'POST',input:stop,headers:{'x-local-auth':''}})).status,401);
 assert.equal((await request(writePath,{method:'POST',input:stop,headers:{'x-galaxy-operator-csrf':'wrong'}})).status,403);
 assert.equal((await request(writePath,{method:'POST',input:{padding:'x'.repeat(8192)}})).status,413);
 allowed=false;assert.equal((await request(writePath,{method:'POST',input:stop})).status,403);
 assert.equal(calls.filter(item=>item.name==='change').length,before);
 assert.equal(operationsRequestBodyLimit(writePath),8192);
 assert.equal(failureRoute('POST',writePath),'POST /v1/operations/files/:kind/:id/access');
 assert.equal(failureRoute('GET',readPath),'GET /v1/operations/files/access/operations/:id');
 const metadata=businessAuditMetadata({id:randomUUID(),sequence:1,action:'file-access-stop',operator_id:actor.operatorId,created_at:new Date(),
  selection:{kind:'chat',id,resourceId:id,action:'stop',revision:1,until:2000000000,reason:stop.reason,expectedVersion:stop.expectedVersion},
  result:{operationId,kind:'chat',id,action:'stop',revision:1,stopped:true,until:'2033-05-18T03:33:20.000Z',reason:stop.reason}});
 assert.equal(metadata.selection.id,id);assert.equal(metadata.selection.until,2000000000);assert.equal(metadata.result.stopped,true);
 assert.equal(JSON.stringify(metadata).includes(stop.reason),false);assert.equal(JSON.stringify(metadata).includes(stop.expectedVersion),false);
 assert.equal(JSON.stringify(logs).includes(stop.reason),false);
});
