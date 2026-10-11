import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {serviceFixture} from '../../../packages/galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../../packages/galaxy-official/src/http.mjs';
import {browserScopes} from '../../../packages/galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../../../packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {createNativeToolServer} from '../../../packages/galaxy-edge-mcp/src/native-v2/server.mjs';
import {createNativeCapsuleWork} from '../../native-v2/capsule-work-tools.mjs';

const require=createRequire(new URL('../../../packages/galaxy-official/package.json',import.meta.url));
const{Client,InMemoryTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const data=result=>result.structuredContent??JSON.parse(result.content[0].text);

// A new visible menu can read and continue the old live fixture. This does not
// initialize another identity, copy an operation, create a draft, or approve it.
export async function connectCapsulePurposeFixture(url){
 const base=new URL(url);assert.equal(base.protocol,'http:');assert.equal(base.hostname,'127.0.0.1');
 assert.equal(base.pathname,'/');assert.equal(base.search,'');assert.equal(base.username,'');assert.equal(base.password,'');
 const read=async path=>{const response=await fetch(new URL(path,base));assert.equal(response.ok,true);return response.json();};
 const call=async(name,args={})=>{const response=await fetch(new URL('/tools',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,args})});assert.equal(response.ok,true);return response.json();};
 const readWorkContext=()=>read('/context'),context=await readWorkContext();
 const current=data(await call('galaxy_capsule_work_read',{caseId:context.caseId}));
 return{call,readWorkContext,observation:()=>read('/observation'),source:{root:{title:current.title,summary:current.summary}},close:async()=>{},bridgeTo:base.href};
}

// Reuses the existing Native capsule fixture's real signed v2 work and MCP
// transport. Only setup seeds are authorized here; subsequent method actions
// go through the original Native user-choice gate without a test approval API.
export async function createCapsulePurposeFixture(){
 const f=await serviceFixture(browserScopes),directory=await mkdtemp(join(tmpdir(),'galaxy-native-method-purpose-'));
 let api,runtime,server,client,closed=false;
 const state={publicationRequests:0,useRequests:0,consentRequests:0},calls=[];
 async function close(){if(closed)return;closed=true;await client?.close();await server?.close();runtime?.close();if(api?.listening){api.closeAllConnections();await new Promise(ok=>api.close(ok));}await f.db.close();
  const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-native-method-purpose-'));await rm(target,{recursive:true,force:true});}
 try{
  api=createApi({...f,rateLimit:5000});await new Promise(ok=>api.listen(0,'127.0.0.1',ok));const base='http://127.0.0.1:'+api.address().port;
  runtime=await createNativeRuntime({dataDirectory:directory,endpoint:f.bindings.endpoint,website:'https://selected.example',trustedKeys:f.bindings.trustedKeys,now:()=>f.now,
   fetch:async(url,options)=>{const path=new URL(url).pathname;calls.push(path);if(path==='/v2/capsules/events')state.publicationRequests++;if(path==='/v2/capsules/uses')state.useRequests++;if(path==='/v1/consents')state.consentRequests++;return fetch(base+path,options);},openBrowser:async()=>({launched:false})});
  await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});const subjectId=runtime.api.snapshot().subjectId;
  const authorize=async(payload,action,path)=>{const payloadJson=JSON.stringify(payload),requestId=randomUUID();await runtime.authorize({requestId,action,objectId:payload.eventId,payloadJson,visibility:'Private',viewers:[]},{confirmed:true});return runtime.api.call(path,{consentId:requestId,payloadJson});};
  async function work(title,outcome,version){const id=randomUUID(),attemptId=randomUUID(),resultId=randomUUID();
   const root={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,actorId:subjectId,localRef:randomUUID(),title,summary:'合成：在当前已有工作检查包导出；不是实体任务验收。',source:{kind:'local',reference:randomUUID()},synthetic:true};
   const attempt={schemaVersion:2,kind:'attempt-start',eventId:attemptId,caseId:id,expectedVersion:1,actorId:subjectId,role:'implementation',strategy:'检查 package exports 的已有配置，再对照实际调用。',inputScopeSummary:'所选模块的导出与调用',permissionScope:['selected-material'],environment:{name:'Node',version}};
   const result={schemaVersion:2,kind:'result-recorded',eventId:resultId,caseId:id,expectedVersion:2,actorId:subjectId,origin:{kind:'attempt',id:attemptId,version:1},scopeVersion:1,deliverableRefs:[],reportedOutcome:outcome,summary:title+'：合成测试结果',limitations:'仅合成夹具，未作真人或独立模型验收。'};
   for(const event of[root,attempt,result])await authorize(event,'case.teaser.publish','/v2/cases/events');return{root,attempt,result};
  }
  const source=await work('合成：当前包导出工作','succeeded','24'),target=await work('合成：实际采用方法的工作','partial','26');
  const flow=createNativeCapsuleWork(runtime),prepared=await flow.prepare({action:'publish',caseId:source.root.caseId,resultRef:{id:source.result.eventId,version:1},visibility:'Private',viewers:[],method:{
   title:'合成：包导出检查方法',problemPattern:'合成：模块的导出与实际调用不一致',solutionStrategy:source.attempt.strategy,environment:{name:'Node',version:'24'},tools:[],skills:[],mcpRefs:[],verificationMethod:'合成：沿当前结果核对调用，不表示独立验证。',limitations:[source.result.limitations],capabilityId:'software-debugging',applicableScope:'所选模块的导出与调用',license:'MIT'}});
  const seeded=await flow.execute(prepared.handle);assert.equal(seeded.state,'acknowledged');const baseline={...state};
  server=createNativeToolServer(runtime);client=new Client({name:'synthetic-native-method-purpose',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  const call=(name,args={})=>client.callTool({name,arguments:args});
  const readWorkContext=async()=>({caseId:source.root.caseId,origin:{host:'opencode-local-fixture',workRef:'synthetic-package-exports'}});
  async function observation(){const current=data(await call('galaxy_capsule_v2_read',{capsuleId:seeded.receipt.capsuleId}));const versions=data(await call('galaxy_capsule_v2_versions',{capsuleId:seeded.receipt.capsuleId,limit:20}));
   const uses=await runtime.api.call('/v2/capsules/uses/query',{capsuleId:seeded.receipt.capsuleId,limit:20});return{actualSignedHttp:true,actualNativeMcp:true,syntheticWork:true,modelCalls:0,
    publicationRequests:state.publicationRequests-baseline.publicationRequests,useRequests:state.useRequests-baseline.useRequests,consentRequests:state.consentRequests-baseline.consentRequests,
    current:{title:current.version?.title,version:current.version?.version,solutionStrategy:current.version?.solutionStrategy},versions:versions.items.map(v=>({versionId:v.versionId,version:v.version,publicationState:v.publicationState})),
    uses:(uses.items??[]).map(u=>({id:u.eventId??u.id,kind:u.kind,versionId:u.record?.versionId,note:u.record?.note,outcome:u.record?.outcome,originRef:u.record?.originRef,resultRef:u.record?.resultRef,environment:u.record?.environment})),seededVersions:1};}
  return{f,directory,runtime,server,client,source,target,seeded,baseline,state,calls,call,readWorkContext,observation,close};
 }catch(error){await close();throw error;}
}
