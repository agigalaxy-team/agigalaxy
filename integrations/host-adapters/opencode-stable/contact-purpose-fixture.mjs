import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {serviceFixture} from '../../../packages/galaxy-official/test/service-fixture.mjs';
import {oidcProviderFixture} from '../../../packages/galaxy-official/test/oidc-provider-fixture.mjs';
import {createOidcLoginProvider} from "../../../packages/galaxy-official/src/identity/authentication/oidc-login.mjs";
import {createApi} from '../../../packages/galaxy-official/src/http.mjs';
import {browserScopes} from '../../../packages/galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../../../packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {createNativeToolServer} from '../../../packages/galaxy-edge-mcp/src/native-v2/server.mjs';
import {signIdentityPayload} from '../../../packages/galaxy-core/src/domain/identity-material.mjs';
import {syntheticMessageTransport} from '../../native-v2/compact-app/purpose-fixture.mjs';

const require=createRequire(new URL('../../../packages/galaxy-official/package.json',import.meta.url));
const{Client,InMemoryTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
export const purposeData=r=>r.structuredContent??JSON.parse(r.content[0].text);

// All identity, account, Consent, discovery, contact and room permissions are
// real local HTTP services. Only the two people and message transport are
// synthetic. No choice endpoint is supplied by the fixture.
export async function createContactPurposeFixture(){
 const endpoint='https://official.example.org',now=Math.floor(Date.now()/1000),directory=await mkdtemp(join(tmpdir(),'galaxy-native-contacts-'));
 const issuer=await oidcProviderFixture([endpoint+'/v1/identity/callback/fixture'],{emailVerified:true});let f,api,closed=false;
 const participants=[],calls=[],state={sendRequests:0,responseRequests:0,consentRequests:0,messageRequests:0};let dropContactAck=false;
 async function close(){if(closed)return;closed=true;for(const p of participants){await p.client?.close();await p.server?.close();p.runtime?.close();}
  if(api?.listening){api.closeAllConnections();await new Promise(ok=>api.close(ok));}await f?.db.close();await issuer.close();
  const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-native-contacts-'));await rm(target,{recursive:true,force:true});}
 try{
  const provider=await createOidcLoginProvider({id:'fixture',name:'Synthetic local OIDC',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:endpoint+'/v1/identity/callback/fixture',allowLoopbackHttp:true,now:()=>now});
  f=await serviceFixture(browserScopes,null,{now,identityProviders:[provider],syntheticCommunityQuota:false});
  f.chat.transport=syntheticMessageTransport();api=createApi({...f,rateLimit:5000});await new Promise(ok=>api.listen(0,'127.0.0.1',ok));const base='http://127.0.0.1:'+api.address().port;
  async function participant(name,account){const runtime=await createNativeRuntime({dataDirectory:join(directory,account),endpoint,website:'https://selected.example',trustedKeys:f.bindings.trustedKeys,now:()=>now,
    fetch:async(url,options)=>{const u=new URL(url),path=u.pathname;calls.push({participant:account,path,method:options?.method??'POST'});
     if(path==='/v2/contacts'&&options?.method!=='GET'){const event=JSON.parse(JSON.parse(options.body).payloadJson);event.kind==='send'?state.sendRequests++:state.responseRequests++;}
     if(path==='/v1/consents')state.consentRequests++;if(path.endsWith('/send'))state.messageRequests++;
     const response=await fetch(base+path+u.search,options);if(dropContactAck&&path==='/v2/contacts'&&response.status===200){dropContactAck=false;throw Error('synthetic_contact_ack_lost');}return response;},openBrowser:async()=>({launched:false})});
   const p={runtime,name,account};participants.push(p);await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});p.subjectId=runtime.api.snapshot().subjectId;
   // A contained fixture login, using that runtime's real device signer. The
   // private key stays in the ephemeral Native store and is never emitted.
   issuer.setAccount(account);const login=await runtime.api.call('/v1/identity/begin',{providerId:'fixture'}),callback=await issuer.authorize(login.authorizationUrl);
   const response=await fetch(base+callback.pathname+callback.search);assert.equal(response.status,200);assert.equal((await response.json()).state,'awaiting-local-signature');
   const pending=await runtime.api.call('/v1/identity/status',{id:login.loginId}),active=await runtime.store.get('native-active:'+endpoint),device=await runtime.store.get('device:'+active.subjectId+':'+active.deviceId);
   await runtime.api.call('/v1/identity/confirm',{id:login.loginId,signed:await signIdentityPayload(pending.payloadJson,device.privateKey,{type:'galaxy-identity-link+jws'})});
   assert.equal((await runtime.api.call('/v2/account/quotas',{})).accountVerified,true);
   p.authorize=async(payload,action,path,{visibility='Private',viewers=[]}={})=>{const payloadJson=JSON.stringify(payload),requestId=randomUUID();await runtime.authorize({requestId,action,objectId:payload.eventId??payload.operationId??payload.id,payloadJson,visibility,viewers},{confirmed:true});return runtime.api.call(path,{consentId:requestId,payloadJson});};
   await p.authorize({id:randomUUID(),expectedRevision:0,selfDeclared:{displayName:name}},'profile.publish','/v1/profiles/statements',{visibility:'Public'});
   const server=createNativeToolServer(runtime),client=new Client({name:'synthetic-contact-'+account,version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();p.server=server;p.client=client;await server.connect(a);await client.connect(b);p.call=(name,args={})=>client.callTool({name,arguments:args});return p;
  }
  const sender=await participant('合成：当前工作中的同行','sender'),recipient=await participant('合成：文档工具维护者','recipient');
  const project={kind:'create',operationId:randomUUID(),projectId:randomUUID(),expectedRevision:0,document:{kind:'module',title:'合成：文档表格工具',summary:'合成：按可读原文与导出检查表格提取，愿意交流现有方法；不承诺交付。',functions:['表格提取','table-extraction'],technologies:['Python'],discoverable:true,participantKind:'human'}};
  await recipient.authorize(project,'project.write','/v2/projects',{visibility:'Public'});
  const prefs=await recipient.runtime.api.call('/v1/discovery/preferences/read',{});await recipient.runtime.api.call('/v1/discovery/preferences/save',{expectedRevision:prefs.revision,preferences:{enabled:true,purposes:['conversation','collaboration','reuse'],functions:[],temporary:null}});
  async function work(p,title,outcome){const caseId=randomUUID(),attemptId=randomUUID(),resultId=randomUUID();const root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:p.subjectId,localRef:randomUUID(),title,summary:'合成：当前已有文档工作，仅用于本地接续测试。',source:{kind:'local',reference:randomUUID()},synthetic:true};
   const attempt={schemaVersion:2,kind:'attempt-start',eventId:attemptId,caseId,expectedVersion:1,actorId:p.subjectId,role:'implementation',strategy:'检查所选文档的表格边界与导出。',inputScopeSummary:'所选合成文档',permissionScope:['selected-material'],environment:{name:'Python',version:'3.13'}};
   const result={schemaVersion:2,kind:'result-recorded',eventId:resultId,caseId,expectedVersion:2,actorId:p.subjectId,origin:{kind:'attempt',id:attemptId,version:1},scopeVersion:1,deliverableRefs:[],reportedOutcome:outcome,summary:'合成：已提取当前示例，复杂合并单元格仍待处理。',limitations:'合成示例，未作独立检查或真实模型验收。'};
   for(const event of[root,attempt,result])await p.authorize(event,'case.teaser.publish','/v2/cases/events',{visibility:p===recipient?'Public':'Private'});return{root,attempt,result};}
  const source=await work(sender,'表格提取','partial'),experience=await work(recipient,'合成：表格提取的实际尝试','partial'),baseline={...state};
  sender.readWorkContext=async()=>({caseId:source.root.caseId,origin:{host:'opencode-local-contact-fixture',workRef:'synthetic-table-work'}});recipient.readWorkContext=async()=>({caseId:experience.root.caseId,origin:{host:'opencode-local-contact-fixture',workRef:'synthetic-recipient-work'}});
  async function observation(){const contacts=await sender.runtime.api.call('/v2/contacts/query',{limit:100}),rooms=await sender.runtime.api.call('/v2/chat/rooms/query',{limit:100});
   const events=(await f.db.query('SELECT operation_id,contact_id,subject_id,kind,revision FROM contact_events_v2 ORDER BY created_at,revision')).rows;
   const chat=(await f.db.query('SELECT room_id,subject_id,client_message_id,state,actor_kind FROM chat_message_refs ORDER BY sequence')).rows;
   const counts=(await f.db.query('SELECT (SELECT count(*)::int FROM task_requests) AS tasks,(SELECT count(*)::int FROM task_participations) AS participations,(SELECT count(*)::int FROM chat_rooms) AS rooms')).rows[0];
   return{actualNativeMcp:true,actualSignedHttp:true,realLocalOidc:true,syntheticWork:true,syntheticMessageTransport:true,realProsody:false,modelCalls:0,
    counts,contacts:contacts.items,rooms:rooms.rooms,events,chat,...Object.fromEntries(Object.entries(state).map(([key,value])=>[key,value-baseline[key]])),sourceCaseId:source.root.caseId,recipientProjectId:project.projectId};}
  return{f,api,issuer,directory,sender,recipient,source,experience,project,state,baseline,calls,observation,close,setDropContactAck:value=>{dropContactAck=value;}};
 }catch(error){await close();throw error;}
}
