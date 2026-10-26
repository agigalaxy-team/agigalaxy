import test from 'node:test';
import {attachAiWorkFixture} from './fixtures/ai-work.mjs';
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from "../src/infrastructure/database.mjs";
import {createApi} from '../src/http.mjs';
import {createOidcLoginProvider} from "../src/identity/authentication/oidc-login.mjs";
import {createOidcTransactionStore} from "../src/identity/authentication/oidc-transaction-store.mjs";
import {createOperationsPortal} from "../src/operations/permissions/auth.mjs";
import {OperationsPermissionsService} from "../src/operations/permissions/index.mjs";
import {OperationsAgentOsAuthority} from "../src/operations/agentos/authority.mjs";
import {OperationsAgentOsGateway} from "../src/operations/agentos/gateway.mjs";
import {OperationsAgentOsClient} from "../src/operations/agentos/client.mjs";
import {OperationsAgentOsService} from "../src/operations/agentos/service.mjs";
import {loadOperationsAgentOsConfiguration} from '../src/infrastructure/operations-agentos-configuration.mjs';
import {loadDiscoveryConfiguration} from '../src/infrastructure/discovery-configuration.mjs';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';
import {adminOrigin,operatorRoles,request,response,acceptCookies,temporaryDirectory} from './operations-management-fixture.mjs';
import {operationsProxyPolicy,operationsReadPath} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';

const prefix='/v1/operations/agentos';
const syntheticServiceKey='SYNTHETIC_AGENTOS_SERVICE_KEY_NOT_PRODUCTION';
const syntheticSigningKey='SYNTHETIC_AGENTOS_SIGNING_KEY_NOT_PRODUCTION';

// HTTP registration, OIDC/session/CSRF and PG business permissions are real.
// Native AgentOS responses below are an explicit transport double; the actual
// native PostgreSQL/queue/HITL checks have separate Oracle evidence.
async function fixture(t){
 const f=await accountChatFixture(),roles=new Map(),subjects=new Map(),calls=[],runtimeCalls=[],logs=[];
// eslint-disable-next-line prefer-const -- Forward references must stay initialized to undefined when setup fails before assignment.
 let authDb;let issuer;let server;
 t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await issuer?.close();await authDb?.close();await f.close();});
 authDb=new PGlite();await migrate(authDb);
 const callback=adminOrigin+'/v1/operations/callback',wallNow=()=>Math.floor(Date.now()/1000);
 issuer=await oidcProviderFixture([callback],{emailVerified:true,roleClaims:{realm_access:{roles:[operatorRoles.reader]}}});
 const permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization:async actor=>roles.get(actor.operatorId)??null,now:f.now});
 const provider=await createOidcLoginProvider({id:'agentos-central',name:'Synthetic AgentOS operators',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:callback,
  includeOperatorRoles:true,includeAccountProfile:true,allowLoopbackHttp:true,now:wallNow,
  transactionStore:createOidcTransactionStore({db:authDb,namespace:'agentos-central',now:wallNow})});
 const portal=createOperationsPortal({db:authDb,endpoint:f.endpoint,adminOrigin,provider,roles:operatorRoles,permissions,now:wallNow,
  roleDirectory:{getOperatorRoles:async({externalSubject})=>subjects.has(externalSubject)?[operatorRoles[subjects.get(externalSubject)]]:[]}});
 const authority=new OperationsAgentOsAuthority({db:f.db,endpoint:f.endpoint,permissions,now:f.now});
 const control={afterAuthentication:null,runtimeFailure:false,executionId:null,modelSubmissions:0};
 const client=new OperationsAgentOsClient({url:'http://127.0.0.1:3350',signingKey:syntheticSigningKey,serviceKey:syntheticServiceKey,now:f.now,
  fetchImpl:async(url,options={})=>{
   const target=new URL(url);runtimeCalls.push({path:target.pathname,query:target.search,method:options.method??'GET'});
   if(target.pathname==='/health')return Response.json({state:'running',framework:'agno',version:'3.1.7',model:'not-configured',persistence:'native-database',queue:'native-durable',traces:'metadata-only'});
   if(control.runtimeFailure)return Response.json({error:'PRIVATE_RUNTIME_PROSE',credential:'PRIVATE_NATIVE_SECRET',url:'https://private-runtime.example.invalid/'},{status:500});
   if(target.pathname==='/galaxy/runs')return Response.json({items:[],total:0,page:Number(target.searchParams.get('page')??1),nextPage:null,metadataOnly:true});
   if(target.pathname.startsWith('/galaxy/runs/'))return Response.json({run:{runId:target.pathname.split('/').at(-1),executionId:control.executionId,state:'COMPLETED',metadataOnly:true},spans:[],events:[],traceCount:0,input:{state:'withheld',value:null},output:{state:'withheld',value:null},metadataOnly:true});
   if(target.pathname.startsWith('/galaxy/executions/'))return Response.json({executionId:target.pathname.split('/').at(-1),runs:[],traces:[],traceCount:0,modelState:'not-configured',readExpiresAt:f.now()+30});
   control.modelSubmissions++;throw new Error('PRIVATE_UNEXPECTED_NATIVE_SUBMISSION');
  }});
 const service=new OperationsAgentOsService({authority,client}),gateway=new OperationsAgentOsGateway({authority,content:null,serviceKey:syntheticServiceKey});
 server=createApi({bindings:{endpoint:f.endpoint},operationsAgentOs:service,agentOsGateway:gateway,
  operations:{portal:{...portal,authorizeOperator:async(req,options)=>{
   calls.push(options);const actor=await portal.authorizeOperator(req,options);
   if(control.afterAuthentication&&options.action){const effect=control.afterAuthentication;control.afterAuthentication=null;await effect();}
   return actor;
  }}},browserOrigins:[adminOrigin],rateLimit:1000,logger:entry=>logs.push(entry)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 async function login(subject,role){
  subjects.set(subject,role);issuer.setAccount(subject);const jar=new Map(),started=response();
  await portal.login(request(jar),started,new URL(adminOrigin+'/v1/operations/login'));acceptCookies(jar,started);
  const completed=response();await portal.callback(request(jar),completed,await issuer.authorize(started.headers.get('location')));acceptCookies(jar,completed);
  const principal=(await authDb.query('SELECT * FROM operations_operator_principals_v1 WHERE endpoint=$1 AND external_subject=$2',[f.endpoint,subject])).rows[0];assert(principal);
  await f.db.query('INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',
   [principal.operator_id,f.endpoint,principal.issuer,principal.external_subject,principal.display_name,new Date(f.now()*1000)]);
  roles.set(principal.operator_id,role);const session=await portal.session(request(jar,{origin:adminOrigin}));assert.equal(session.state,'signed-in');
  return {jar,session,subject,actor:{kind:'business-operator',operatorId:principal.operator_id,role,endpoint:f.endpoint}};
 }
 function call(path,who,input,extra={}){
  const method=input===undefined?'GET':'POST',headers={...request(who.jar,{origin:adminOrigin,...(input===undefined?{}:{'content-type':'application/json','x-galaxy-operator-csrf':who.session.csrfToken})},method).headers,...extra};
  for(const key of Object.keys(headers))if(headers[key]===null)delete headers[key];
  return fetch(base+path,{method,headers,...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(15000)});
 }
 return {...f,authDb,issuer,roles,permissions,portal,authority,gateway,service,control,calls,runtimeCalls,logs,base,login,call};
}

test('AgentOS registered central HTTP contracts',{timeout:120000},async t=>{
 const f=await fixture(t),admin=await f.login('agentos-central-admin','administrator'),reader=await f.login('agentos-central-reader','reader');
 const businessAdmin=new BusinessAdminService({...f,permissions:f.permissions});
 const {ids}=await attachAiWorkFixture({...f,businessAdmin,authority:f.authority,permissions:f.permissions,admin:admin.actor,domains:['overview'],codes:[],now:f.now});
 const grant=(await f.permissions.saveAutomation(admin.actor,{operationId:randomUUID(),expectedVersion:0,name:'合成HTTP助手',executorKind:'ai',aiAccountId:ids.overview,mode:'assisted',enabled:true,permissions:[],resourceIds:[randomUUID()]},{authorize:async()=>admin.actor})).automation;
 const createBody=()=>({operationId:randomUUID(),grantId:grant.id,expectedGrantVersion:grant.version,domain:'overview',actions:[],resourceIds:[],preparedCommand:null});
 let role;
 async function saveRole(permissions){role=(await f.permissions.saveRole(admin.actor,{operationId:randomUUID(),...(role?{id:role.id}:{}),expectedVersion:role?.version??0,name:'合成HTTP工作台角色',description:'',enabled:true,permissions},{authorize:async()=>admin.actor})).role;return role;}

 await t.test('management HTTP uses current PG actions and CSRF, exact queries and owner binding while reporting an empty model honestly',async()=>{
  assert.equal((await fetch(f.base+prefix+'/status',{headers:{origin:adminOrigin}})).status,401);
  assert.equal((await f.call(prefix+'/status',reader)).status,403);
  await saveRole(['workbench.read']);
  await f.permissions.saveAssignment(admin.actor,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.actor.operatorId,roleId:role.id,enabled:true},{authorize:async()=>admin.actor});
  const status=await f.call(prefix+'/status',reader);assert.equal(status.status,200);
  const value=await status.json();assert.equal(value.state,'connected');assert.equal(value.modelState,'not-configured');
  for(const forbidden of [syntheticSigningKey,syntheticServiceKey,'apiKey','signingKey'])assert.equal(JSON.stringify(value).includes(forbidden),false);
  assert.equal((await f.call(prefix+'/options',reader)).status,200);assert.equal((await f.call(prefix+'/executions',reader)).status,200);
  assert.equal((await f.call(prefix+'/runs',reader)).status,403,'workbench.read cannot read global audit metadata');
  for(const csrf of [null,'SYNTHETIC_WRONG_CSRF'])assert.equal((await f.call(prefix+'/executions',reader,createBody(),{'x-galaxy-operator-csrf':csrf})).status,403);
  assert.equal((await f.call(prefix+'/executions',reader,createBody(),{origin:'https://untrusted.example.invalid'})).status,403);
  assert.equal((await f.call(prefix+'/executions',reader,{...createBody(),role:'administrator'})).status,400);
  await saveRole(['workbench.read','ai.use.overview']);
  const created=await f.call(prefix+'/executions',reader,createBody());assert.equal(created.status,200);const execution=(await created.json()).execution;f.control.executionId=execution.id;
  assert.equal((await f.call(prefix+'/executions/'+execution.id,reader)).status,200);
  assert.equal((await f.call(prefix+'/executions/'+execution.id,admin)).status,404,'owner history is separate from global run metadata');
  const model=await f.call(prefix+'/executions/'+execution.id+'/runs',reader,{operationId:randomUUID(),message:'PRIVATE_WORKBENCH_PROMPT'});
  assert.equal(model.status,503);assert.equal((await model.json()).error,'operations_agentos_model_not_configured');assert.equal(f.control.modelSubmissions,0);
  await saveRole(['workbench.read','ai.use.overview','audit.read']);
  const page=await f.call(prefix+'/runs?page=2&limit=5&domain=governance&state=PAUSED',reader);assert.equal(page.status,200);
  assert.deepEqual((await page.json()).items,[]);assert(f.runtimeCalls.some(row=>row.path==='/galaxy/runs'&&row.query.includes('domain=governance')&&row.query.includes('state=PAUSED')));
  assert.equal((await f.call(prefix+'/runs/native_run-case_1',reader)).status,200,'native run IDs need not be UUIDs');
  for(const path of [prefix+'/runs?page=1&page=2',prefix+'/runs?role=administrator',prefix+'/runs?query=PRIVATE_QUERY',prefix+'/runs?domain=unknown',prefix+'/runs?state=unknown',prefix+'/runs?limit=101',prefix+'/runs?page=100001',prefix+'/status?page=1',prefix+'/executions/'+execution.id+'?operatorId=forged',prefix+'/runs/native_run-case_1?scope=all'])assert.equal((await f.call(path,reader)).status,400,path);
  for(const path of [prefix+'/tools/execute',prefix+'/runs/native.run',prefix+'/executions/not-a-uuid',prefix+'/executions/'+execution.id+'/unknown'])assert.equal((await f.call(path,reader)).status,404,path);
  f.control.runtimeFailure=true;
  const failed=await f.call(prefix+'/runs/native_run-case_1',reader);assert.equal(failed.status,503);assert.equal((await failed.json()).error,'operations_agentos_unavailable');f.control.runtimeFailure=false;
  f.control.afterAuthentication=()=>saveRole([]);
  assert.equal((await f.call(prefix+'/executions/'+execution.id+'/events',reader,{operationId:randomUUID(),expectedRevision:1,kind:'pause'})).status,403);
  assert.equal((await f.db.query('SELECT state FROM operations_agentos_executions_v1 WHERE id=$1',[execution.id])).rows[0].state,'active');
  await saveRole(['workbench.read','ai.use.overview']);
  f.control.afterAuthentication=()=>f.portal.logout(request(reader.jar,{origin:adminOrigin,'x-galaxy-operator-csrf':reader.session.csrfToken},'POST'),response());
  assert.equal((await f.call(prefix+'/executions/'+execution.id+'/events',reader,{operationId:randomUUID(),expectedRevision:1,kind:'pause'})).status,401,'the command callback verifies the current local session');
  assert(f.calls.some(call=>call.write===true&&call.action===undefined),'command reauthorization must not disappear at registration');
 });

 await t.test('private gateway verifies its service key before body parsing and cannot be reached through the browser proxy or free paths',async()=>{
  const execution=(await f.authority.create(admin.actor,createBody(),{authorize:async()=>admin.actor})).execution;
  const path='/v1/internal/agentos/authorize',input={executionId:execution.id,operation:'read',resourceType:null,resourceId:null};
  const raw=(suffix,body,headers={})=>fetch(f.base+suffix,{method:'POST',headers:{'content-type':'application/json',...headers},body,signal:AbortSignal.timeout(15000)});
  for(const authorization of [undefined,'Bearer wrong']){
   const headers=authorization?{authorization}:{};const result=await raw(path,'INVALID_PRIVATE_JSON',headers);
   assert.equal(result.status,403);assert.equal((await result.json()).error,'operations_agentos_service_denied');
  }
  assert.equal((await f.call(path,admin,input)).status,403,'a real management cookie and CSRF cannot become the service credential');
  const invalid=await raw(path,'INVALID_PRIVATE_JSON',{authorization:'Bearer '+syntheticServiceKey});assert.equal(invalid.status,400);assert.equal((await invalid.json()).error,'invalid_json');
  const allowed=await raw(path,JSON.stringify(input),{authorization:'Bearer '+syntheticServiceKey});assert.equal(allowed.status,200);assert.equal((await allowed.json()).execution.id,execution.id);
  const unknown=await raw('/v1/internal/agentos/tools/execute',JSON.stringify({executionId:execution.id,runId:'synthetic-run',callId:'synthetic-call',tool:'shell',arguments:{command:'PRIVATE_SHELL_BODY'}}),{authorization:'Bearer '+syntheticServiceKey});assert.equal(unknown.status,400);
  for(const suffix of [path+'?scope=all',path+'?executionId='+execution.id])assert.equal((await raw(suffix,JSON.stringify(input),{authorization:'Bearer '+syntheticServiceKey})).status,400);
  assert.equal((await fetch(f.base+path,{headers:{authorization:'Bearer '+syntheticServiceKey}})).status,404);
  assert.equal((await raw('/v1/internal/agentos/execute',JSON.stringify(input),{authorization:'Bearer '+syntheticServiceKey})).status,404);
  const proxy=(suffix,method='GET')=>operationsProxyPolicy({url:adminOrigin+suffix,method,headers:new Headers({origin:adminOrigin}),publicOrigin:adminOrigin});
  for(const suffix of [path,'/v1/internal/agentos/tools/execute',prefix+'/tools/execute']){assert.equal(proxy(suffix,'POST').allowed,false);assert.equal(operationsReadPath(suffix),false);}
  assert.equal(proxy(prefix+'/runs?page=1&limit=10&domain=governance&state=PAUSED').allowed,true);
  assert.equal(proxy(prefix+'/runs?page=1&page=2').allowed,false);assert.equal(proxy(prefix+'/runs?query=PRIVATE_QUERY').allowed,false);assert.equal(proxy(prefix+'/status?domain=governance').allowed,false);
  const preflight=await fetch(f.base+prefix+'/executions',{method:'OPTIONS',headers:{origin:adminOrigin,'access-control-request-method':'POST','access-control-request-headers':'content-type,x-galaxy-operator-csrf'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-credentials'),'true');assert.match(preflight.headers.get('access-control-allow-headers'),/X-Galaxy-Operator-CSRF/);
  assert.equal((await fetch(f.base+path,{method:'OPTIONS',headers:{origin:adminOrigin,'access-control-request-method':'POST','access-control-request-headers':'x-galaxy-operator-csrf'}})).status,403);
  for(const forbidden of ['PRIVATE_',syntheticServiceKey,syntheticSigningKey,reader.session.csrfToken,admin.session.csrfToken])assert.equal(JSON.stringify(f.logs).includes(forbidden),false);
  assert.deepEqual(f.issuer.failures,[]);
 });
});

test('protected Agno and discovery configuration readers bind exact deployment metadata and reject unsafe or caller-added configuration',{timeout:30000},async t=>{
 const directory=await temporaryDirectory(t,'galaxy-agentos-config-'),endpoint='https://galaxy.example.invalid',file=join(directory,'runtime.json');
 const native={version:1,endpoint,url:'http://127.0.0.1:3350',signingKey:syntheticSigningKey,serviceKey:syntheticServiceKey};
 const discovery={version:1,endpoint,websiteOrigin:'https://web.example.invalid',visitorSecret:'SYNTHETIC_VISITOR_SECRET_NOT_PRODUCTION',
  meilisearch:{url:'http://127.0.0.1:7700',apiKey:'SYNTHETIC_MEILI_KEY_NOT_PRODUCTION'},gorse:{url:'http://127.0.0.1:8087',apiKey:'SYNTHETIC_GORSE_KEY_NOT_PRODUCTION'},
  openpanel:{url:'http://127.0.0.1:3000',clientId:randomUUID(),clientSecret:'SYNTHETIC_OPENPANEL_WRITE_NOT_PRODUCTION',readClientId:randomUUID(),readClientSecret:'SYNTHETIC_OPENPANEL_READ_NOT_PRODUCTION',projectId:randomUUID()}};
 const write=async value=>{await writeFile(file,JSON.stringify(value),{encoding:'utf8',mode:0o600});};
 const rejects=async(loader,value)=>{await write(value);await assert.rejects(loader(file,{endpoint}),error=>{for(const marker of ['PRIVATE_CONFIG_SENTINEL',syntheticSigningKey,syntheticServiceKey])assert.equal(error.message.includes(marker),false);return true;});};
 assert.deepEqual(await loadOperationsAgentOsConfiguration(null,{endpoint}),{url:null,signingKey:null,serviceKey:null});assert.equal(await loadDiscoveryConfiguration(null,{endpoint}),null);
 await write(native);assert.deepEqual(await loadOperationsAgentOsConfiguration(file,{endpoint}),{url:native.url,signingKey:native.signingKey,serviceKey:native.serviceKey});
 for(const change of [{endpoint:'https://other.example.invalid'},{version:2},{role:'administrator'},{model:'unapproved-default'},{signingKey:'PRIVATE_CONFIG_SENTINEL'},
  {url:'http://192.0.2.4:3350'},{url:'http://PRIVATE_CONFIG_SENTINEL:password@127.0.0.1:3350'},{url:'http://127.0.0.1:3350/native'},{url:'http://127.0.0.1:3350/?key=PRIVATE_CONFIG_SENTINEL'},{url:'http://127.0.0.1:3350/#PRIVATE_CONFIG_SENTINEL'}])await rejects(loadOperationsAgentOsConfiguration,{...native,...change});
 await write(discovery);const loaded=await loadDiscoveryConfiguration(file,{endpoint});assert.equal(loaded.endpoint,endpoint);assert.equal(loaded.meilisearch.url,discovery.meilisearch.url);assert.equal(loaded.openpanel.projectId,discovery.openpanel.projectId);
 for(const change of [{endpoint:'https://other.example.invalid'},{websiteOrigin:'http://web.example.invalid'},{websiteOrigin:'https://web.example.invalid/'},{role:'administrator'},
  {meilisearch:{...discovery.meilisearch,url:'http://192.0.2.4:7700'}},{gorse:{...discovery.gorse,url:'http://127.0.0.1:8087/internal'}},{openpanel:{...discovery.openpanel,url:'http://PRIVATE_CONFIG_SENTINEL:password@127.0.0.1:3000'}}])await rejects(loadDiscoveryConfiguration,{...discovery,...change});
 for(const loader of [loadOperationsAgentOsConfiguration,loadDiscoveryConfiguration]){
  await assert.rejects(loader('relative-runtime.json',{endpoint}));await assert.rejects(loader(directory,{endpoint}));
 }
 await writeFile(file,'x'.repeat(32769),{mode:0o600});await assert.rejects(loadDiscoveryConfiguration(file,{endpoint}));await assert.rejects(loadOperationsAgentOsConfiguration(file,{endpoint}));
});
