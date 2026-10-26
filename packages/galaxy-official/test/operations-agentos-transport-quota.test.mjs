import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi as currentCreateApi} from '../src/http.mjs';
import {OperationsAgentOsGateway} from "../src/operations/agentos/gateway.mjs";
import {defaultRequestQuotaPolicy} from '../src/adapters/http/request-quotas.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

// Real Node HTTP/quota/router and real timing-safe private-service verifier.
// Only domain execution/identity sources are explicit local doubles. No model,
// database, account or live service is used by this transport regression.
test('verified AgentOS coordination stays bounded without spending public submission quota',{timeout:20000},async()=>{
 const createApi=process.env.GALAXY_QUOTA_BEFORE_URL?(await import(process.env.GALAXY_QUOTA_BEFORE_URL)).createApi:currentCreateApi;
 const policy=structuredClone(defaultRequestQuotaPolicy);policy.windowMs=2000;
 policy.categories.submission={ip:3,subject:3,credential:3};policy.categories.query={ip:4,subject:4,credential:4};
 let now=0,domainAllowed=true,domainReads=0,domainTools=0;
 const key='local-transport-regression-service-key-not-a-live-credential',logs=[];
 const authority={db:{},endpoint:'https://quota.example.invalid',now:()=>Math.floor(now/1000),conversations:{
  async authorizeNative(value){assert.equal(value.conversationId,'01892512-7b93-46f2-9404-e58a2d0b9a7c');domainReads++;if(!domainAllowed)throw new ServiceError('operations_permission_denied',403);return{allowed:true};},
  async executeTool(value){assert.equal(value.conversationId,'01892512-7b93-46f2-9404-e58a2d0b9a7c');domainTools++;if(!domainAllowed)throw new ServiceError('operations_permission_denied',403);return{state:'read',effectExecuted:false};}
 }};
 const gateway=new OperationsAgentOsGateway({authority,serviceKey:key});
 const server=createApi({bindings:{endpoint:authority.endpoint},cases:{},access:{authenticate:async()=>{throw new ServiceError('access_denied',401);}},
  agentOsGateway:gateway,requestQuotaPolicy:policy,quotaNow:()=>now,logger:row=>logs.push(row)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port,input={conversationId:'01892512-7b93-46f2-9404-e58a2d0b9a7c'};
 const request=async(path,{method='POST',token,headers={},value=input}={})=>{
  const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...headers},
   ...(method==='GET'?{}:{body:JSON.stringify(value)}),signal:AbortSignal.timeout(5000)});
  return{status:r.status,body:await r.json(),scope:r.headers.get('x-galaxy-quota-scope'),category:r.headers.get('x-galaxy-quota-category'),dimension:r.headers.get('x-galaxy-quota-dimension'),retry:r.headers.get('retry-after')};
 };
 const auth='/v1/internal/agentos/authorize',tool='/v1/internal/agentos/tools/execute',publicPost=()=>request('/v1/cases',{value:{}});
 try{
  // Reproduce the incident's shared-address failure at a smaller deterministic limit.
  for(let i=0;i<3;i++)assert.equal((await publicPost()).status,401);
  assert.equal((await publicPost()).status,429);
  const separated=await request(auth,{token:key});
  assert.equal(separated.status,200,'a verified internal read must survive an exhausted public submission bucket');
  assert.equal(separated.scope,'verified-agentos');
  assert.equal(domainReads,1);
  // A real credential, not an asserted header/cookie/local address, selects the lane.
  now=2000;
  for(const options of [{},{token:'wrong-service-key'},{headers:{'x-galaxy-service':'agentos',cookie:'__Host-galaxy-operator='+'a'.repeat(43)}}]){
   const denied=await request(auth,options);assert.equal(denied.status,403);assert.equal(denied.scope,null);
  }
  const invalidFull=await request(auth,{token:'still-wrong'});assert.equal(invalidFull.status,429);assert.equal(invalidFull.scope,null);
  assert.equal((await request(auth,{token:key})).status,200);assert.equal(domainReads,2);assert.equal(domainTools,0);
  // A correct key is insufficient for arbitrary methods, paths or query strings.
  now=4000;
  for(const [path,options]of [[auth,{method:'GET'}],[auth+'?unexpected=1',{}],[auth+'/',{}]]){
   const rejected=await request(path,{token:key,...options});assert.ok([400,404].includes(rejected.status));assert.equal(rejected.scope,null);
  }
  assert.equal((await request(auth,{token:key})).status,200);
  // The internal lane has the configured query IP/window bound; it is no exemption.
  now=6000;
  for(let i=0;i<3;i++)assert.equal((await request(auth,{token:key})).status,200);
  assert.equal((await request(tool,{token:key})).status,200);assert.equal(domainTools,1);
  const limited=await request(auth,{token:key});
  assert.equal(limited.status,429);assert.equal(limited.scope,'verified-agentos');assert.equal(limited.category,'query');assert.equal(limited.dimension,'ip');assert.equal(limited.retry,'2');
  // Internal exhaustion must not spend or erase the ordinary business limit.
  for(let i=0;i<3;i++)assert.equal((await publicPost()).status,401);
  assert.equal((await publicPost()).status,429);
  // Fresh business/role denial is still authoritative, and not retried.
  now=8000;domainAllowed=false;const before=domainReads;
  const businessDenied=await request(auth,{token:key});assert.equal(businessDenied.status,403);assert.equal(businessDenied.body.error,'operations_permission_denied');assert.equal(domainReads,before+1);
  assert.equal(domainTools,1);assert.ok(!JSON.stringify(logs).includes(key));
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

