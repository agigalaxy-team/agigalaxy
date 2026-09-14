// CUR-35: selected deployed endpoint only. Creates one synthetic device identity,
// performs authorized read-only queries, then revokes its transient binding.
// No real account, public task, message, recipient or email is created.
import {writeFile,readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createWebRuntime} from '../src/runtime.mjs';

const output=process.argv[2];
if(!output||!output.startsWith('C:/'))throw Error('Explicit project report path required');
const report={observedAt:new Date().toISOString(),scope:'synthetic device protocol against selected deployed API; not browser or real account acceptance',checks:{}};
const memory=new Map();let runtime,stage='public-configuration',bindingId;
const diagnostics=new Set(['fetch failed']);
for(const base of [new URL('../../galaxy-official/src/verification/',import.meta.url)]){
 for(const name of await readdir(base))if(name.endsWith('.mjs')){
  const code=await readFile(new URL(name,base),'utf8');
  for(const match of code.matchAll(/new Error\('([^'\r\n]+)'\)/g))diagnostics.add(match[1]);
 }
}
for(const file of ['../../galaxy-official/src/browser-client.mjs','../src/runtime.mjs']){
 for(const match of (await readFile(new URL(file,import.meta.url),'utf8')).matchAll(/new Error\('([^'\r\n]+)'\)/g))diagnostics.add(match[1]);
}
try{
 const response=await fetch('https://agigalaxy.org/galaxy-web-config.json',{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('public_configuration_unavailable');
 const config=await response.json();
 if(config.version!==1||config.endpoint!=='https://official.agigalaxy.org'||!config.signingKeys?.length)throw Error('selected_authority_differs');
 const fetcher=async(url,options)=>{
  if(new URL(url).origin!==config.endpoint)throw Error('selected_origin_differs');
  const r=await fetch(url,{...options,signal:AbortSignal.timeout(15000),headers:{...options.headers,Origin:'https://agigalaxy.org'}});
  report.lastResponse={path:new URL(url).pathname,status:r.status};
  if(new URL(url).pathname==='/v1/bindings'&&r.ok){const bound=await r.clone().json();report.issuedBindingId=bound.bindingId;
   const diagnostic=JSON.parse(Buffer.from(bound.receipt.split('.')[1],'base64url').toString());
   report.signedTimingDiagnostic={unverified:true,iat:diagnostic.iat,nbf:diagnostic.nbf,exp:diagnostic.exp,localNow:Date.now()/1000};}
  if(r.headers.get('access-control-allow-origin')!=='https://agigalaxy.org')throw Error('web_origin_not_allowed');
  return r;
 };
 runtime=await createWebRuntime({endpoint:config.endpoint,trustedKeys:new Map(config.signingKeys.map(k=>[k.kid,k]))},
  {store:{get:async key=>structuredClone(memory.get(key)),put:async(key,value)=>memory.set(key,structuredClone(value))},fetch:fetcher});
 stage='synthetic-identity';await runtime.createIdentity({confirmed:true});
 const status=await runtime.status();report.syntheticSubjectId=status.identity.subjectId;
 stage='binding-and-session';await runtime.connect({confirmed:true});bindingId=runtime.api.snapshot().bindingId;
 report.checks.currentDeviceSignatureAndSession=true;
 const absentObject=randomUUID();
 const queries=[['/v1/identity/providers',{}],['/v1/bindings/query',{}],['/v2/chat/rooms/query',{}],
  ['/v2/context/query',{taskId:absentObject}],['/v2/contributions/sources',{kind:'task-event',parentId:absentObject}],['/v1/data-exports/specification',{}],
  ['/v2/search/query',{type:'task',query:{view:'open',query:'galaxy-deployment-probe-'+absentObject,limit:1}}],
  ['/v2/choice-snapshots/preferences/read',{}],['/v2/capsules/permissions/query',{view:'owned',limit:1}],
  ['/v2/capsules/versions',{capsuleId:absentObject,limit:1}],['/v1/deletion-requests/config',{}]];
 for(const [path,input] of queries){
  stage=path;const value=await runtime.api.call(path,input);
  report.checks[path]={responded:true,...(Array.isArray(value.items)?{items:value.items.length}:{})};
  if(path==='/v1/identity/providers')report.configuredProviderIds=value.providers.map(p=>p.id);
 }
 report.passed=true;
}catch(error){
 report.passed=false;report.failure={stage,code:/^[A-Za-z0-9_:-]{1,100}$/.test(error.code??error.message)?error.code??error.message:'request_failed',
  ...(typeof error.claim==='string'&&['iat','nbf','exp','iss','aud'].includes(error.claim)?{claim:error.claim}:{}),
  ...(diagnostics.has(error.message)?{diagnostic:error.message}:{})};
}finally{
 if(bindingId&&runtime?.api.snapshot()){
  try{const receipt=await runtime.api.call(`/v1/bindings/${bindingId}/revoke`,{});report.bindingRevoked=receipt.bindingId===bindingId&&receipt.state==='revoked';}
  catch{report.bindingRevoked=false;report.bindingIdForCleanup=bindingId;}
 }
 runtime?.close();memory.clear();report.localPrivateMaterialPersisted=false;
 report.publicTaskOrMessageCreated=false;report.accountCreated=false;report.browserExperienceVerified=false;
 await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(report));if(!report.passed||bindingId&&!report.bindingRevoked)process.exitCode=1;
}
