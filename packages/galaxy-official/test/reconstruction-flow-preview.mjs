import {createServer as createHttpsServer} from 'node:https';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {join,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {createServices} from '../src/services.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createOidcLoginProvider} from '../src/oidc-login.mjs';
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';
import {productMiddleware} from '../../../scripts/serve-product.mjs';
import {createNativeRuntime} from '../../galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {registerNativeIdentityWebConnectTools} from '../../../integrations/native-v2/identity-web-connect-tools.mjs';
import {signIdentityPayload} from '../../galaxy-core/src/domain/identity-material.mjs';
import {digest} from '../src/shared/digest.mjs';
import canonicalize from 'canonicalize';
import {chatSendSchema,chatEditSchema} from '../src/shared/chat-schema.mjs';

const seconds=()=>Math.floor(Date.now()/1000);
const json=(response,value,status=200)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(value));};
const code=reason=>/^[a-z0-9_-]{1,100}$/.test(reason?.code??reason?.message??'')?reason.code??reason.message:'local_scene_request_failed';
async function input(request){let text='';for await(const chunk of request){text+=chunk;if(Buffer.byteLength(text)>12000)throw Error('local_scene_input_too_large');}return JSON.parse(text||'{}');}

// Shared normal UI and production services. No API response replacement, no
// verified-state injection, and no message transport double. Only identities,
// the OIDC interaction account and declared work samples are synthetic.
export async function createReconstructionFlowPreview({directory,certificate,key,reportDirectory,ports=[5240,5241,5242],chatTransport=null}={}){
 if(!isAbsolute(directory??'')||!isAbsolute(certificate??'')||!isAbsolute(key??'')||!isAbsolute(reportDirectory??''))throw Error('local_scene_absolute_paths_required');
 const origins=ports.slice(0,2).map(port=>'https://127.0.0.1:'+port),endpoint='https://127.0.0.1:'+ports[2];
 const metadataFile=join(reportDirectory,'shared-scene-status.json');
 let prior=null;try{const value=JSON.parse(await readFile(metadataFile,'utf8'));if(resolve(value.directory) !== resolve(directory)||value.endpoint!==endpoint)throw Error('local_scene_original_storage_mismatch');prior=value;}
 catch(reason){if(reason.code!=='ENOENT')throw reason;}
 const db=new PGlite(join(directory,'database')),servers=[],people=[],trace=[],publications=[];
 if(prior){const previous=JSON.parse(await readFile(join(reportDirectory,'shared-scene-before-reload-verify.json'),'utf8'));trace.push(...previous.trace);}
 const lost={publication:false,event:false,consent:false,profile:false,...(chatTransport?{chatSend:false,chatEdit:false}:{})};let stopped=false;
 await migrate(db);await mkdir(reportDirectory,{recursive:true});
 const issuer=await oidcProviderFixture([endpoint+'/v1/identity/callback/local-synthetic'],{emailVerified:true});
 const provider=await createOidcLoginProvider({id:'local-synthetic',name:'本地合成账号（隔离验证）',issuer:issuer.issuer,clientId:'galaxy-fixture',
  redirectUri:endpoint+'/v1/identity/callback/local-synthetic',allowLoopbackHttp:true,now:seconds});
 const previousPins=prior?JSON.parse(await readFile(prior.publicConfiguration,'utf8')).signingKeys:[];
 const signer=generateKeyPairSync('ed25519'),kid='local-reconstruction-'+randomUUID(),trustedKeys=new Map([...previousPins.map(pin=>[pin.kid,pin]),[kid,{publicKeyPem:signer.publicKey.export({type:'spki',format:'pem'}),notBefore:seconds()-1,notAfter:seconds()+7*86400,revoked:false}]]);
 const services=createServices({db,endpoint,signingKey:signer.privateKey,kid,trustedKeys,operator:'本地合成共享现场',region:'local',now:seconds,
  identityProviders:[provider],allowedScopes:browserScopes,chatTransport});
 const api=createApi({...services,browserOrigins:origins,rateLimit:1000,releaseId:'local-reconstruction-20261012'});
 const tls={cert:await readFile(certificate),key:await readFile(key)},dispatch=api.listeners('request')[0];
 const authority=createHttpsServer(tls,(request,response)=>{
  const path=new URL(request.url,endpoint).pathname,method=request.method;
  if(path.startsWith('/__local__/'))return void localControl(request,response,null).catch(reason=>json(response,{error:code(reason)},400));
  let eventId=null,payloadHash=null,consentId=null,signatureHash=null,body='';
  // Observe only chunks actually consumed by the API. Adding a data listener
  // here would switch the request into flowing mode before its async handler.
  const read=request.read.bind(request);request.read=function(...args){const chunk=read(...args);if(chunk!==null&&body.length<900000)body+=chunk;return chunk;};
  const end=response.end.bind(response);response.end=function(chunk,...rest){
   try{const value=JSON.parse(body);if(value.payloadJson){const payload=JSON.parse(value.payloadJson);eventId=payload.event?.eventId??payload.eventId??payload.operationId??payload.id;payloadHash=digest(value.payloadJson);consentId=value.consentId??null;}
    if(typeof value.signedIntent==='string'){const intent=JSON.parse(Buffer.from(value.signedIntent.split('.')[1],'base64url').toString('utf8'));
     eventId=intent.objectId;payloadHash=intent.payloadHash;consentId=intent.id;signatureHash=digest(value.signedIntent);}
   }catch{/* Metadata only. */}
   if(path.startsWith('/v2/chat/')){try{const value=JSON.parse(body);
    if(path.endsWith('/send')){eventId=value.clientMessageId;payloadHash=digest(canonicalize(chatSendSchema.parse(value)));}
    if(path.endsWith('/edit')){eventId=value.operationId;payloadHash=digest(canonicalize(chatEditSchema.parse(value)));}
   }catch{/* Never retain message text or raw request bodies. */}}
   const record={at:new Date().toISOString(),path,method,status:response.statusCode,eventId,payloadHash,consentId,...(signatureHash?{signatureHash}:{})};
   if(path==='/v2/tasks'&&method==='POST'||path.endsWith('/events')&&method==='POST'||path==='/v1/consents'||path==='/v2/tasks/receipt'||path.startsWith('/v1/profiles/statements')||path.startsWith('/v2/chat/'))trace.push(record);
   const family=path==='/v2/tasks'&&method==='POST'?'publication':path.endsWith('/events')&&method==='POST'?'event':path==='/v1/consents'&&method==='POST'?'consent':path==='/v1/profiles/statements'&&method==='POST'?'profile':path.startsWith('/v2/chat/')&&path.endsWith('/send')?'chatSend':path.startsWith('/v2/chat/')&&path.endsWith('/edit')?'chatEdit':null;
   if(family&&lost[family]&&response.statusCode===200){lost[family]=false;record.responseLost=true;response.destroy();return response;}
   return end(chunk,...rest);
  };
  void dispatch(request,response);
 });
 await new Promise(resolve=>authority.listen(ports[2],'127.0.0.1',resolve));servers.push(authority);
 const publicConfig={version:1,endpoint,operator:'本地合成共享现场',signingKeys:[...trustedKeys].map(([pinKid,pin])=>({kid:pinKid,...pin}))};
 const configFile=join(reportDirectory,'public-web-config.json');await writeFile(configFile,JSON.stringify(publicConfig,null,2));process.env.GALAXY_WEB_CONFIG_FILE=configFile;
 async function actor(name,role,index){
  const dataDirectory=join(directory,role),runtime=await createNativeRuntime({dataDirectory,endpoint,website:origins[index],trustedKeys,now:seconds,
   openBrowser:async()=>({state:'headless-user-choice-required',launched:false})});
  await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true,...(prior?{restore:true}:{})});
  const status=await runtime.status(),owner=await runtime.store.get('native-active:'+endpoint),material=await runtime.store.get('device:'+status.identity+':'+owner.deviceId);
  if(prior&&prior.roles.find(person=>person.role===role)?.subjectId!==status.identity)throw Error('local_scene_original_identity_changed');
  if(!(await runtime.api.call('/v2/account/quotas',{})).accountVerified){
  issuer.setAccount('local-reconstruction-'+role);
  const login=await runtime.api.call('/v1/identity/begin',{providerId:'local-synthetic'}),callback=await issuer.authorize(login.authorizationUrl);
  const response=await fetch(callback);if(response.status!==200)throw Error('local_scene_account_callback_failed');await response.arrayBuffer();
  const account=await runtime.api.call('/v1/identity/status',{id:login.loginId});
  await runtime.api.call('/v1/identity/confirm',{id:login.loginId,signed:await signIdentityPayload(account.payloadJson,material.privateKey,{type:'galaxy-identity-link+jws'})});
  if(!(await runtime.api.call('/v2/account/quotas',{})).accountVerified)throw Error('local_scene_account_not_verified');
  }
  const grant=async(payload,action,{visibility='Private',viewers=[]}={})=>runtime.authorize({requestId:randomUUID(),payloadJson:JSON.stringify(payload),
   action,objectId:payload.eventId??payload.operationId??payload.id,visibility,viewers,expiresAt:seconds()+7*86400},{confirmed:true});
  const write=async(path,payload,action,options)=>{const allowed=await grant(payload,action,options);return runtime.api.call(path,{consentId:allowed.consentId,payloadJson:allowed.payloadJson});};
  if(!prior)await write('/v1/profiles/statements',{id:randomUUID(),expectedRevision:0,selfDeclared:{displayName:name,
   about:'本地合成主体。这里的工作和结果是明确的隔离体验样本，不是生产工作、真实用户研究或能力认证。',claimedCapabilities:[]}},'profile.publish',{visibility:'Public'});
  const bridge=registerNativeIdentityWebConnectTools({registerTool(){}},{runtime});
  const person={name,role,origin:origins[index],subjectId:status.identity,dataDirectory,runtime,bridge,write,grant};people.push(person);return person;
 }
 const requester=await actor('[本地合成] 林舟 · 发起者','requester',0);await actor('[本地合成] 周宁 · 回应者','responder',1);
 let task,post;
 if(prior){
  const current=await requester.runtime.api.call('/v2/tasks/'+prior.seed.taskId,undefined,{method:'GET'});
  if(current.requesterId!==requester.subjectId||current.caseId!==prior.seed.caseId)throw Error('local_scene_original_work_changed');
  task=current.request;post=prior.forumSource;publications.push(prior.seed);
 }else{
 task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',title:'[本地合成] 原页面说明的阅读检查',
  summary:'这项已有工作留下两轮准确尝试和一个有限结果。可以带着原内容继续找帮助，也可以从一份新求助开始。',
  workContext:{goal:'让页面说明能被顺畅理解',currentSituation:'本人已检查主语与阅读范围，仍有一段需要另一位读者看一看。',attemptRefs:[]},
  visibility:'Public',collaboration:'open-assistance',enrollmentExpiresAt:seconds()+7*86400};
 await requester.write('/v2/tasks',task,'assistance.publish',{visibility:'Public'});
 const caseId=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:requester.subjectId,taskId:task.taskId,localRef:randomUUID(),
  title:task.title,summary:'仅为这份本地合成页面说明记录过程；没有模拟真实项目执行。',source:{kind:'active-task',reference:task.taskId},synthetic:true};
 const attempt={schemaVersion:2,kind:'attempt-start',eventId:randomUUID(),caseId,expectedVersion:1,actorId:requester.subjectId,taskId:task.taskId,
  role:'implementation',strategy:'逐段找出主语不明确的句子。',configurationRef:null,inputScopeSummary:'只阅读本地合成文字。',permissionScope:['selected-context']};
 const caseGrant=await requester.grant(root,'case.teaser.publish',{visibility:'Public'}),attemptGrant=await requester.grant(attempt,'case.teaser.publish',{visibility:'Public'});
 await requester.runtime.api.call('/v2/tasks/'+task.taskId+'/case',{operationId:randomUUID(),expectedTaskVersion:1,
  case:{consentId:caseGrant.consentId,payloadJson:caseGrant.payloadJson},initialFact:{consentId:attemptGrant.consentId,payloadJson:attemptGrant.payloadJson}});
 let version=2;
 const fact=async(kind,fields)=>{const event={schemaVersion:2,kind,eventId:randomUUID(),caseId,expectedVersion:version,actorId:requester.subjectId,taskId:task.taskId,...fields};
  await requester.write('/v2/cases/events',event,'case.teaser.publish',{visibility:'Public'});version++;return event;};
 await fact('attempt-end',{attemptRef:{id:attempt.eventId,version:1},status:'completed',reportedOutcome:'partial',summary:'识别并修改了两处主语，尚有一个范围表述没检查完。',failureReason:'没有检查所有文字。'});
 const second=await fact('attempt-start',{role:'implementation',strategy:'再按读者可取得的材料核对范围。',configurationRef:null,inputScopeSummary:'同一份合成说明。',permissionScope:['selected-context']});
 await fact('attempt-end',{attemptRef:{id:second.eventId,version:1},status:'completed',reportedOutcome:'partial',summary:'补齐一处范围，另一处希望取得建议。',failureReason:'仍需另一位读者的意见。'});
 const result=await fact('result-recorded',{origin:{kind:'attempt',id:second.eventId,version:2},scopeVersion:1,deliverableRefs:[],reportedOutcome:'partial',
  summary:'[本地合成] 本人两轮说明检查留下有限结果，尚未宣称问题全部解决。',limitations:'只使用隔离样本；没有真实用户或生产结果。'});
 post={schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),expectedHeadVersion:0,versionId:randomUUID(),
  title:'[本地合成] 可选择的原讨论材料',body:'这段原话来自当前合成发起者。选到求助时保持准确版本，撤回后受控片段必须收起。',links:[],publishedUntil:seconds()+7*86400};
 const {bindForumIds}=await import('../src/shared/community-forum-ids-v1.mjs');Object.assign(post,await bindForumIds('create-post',requester.subjectId,post));
 const forumAuthorization=await requester.runtime.workerAuthorization.prepareAuthorization(post,{action:'forum.post.publish',objectId:post.versionId,
  visibility:'Public',expiresAt:post.publishedUntil,confirmed:true});
 await requester.runtime.api.call('/v2/community/posts',{signedIntent:forumAuthorization.signedIntent,payloadJson:forumAuthorization.payloadJson});
 publications.push({taskId:task.taskId,eventId:task.operationId,caseId,attemptRefs:[{id:attempt.eventId,version:2},{id:second.eventId,version:2}],resultRef:{id:result.eventId,version:1}});
 }
 async function verification(){
  const tasks=(await db.query('SELECT id,root_event_id,version FROM task_requests ORDER BY id')).rows;
  const events=(await db.query("SELECT id,task_id,subject_id,kind,payload_hash,consent_id FROM task_events ORDER BY created_at,id")).rows;
  const profileStatements=(await db.query('SELECT id,subject_id,revision,payload_hash,consent_id FROM profile_statements ORDER BY subject_id,revision')).rows;
  const chatRooms=(await db.query('SELECT room_id,title,revision,member_revision,created_order FROM chat_rooms ORDER BY created_order')).rows;
  const chatMessages=(await db.query('SELECT message_id,room_id,subject_id,client_message_id,payload_hash,sequence,state,revision,accepted_order,accepted_at FROM chat_message_refs ORDER BY sequence')).rows;
  const chatOperations=(await db.query('SELECT operation_id,room_id,message_id,subject_id,kind,request_hash,state FROM chat_message_operations ORDER BY created_at')).rows;
  return{checkedAt:new Date().toISOString(),endpoint,origins,roles:people.map(({name,role,origin,subjectId})=>({name,role,origin,subjectId})),seeds:publications,
   tasks,events,profileStatements,chatRooms,chatMessages,chatOperations,trace:[...trace],lostResponseArmed:{...lost},attachmentsSupported:false,chatTransportAvailable:chatTransport?.available===true};
 }
 function landing(person){const chatControls=chatTransport?'<p><a href="/app/rooms">消息与对话</a></p><p>聊天正文由独立真实 Prosody MUC/MAM 保存；附件扫描与上传未配置。</p><button data-loss="chatSend">下一条聊天消息成功后断开一次回应</button><button data-loss="chatEdit">下一次消息编辑成功后断开一次回应</button>':'';
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>银河共享本地体验</title><style>body{font:16px system-ui;line-height:1.7;max-width:800px;margin:40px auto;padding:0 20px}button,a{font:inherit;margin:6px 10px 6px 0}button{padding:10px 16px}output{display:block;white-space:pre-wrap}</style>'+
  '<h1>共享本地体验 · '+person.name+'</h1><p>本页仅提供明确标记的合成账号及故障控制。点击连接后进入正常银河页面；公开材料、当前许可、签名、设备控制、参与与事实仍由实际服务检查。不会自动发布或伪造工作结果。</p>'+chatControls+
  '<button type="button" id="connect">用这个合成主体进入银河</button><output id="status"></output><p><a href="/app/publish">发起新求助</a><a href="/app/tasks/'+task.taskId+'?section=collaboration">原工作与准确尝试</a><a href="/app/community/posts/'+post.postId+'/versions/'+post.versionId+'">原讨论材料</a><a href="/app/people/'+person.subjectId+'">本人资料</a><a href="/app/account">个人中心</a><a href="/app/settings/identity">身份与设置</a></p><details><summary>本地故障与核对</summary><button data-loss="publication">下一次发布成功后丢一次回应</button><button data-loss="event">下一次工作或回应成功后丢一次回应</button><button data-loss="profile">下一次资料保存成功后丢一次回应</button><a href="/__local__/verify">无密只读当前记录</a></details><script>const status=document.getElementById("status");document.getElementById("connect").onclick=async()=>{try{status.textContent="正在准备原合成主体的真实连接选择…";const response=await fetch("/__local__/connect",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});const value=await response.json();if(!response.ok)throw Error(value.error);status.textContent="请在原设备选择页核对并批准网页连接。";location.href=value.url;}catch(reason){status.textContent=reason.message;}};for(const button of document.querySelectorAll("[data-loss]"))button.onclick=async()=>{await fetch("/__local__/lose-response",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({family:button.dataset.loss})});status.textContent="已设置：下一次该操作实际成功后仅丢失一次HTTP回应，服务记录不撤销。";};</script></html>';}
 async function localControl(request,response,person){
  const url=new URL(request.url,person?.origin??endpoint);
  if(request.method==='GET'&&url.pathname==='/__local__/verify')return json(response,await verification());
  if(!person)throw Error('local_scene_website_required');
  if(request.method==='GET'&&(url.pathname==='/__local__'||url.pathname==='/__local__/')){response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});response.end(landing(person));return;}
  if(request.method!=='POST'||request.headers.origin!==person.origin)throw Error('local_scene_origin_required');
  const value=await input(request);
  if(url.pathname==='/__local__/connect'){
   if(!person.runtime.api.snapshot())await person.runtime.connect({confirmed:true});
   const result=await person.bridge.prepare({requestId:randomUUID(),object:{kind:'publish'},scopes:[...browserScopes]});return json(response,{url:result.url,subjectId:result.subjectId});
  }
  if(url.pathname==='/__local__/lose-response'&&Object.hasOwn(lost,value.family)){lost[value.family]=true;return json(response,{armed:value.family});}
  throw Error('local_scene_operation_unknown');
 }
 const middleware=productMiddleware();
 for(const person of people){const server=createHttpsServer(tls,(request,response)=>{
  if(request.url.startsWith('/__local__'))return void localControl(request,response,person).catch(reason=>json(response,{error:code(reason)},400));
  void middleware(request,response);
 });await new Promise(resolve=>server.listen(Number(new URL(person.origin).port),'127.0.0.1',resolve));servers.push(server);}
 const metadata={startedAt:new Date().toISOString(),pid:process.pid,endpoint,publicConfiguration:configFile,certificate,directory,roles:people.map(({name,role,origin,subjectId,dataDirectory})=>({name,role,origin,subjectId,dataDirectory,entry:origin+'/__local__/'})),
  seed:publications[0],forumSource:{postId:post.postId,versionId:post.versionId},...(prior?.seedConversation?{seedConversation:prior.seedConversation}:{}),boundary:'Production createServices/createApi/Consent/current identity control and Native website bridge, real HTTPS and persisted PGlite SQL. Synthetic identities, OIDC interaction account and labeled work samples only. No user browser, model, remote account, message-archive double or attachment scanner. New work and results must come from normal UI actions.'};
 if(chatTransport){metadata.chatTransport={kind:'real-Prosody-MUC-MAM',available:chatTransport.available===true};
  metadata.boundary+=' Chat content is delivered, versioned and stored by an independently isolated real Prosody component; no Map transport. The visible fault control closes one successful HTTP response after actual SQL/MAM acknowledgement, not a production outage.';}
 await writeFile(metadataFile,JSON.stringify(metadata,null,2));
 return{metadata,services,people,verification,close:async()=>{if(stopped)return;stopped=true;for(const person of people){await person.bridge.close();person.runtime.close();}for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}api.closeAllConnections();await issuer.close();await db.close();}};
}

if(process.argv.includes('--preview')&&resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
 const scene=await createReconstructionFlowPreview({directory:process.env.GALAXY_FLOW_DATA_DIRECTORY,certificate:process.env.GALAXY_FLOW_TLS_CERT,key:process.env.GALAXY_FLOW_TLS_KEY,reportDirectory:process.env.GALAXY_FLOW_REPORT_DIRECTORY});
 process.stdout.write(JSON.stringify({pid:process.pid,endpoint:scene.metadata.endpoint,entries:scene.metadata.roles.map(value=>value.entry)})+'\n');
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void scene.close().then(()=>process.exit(0)));
}
