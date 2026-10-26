import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {serviceFixture} from '../../packages/galaxy-official/test/service-fixture.mjs';
import {startReferenceProcess} from '../../packages/galaxy-official/test/worker-pack-process-v2-workflow.mjs';
import {createApi} from '../../packages/galaxy-official/src/http.mjs';
import {browserScopes} from '../../packages/galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../../packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {createNativeToolServer} from '../../packages/galaxy-edge-mcp/src/native-v2/server.mjs';
import {createNativeA2aHostV2} from "../../packages/galaxy-a2a/src/hosts/host-flow-v2.mjs";
const require=createRequire(new URL('../../packages/galaxy-official/package.json',import.meta.url));
const{Client,InMemoryTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const hash=text=>createHash('sha256').update(text).digest('hex');

// Isolated synthetic source work. Native keys/leases, HTTP signatures, database,
// MCP, A2A SDK and the loopback Node reference process are actual runtimes.
export async function a2aPurposeFixture({longPreview=false,compactArtifact}={}){
 const f=await serviceFixture(browserScopes),directory=await mkdtemp(join(tmpdir(),'galaxy-a2a-purpose-'));let api,runtime,server,client,processPeer,closed=false;
 const state={dropResultAck:false,resultWrites:0},calls=[];
 async function close(){if(closed)return;closed=true;await client?.close();await server?.close();runtime?.close();await processPeer?.close();
  if(api?.listening){api.closeAllConnections();await new Promise(ok=>api.close(ok));}await f.db.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-a2a-purpose-'));await rm(target,{recursive:true,force:true});}
 try{api=createApi({...f,rateLimit:5000});await new Promise(ok=>api.listen(0,'127.0.0.1',ok));const base='http://127.0.0.1:'+api.address().port;
  runtime=await createNativeRuntime({dataDirectory:directory,endpoint:f.bindings.endpoint,website:'https://selected.example',trustedKeys:f.bindings.trustedKeys,now:()=>f.now,
   fetch:async(url,options)=>{const path=new URL(url).pathname;let isResult=false;if(path==='/v2/cases/events'){try{isResult=JSON.parse(JSON.parse(options.body).payloadJson).kind==='result-recorded';}catch{}if(isResult)state.resultWrites++;}
    const response=await fetch(base+path,options);if(isResult&&state.dropResultAck&&response.status===200){state.dropResultAck=false;throw Error('synthetic_lost_original_result_ack');}return response;},openBrowser:async()=>({launched:false})});
  await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});const subjectId=runtime.api.snapshot().subjectId;
  async function work(title){const caseId=randomUUID(),attemptId=randomUUID(),events=[
   {schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:subjectId,localRef:randomUUID(),title,summary:'合成：仅将所选的算术输入交给已配置的本机服务。',source:{kind:'local',reference:randomUUID()},synthetic:true},
   {schemaVersion:2,kind:'attempt-start',eventId:attemptId,caseId,expectedVersion:1,actorId:subjectId,role:'implementation',strategy:'计算所选输入的合计',inputScopeSummary:'只含所选数字，不发送完整会话。',permissionScope:['selected-material'],environment:{name:'Node',version:'24'}},
  ];for(const e of events){const payloadJson=JSON.stringify(e),requestId=randomUUID();await runtime.authorize({requestId,action:'case.teaser.publish',objectId:e.eventId,payloadJson,visibility:'Private',viewers:[]},{confirmed:true});await runtime.api.call('/v2/cases/events',{consentId:requestId,payloadJson});}
   return{caseId,attemptId,attemptVersion:1,title};}
  const primary=await work('合成：计算当前输入的合计'),unknown=await work('合成：接续一次未确认的发送');
  processPeer=await startReferenceProcess();const peer={id:'selected-arithmetic',name:'本机算术示例服务',endpoint:'https://reference-worker.example.org/a2a',peerPrincipal:'isolated-reference-peer',agentCard:processPeer.card,
   cardHash:hash(JSON.stringify(processPeer.card)),trustExpiresAt:Date.now()+(longPreview?7200000:120000)};
  const host=createNativeA2aHostV2({runtime,directory:join(directory,'a2a-journal'),peers:[peer],post:processPeer.post,readPeerAuthorization:async()=>({subjectId:runtime.api.snapshot().subjectId,peerPrincipal:peer.peerPrincipal})});
  server=createNativeToolServer(runtime,{a2aHost:host,compactArtifact});client=new Client({name:'synthetic-a2a-purpose-host',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  const raw=(name,args={})=>{calls.push({name,action:args.action});return client.callTool({name,arguments:args});};
  return{f,runtime,host,client,raw,primary,unknown,peer,processPeer,state,calls,close};
 }catch(error){await close();throw error;}
}
