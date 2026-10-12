import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {nativeIdentityScopeGroups} from './identity-scope-presentation.mjs';
import {forumReadTopicSchema} from '../../../galaxy-official/src/shared/community-forum-topics-v1.mjs';

export const webIdentityProtocol='galaxy-web-identity-handoff';
export const webIdentityProofType='galaxy-web-identity-handoff-v1+jws';
export const webIdentityTtlSeconds=180;
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const subject=value=>typeof value==='string'&&/^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const compareKeys=(a,b)=>a<b?-1:a>b?1:0;
const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort(compareKeys).join(',')===[...keys].sort(compareKeys).join(',');
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort(compareKeys).map(key=>[key,item[key]])):item);
const digest=value=>createHash('sha256').update(stable(value)).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const codeOf=error=>/^[a-z0-9_-]{1,100}$/.test(error?.code??error?.message??'')?error.code??error.message:'web_identity_operation_failed';
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;");
function targetDescription(path){
 if(path.startsWith('/app/search?'))return '围绕“'+new URLSearchParams(path.slice(path.indexOf('?')+1)).get('q')+'”查找方法，随后返回原求助。';
 if(path==='/app/publish')return '继续填写求助。';
 if(path.startsWith('/app/tasks/'))return '继续阅读与处理原求助。';
 if(path.startsWith('/app/capsules'))return '阅读与使用方法。';
 if(path.startsWith('/app/rooms/'))return '继续原来的对话。';
 if(path.startsWith('/app/projects/'))return '继续查看原项目。';
 if(path.startsWith('/app/community'))return '继续阅读原来的社区内容。';
 if(path==='/app/bookmarks')return '继续查看自己的收藏。';
 return '继续原来选择的银河页面。';
}

export function isWebIdentityTargetPath(path){
 if(typeof path!=='string'||path.length>1500||!path.startsWith('/app/')||/[\\#]/.test(path))return false;
 if(path.includes('?')){
  const parts=path.split('?');if(parts.length!==2||parts[0].includes('%'))return false;
  if(parts[0]==='/app/community'){
   const parameters=new URLSearchParams(parts[1]),topic=parameters.get('topic'),query=parameters.get('q'),canonical=new URLSearchParams();
   if(topic!==null){if(!forumReadTopicSchema.safeParse(topic).success)return false;canonical.set('topic',topic);}
   if(query!==null){if(!query.trim()||query!==query.trim()||query.length>160||/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(query))return false;canonical.set('q',query);}
   return canonical.size>0&&parts[1]===canonical.toString();
  }
  if(parts[0]==='/app/search'){
   const parameters=new URLSearchParams(parts[1]),query=parameters.get('q'),taskId=parameters.get('sourceTask');
   if([...parameters.keys()].join(',')!=='q,sourceTask,returnTo'||typeof query!=='string'||!query.trim()||query!==query.trim()||query.length>200
    ||/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(query)||!uuid(taskId)
    ||parameters.get('returnTo')!=='/app/tasks/'+taskId+'?section=collaboration')return false;
   return parts[1]===new URLSearchParams({q:query,sourceTask:taskId,returnTo:'/app/tasks/'+taskId+'?section=collaboration'}).toString();
  }
  const capsule=/^\/app\/capsules\/([^/]+)\/versions\/([^/]+)$/.exec(parts[0]);
  if(!capsule||!uuid(capsule[1])||!uuid(capsule[2]))return false;
  const query=new URLSearchParams(parts[1]),taskId=query.get('sourceTask');
  if([...query.keys()].join(',')!=='sourceTask,returnTo'||!uuid(taskId)
   ||query.get('returnTo')!=='/app/tasks/'+taskId+'?section=collaboration')return false;
  return parts[1]===new URLSearchParams({sourceTask:taskId,returnTo:'/app/tasks/'+taskId+'?section=collaboration'}).toString();
 }
 if(path.includes('%'))return false;
 const object=/^\/app\/(?:tasks|rooms|projects)\/([^/]+)$/i.exec(path),capsule=/^\/app\/(?:capsules|community\/posts)\/([^/]+)(?:\/versions\/([^/]+))?$/i.exec(path);
 return !!object&&uuid(object[1])||!!capsule&&uuid(capsule[1])&&(!capsule[2]||uuid(capsule[2]))
  ||/^\/app\/(?:community|bookmarks|match|publish|participate|search|capsules|notifications|settings\/(?:privacy|summaries))$/.test(path);
}
function existingDevice(value,context){
 if(value===null)return null;
 if(!exact(value,['subjectId','deviceId','keyId'])||value.subjectId!==context.subjectId||!uuid(value.deviceId)||!hash(value.keyId))fail('web_identity_existing_device_invalid');
 return structuredClone(value);
}
function baseContext(input){
 if(!exact(input,['endpoint','website','subjectId','controller','scopes'])||!subject(input.subjectId)
  ||!exact(input.controller,['deviceId','keyId','epoch','chainHead'])||!uuid(input.controller.deviceId)||!hash(input.controller.keyId)||!hash(input.controller.chainHead)
  ||!Number.isSafeInteger(input.controller.epoch)||input.controller.epoch<1||!Array.isArray(input.scopes)||input.scopes.length>15
  ||!input.scopes.includes('binding')||new Set(input.scopes).size!==input.scopes.length||input.scopes.some(scope=>typeof scope!=='string'||!/^[a-z-]{1,40}$/.test(scope)))fail('web_identity_context_invalid');
 for(const field of ['endpoint','website']){let url;try{url=new URL(input[field]);}catch{fail('web_identity_context_invalid');}
  if(url.protocol!=='https:'||url.origin!==input[field]||url.username||url.password)fail('web_identity_context_invalid');}
 return structuredClone(input);
}
function publicOffer(value,context){
 if(!exact(value,['version','type','endpoint','subjectId','operationId','deviceId','publicKeyPem','scopes'])||value.version!==1||value.type!=='galaxy-device-request'
  ||value.endpoint!==context.endpoint||value.subjectId!==context.subjectId||!uuid(value.operationId)||!uuid(value.deviceId)
  ||typeof value.publicKeyPem!=='string'||value.publicKeyPem.length>256||!value.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')
  ||stable(value.scopes)!==stable(context.scopes)||/PRIVATE KEY|galaxy-recovery-v1:/.test(stable(value)))fail('web_identity_offer_invalid');
 return structuredClone(value);
}
function completion(value){
 if(!exact(value,['operationId','subjectId','deviceId','epoch','chainHead','connected'])||value.operationId!==null&&!uuid(value.operationId)
  ||!subject(value.subjectId)||!uuid(value.deviceId)||!Number.isSafeInteger(value.epoch)||value.epoch<1||!hash(value.chainHead)||value.connected!==true)fail('web_identity_completion_invalid');
 return structuredClone(value);
}
// The bridge only transports public, fixed-purpose packets. All keys and the
// original private workRef remain in the native/browser stores that own them.
export async function createWebIdentityHandoff({handoffId,navigationId,context:input,targetPath,store,assertCurrent,assertControl,signContext,previewOffer,approveOffer,readControl,beforeApprove,
 now=()=>Math.floor(Date.now()/1000),openBrowser=platformOpen}){
 if(!uuid(handoffId)||!uuid(navigationId)||!isWebIdentityTargetPath(targetPath)||typeof store?.put!=='function'
  ||[assertCurrent,assertControl,signContext,previewOffer,approveOffer,readControl,beforeApprove,openBrowser].some(value=>typeof value!=='function'))fail('web_identity_bridge_configuration_invalid');
 const context=baseContext(input),expiresAt=now()+webIdentityTtlSeconds,recordKey='web-identity-handoff:'+handoffId;
 let closed=false,nonce=null,browserDevice=null,signedContext=null,offer=null,offerHash=null,fingerprint=null,approval=null,completed=null;
 let state='ready',error=null,revision=0,mutation=Promise.resolve(),closePromise;
 const inFlight=new Set();
 const current=()=>{if(closed)fail('web_identity_transport_closed');if(now()>=expiresAt){if(!['completed','canceled'].includes(state))state='expired';fail('web_identity_context_expired');}assertCurrent();};
 const publicState=()=>({handoffId,navigationId,subjectId:context.subjectId,targetPath,expiresAt,state,revision,error,transportClosed:closed,
  operationId:offer?.operationId??null,deviceAuthorizationVerified:completed!==null,webConnectionReported:completed!==null,
  ...(signedContext?{context:signedContext}:{}),...(offer?{offer,fingerprint}:{}),...(approval?{approval}:{}),...(completed?{completed}:{})});
 const save=async()=>{revision++;await store.put(recordKey,{...publicState(),inputContext:context,nonce,offerHash,transportClosed:closed});};
 const serialize=fn=>{const result=mutation.then(fn);mutation=result.catch(()=>{});return result;};
 const envelope=(kind,payload)=>({protocol:webIdentityProtocol,version:1,handoffId,navigationId,kind,payload});
 const validateEnvelope=value=>{if(!exact(value,['protocol','version','handoffId','navigationId','kind','payload'])||value.protocol!==webIdentityProtocol
  ||value.version!==1||value.handoffId!==handoffId||value.navigationId!==navigationId)fail('web_identity_message_invalid');};
 async function accept(value){
  validateEnvelope(value);
  return serialize(async()=>{current();
   if(['canceled','completed','expired'].includes(state)){
    if(value.kind==='completed'&&completed&&stable(value.payload)===stable(completed.reported))return publicState();
    if(value.kind==='canceled'&&value.payload===null&&state==='canceled')return publicState();
    fail('web_identity_transport_finished');
   }
   if(value.kind==='ready'){
    if(!exact(value.payload,['nonce','existingDevice'])||!uuid(value.payload.nonce))fail('web_identity_nonce_invalid');
    const device=existingDevice(value.payload.existingDevice,context);
    if(nonce){if(nonce!==value.payload.nonce||stable(device)!==stable(browserDevice))fail('web_identity_browser_changed');return publicState();}
    await assertControl();current();await beforeApprove();current();
    const nextNonce=value.payload.nonce;
    const unsigned={endpoint:context.endpoint,website:context.website,subjectId:context.subjectId,
     controller:context.controller,scopes:context.scopes,expiresAt,targetPath,existingDevice:device};
    const payloadJson=JSON.stringify({protocol:webIdentityProtocol,version:1,handoffId,navigationId,nonce:nextNonce,bridgeOrigin:origin,context:unsigned});
    const signature=await signContext(payloadJson);current();await assertControl();current();
    if(typeof signature!=='string'||signature.length>16000)fail('web_identity_proof_invalid');
    nonce=nextNonce;browserDevice=device;signedContext={...unsigned,nonce,bridgeOrigin:origin,proof:{payloadJson,signature}};error=null;await save();return publicState();
   }
   if(value.kind==='offer'){
    if(!signedContext)fail('web_identity_context_required');
    const next=publicOffer(value.payload,context),nextHash=digest(next);
    if(offer){if(nextHash!==offerHash)fail('web_identity_offer_changed');return publicState();}
    await assertControl();current();
    const preview=await previewOffer(next);current();
    if(typeof preview?.fingerprint!=='string'||preview.fingerprint!==digestPublicKey(next.publicKeyPem))fail('web_identity_fingerprint_invalid');
    offer=next;offerHash=nextHash;fingerprint=preview.fingerprint;state='offered';error=null;await save();return publicState();
   }
   if(value.kind==='completed'){
    if(!signedContext)fail('web_identity_context_required');
    const reported=completion(value.payload);if(reported.subjectId!==context.subjectId)fail('web_identity_subject_changed');
    if(offer){
     if(!approval||reported.operationId!==offer.operationId||reported.deviceId!==offer.deviceId)fail('web_identity_original_operation_required');
    }else if(reported.operationId!==null||!browserDevice||browserDevice.deviceId!==reported.deviceId)fail('web_identity_original_device_required');
    const control=await readControl();current();
    const device=control.devices?.find(item=>item.device_id===reported.deviceId&&item.status==='active'&&item.epoch===control.epoch);
    if(control.authority!==context.endpoint||control.subjectId!==context.subjectId||control.epoch!==reported.epoch||control.chainHead!==reported.chainHead
     ||!device||context.scopes.some(scope=>!device.scopes.includes(scope)&&!device.scopes.includes('*'))
     ||offer&&(device.public_key!==offer.publicKeyPem||device.source_event_id!==offer.operationId)
     ||!offer&&(device.key_id!==browserDevice.keyId||digestPublicKey(device.public_key)!==browserDevice.keyId
      ||control.epoch!==context.controller.epoch||control.chainHead!==context.controller.chainHead))fail('web_identity_current_control_required');
    await beforeApprove();current();
    completed={reported,deviceAuthorizationVerified:true,webConnectionReported:true,websiteConnectionIndependentlyVerified:false,
     operationId:reported.operationId,subjectId:reported.subjectId,deviceId:reported.deviceId,epoch:control.epoch,chainHead:control.chainHead};
    state='completed';error=null;await save();return publicState();
   }
   if(value.kind==='canceled'&&value.payload===null){state='canceled';error=null;await save();return publicState();}
   fail('web_identity_message_kind_invalid');
  });
 }
 async function choose(action){
  return serialize(async()=>{current();
   if(action==='decline'){if(state==='completed')return publicState();state='canceled';error=null;await save();return publicState();}
   if(action!=='approve')fail('web_identity_choice_invalid');
   if(approval){await assertControl();current();return publicState();}
   if(state!=='offered'||!offer||!signedContext)fail('web_identity_offer_required');
   await assertControl();current();await beforeApprove();current();
   state='approving';error=null;await save();
   try{
    const next=await approveOffer(structuredClone(offer));current();
    if(!exact(next,['version','type','endpoint','offer','request','challenge','controllerSignature'])||next.version!==1||next.type!=='galaxy-device-approval'
     ||next.endpoint!==context.endpoint||digest(next.offer)!==offerHash||next.request?.subjectId!==context.subjectId
     ||next.request?.operationId!==offer.operationId||next.request?.expectedEpoch!==context.controller.epoch
     ||next.request?.previousEventHash!==context.controller.chainHead||next.request?.signerKeyId!==context.controller.keyId
     ||stable(next.request?.newDevice)!==stable({deviceId:offer.deviceId,publicKeyPem:offer.publicKeyPem,scopes:offer.scopes})
     ||/PRIVATE KEY|galaxy-recovery-v1:/.test(stable(next)))fail('web_identity_approval_changed');
    await assertControl();current();approval=structuredClone(next);state='approved';await save();return publicState();
   }catch(reason){error=codeOf(reason);if(!closed&&now()<expiresAt)state='offered';await save();throw reason;}
  });
 }
 function json(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));}
 async function body(req){
  let raw='',bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>28000)fail('web_identity_message_too_large');raw+=chunk.toString();}
  try{return JSON.parse(raw);}catch{fail('web_identity_message_invalid');}
 }
 const base='/connect/'+handoffId;
 async function handle(req,res){
  if(req.headers.host!==new URL(origin).host)return json(res,403,{error:'web_identity_local_host_required'});
  const path=req.url??'';
  if(path!==base&&path!==base+'/state'&&path!==base+'/message'&&path!==base+'/choice')return json(res,404,{error:'web_identity_local_path_required'});
  if(req.method==='GET'){
   if(path===base){current();const scriptNonce=randomBytes(18).toString('base64');
    const boot={protocol:webIdentityProtocol,version:1,handoffId,navigationId,website:context.website,subjectId:context.subjectId,endpoint:context.endpoint,expiresAt,scopeGroups:nativeIdentityScopeGroups(context.scopes),
     targetUrl:context.website+'/app/settings/identity?'+new URLSearchParams({agentConnect:handoffId,agentBridgeOrigin:origin,agentNavigation:navigationId,returnTo:targetPath})};
    const script='('+browserBridge.toString()+')('+JSON.stringify(boot).replaceAll('<','\\u003c')+');';
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'same-origin','x-content-type-options':'nosniff','x-frame-options':'DENY',
     'content-security-policy':"default-src 'none'; script-src 'nonce-"+scriptNonce+"'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>银河 · 接续已有身份</title><style>body{font:16px/1.65 system-ui;max-width:760px;margin:32px auto;padding:0 20px;background:#fafafa;color:#171717}button{font:inherit;padding:10px 16px;margin:8px}code{overflow-wrap:anywhere}li{margin:8px}h1{font-size:26px}</style><h1>让官网继续使用当前银河身份</h1><p>这次继续使用本机当前银河身份。</p><p>连接后：'+escape(targetDescription(targetPath))+'</p><p>当前服务 <code>'+escape(context.endpoint)+'</code></p><details><summary>准确身份与原目标</summary><p>银河身份 <code>'+escape(context.subjectId)+'</code></p><p>原页面 <code>'+escape(targetPath)+'</code></p></details><p>本机 Agent 保留私钥与原工作定位。官网生成自己的设备钥，只有你明确批准本次设备和权限后才接续。</p><button id="open">打开官网并接续同一身份</button><p id="progress" role="status">本次接续有效期三分钟。关闭窗口只停止传输，已提交的设备操作需查询原结果。</p><section id="offer" hidden><h2>批准官网本次新设备</h2><p>设备公钥指纹 <code id="fingerprint"></code></p><ul id="scopes"></ul><p>批准后，官网将验证公开批准，用自己的新钥完成同一身份接续并连接，然后回到原目标。此次操作不复制私钥、恢复码或原聊天。</p><button id="approve">批准这次显示的设备与权限</button><button id="decline">停止这次接续</button></section><script nonce="'+scriptNonce+'">'+script+'</script></html>');
    return;
   }
   if(path===base+'/state'){current();return json(res,200,publicState());}
   return json(res,405,{error:'web_identity_method_invalid'});
  }
  if(req.method!=='POST')return json(res,405,{error:'web_identity_method_invalid'});
  if(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'||req.headers['sec-fetch-site']==='same-site')return json(res,403,{error:'web_identity_local_origin_required'});
  if(path===base+'/message'){
   if(req.headers['content-type']?.split(';')[0]!=='application/json')return json(res,415,{error:'web_identity_content_type_invalid'});
   return json(res,200,await accept(await body(req)));
  }
  if(path===base+'/choice'){
   if(req.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded')return json(res,415,{error:'web_identity_content_type_invalid'});
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>100)fail('web_identity_message_too_large');}
   const form=new URLSearchParams(raw);if(form.size!==1)fail('web_identity_choice_invalid');
   return json(res,200,await choose(form.get('action')));
  }
  return json(res,405,{error:'web_identity_method_invalid'});
 }
 const server=createServer((req,res)=>{const operation=Promise.resolve().then(()=>handle(req,res)).catch(reason=>{error=codeOf(reason);if(!res.headersSent)json(res,409,{error});else res.end();});
  inFlight.add(operation);void operation.then(()=>inFlight.delete(operation),()=>inFlight.delete(operation));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const origin='http://127.0.0.1:'+server.address().port;server.unref();
 try{await save();}catch(reason){closed=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));throw reason;}
 async function close(){if(closePromise)return closePromise;closed=true;clearTimeout(timer);
  if(!['completed','canceled','expired'].includes(state))state='stopped';
  closePromise=Promise.resolve().then(async()=>{
   if(server.listening)await new Promise((resolve,reject)=>{server.close(reason=>reason?reject(reason):resolve());server.closeAllConnections();});
   await Promise.allSettled(inFlight);await mutation;await save();});return closePromise;}
 const timer=setTimeout(()=>{if(!['completed','canceled'].includes(state))state='expired';void close().catch(()=>{});},webIdentityTtlSeconds*1000);timer.unref();
 async function open(){current();const result=await openBrowser(origin+base);current();return{...publicState(),url:origin+base,launch:result??null,approvalRequired:state!=='completed',businessMutation:false,publicPacketsOnly:true};}
 return Object.freeze({open,status:()=>publicState(),close,origin,url:origin+base,envelope});
}
function digestPublicKey(publicKeyPem){return createHash('sha256').update(publicKeyPem).digest('hex');}
async function platformOpen(url){
 const command=process.platform==='win32'?'explorer.exe':process.platform==='darwin'?'open':'xdg-open';
 return new Promise(resolve=>{const child=spawn(command,[url],{windowsHide:true,detached:true,stdio:'ignore'});
  child.once('error',()=>resolve({state:'launch-failed',launched:false}));child.once('spawn',()=>{child.unref();resolve({state:'launch-requested',launched:true});});});
}
// Runs only in the temporary native page. Foreign windows never reach its
// same-origin HTTP actions; the website receives only these public packets.
function browserBridge(boot){
 let popup=null,lastApproval=null,lastContext=null,lastRevision=-1,ended=false,reading=false;
 const progress=document.getElementById('progress'),offerPanel=document.getElementById('offer');
 const base=location.pathname;
 const compareKeys=(a,b)=>a<b?-1:a>b?1:0;
 const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort(compareKeys).join(',')===[...keys].sort(compareKeys).join(',');
 const envelope=(kind,payload)=>({protocol:boot.protocol,version:boot.version,handoffId:boot.handoffId,navigationId:boot.navigationId,kind,payload});
 const send=(kind,payload)=>{if(!ended&&popup&&!popup.closed)popup.postMessage(envelope(kind,payload),boot.website);};
 async function request(path,body,contentType='application/json'){
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':contentType},body:contentType==='application/json'?JSON.stringify(body):body})});
  const value=await response.json();if(!response.ok){send('error',{code:value.error});throw new Error(value.error);}return value;
 }
 function render(value){
  if(ended||!Number.isSafeInteger(value.revision)||value.revision<lastRevision)return;lastRevision=value.revision;
  if(value.context&&JSON.stringify(value.context)!==lastContext){lastContext=JSON.stringify(value.context);send('context',value.context);}
  if(value.offer){offerPanel.hidden=value.state!=='offered';document.getElementById('fingerprint').textContent=value.fingerprint??'';
   const scopes=document.getElementById('scopes');scopes.replaceChildren(...boot.scopeGroups.map(group=>{const items=group.items.filter(item=>value.offer.scopes.includes(item.key));if(!items.length)return null;const li=document.createElement('li'),title=document.createElement('strong'),body=document.createElement('span');title.textContent=group.title+'：';body.textContent=items.map(item=>item.label).join('、');li.append(title,body);return li;}).filter(Boolean));}
  if(value.approval&&JSON.stringify(value.approval)!==lastApproval){lastApproval=JSON.stringify(value.approval);send('approval',value.approval);}
  if(value.state==='completed'){ended=true;offerPanel.hidden=true;progress.textContent='同一身份的当前设备授权已核对。官网报告已连接并将返回原目标；请回原 Agent 刷新同一对象。';}
  else if(['stopped','canceled','expired'].includes(value.state)){send('stopped',{state:value.state});ended=true;offerPanel.hidden=true;progress.textContent='本次传输已停止。原设备操作仍需按原编号核对，关闭窗口不会撤销已完成授权。';}
  else if(value.error)progress.textContent='接续暂未完成。请保留原操作，回到 Agent 核对当前控制和原目标。';
  else if(value.state==='approved')progress.textContent='公开批准已送回官网。官网正在核对自己的原申请与当前控制，尚不能把等待显示为已接续。';
  else if(value.state==='offered')progress.textContent='请核对本次官网设备和权限，明确批准后才会继续。';
  else progress.textContent='等待官网提出本次公开设备申请，或核对其已保存的同一身份。';
 }
 document.getElementById('open').onclick=()=>{if(ended)return;if(popup&&!popup.closed){popup.focus();return;}
  popup=window.open(boot.targetUrl,'galaxy-identity-'+boot.handoffId);if(!popup)progress.textContent='浏览器未打开接续页。允许本次弹出窗口后重试；不会创建新身份。';};
 async function receive(event){
  if(ended||event.origin!==boot.website||event.source!==popup||!exact(event.data,['protocol','version','handoffId','navigationId','kind','payload']))return;
  const value=event.data;if(value.protocol!==boot.protocol||value.version!==boot.version||value.handoffId!==boot.handoffId||value.navigationId!==boot.navigationId)return;
  if(!['ready','offer','completed','canceled'].includes(value.kind))return;
  try{render(await request('/message',value));}catch{progress.textContent='接续暂未完成。保留原操作，回到 Agent 核对；请勿新建替代身份。';}
 }
 window.addEventListener('message',receive);
 for(const action of ['approve','decline'])document.getElementById(action).onclick=async()=>{const button=document.getElementById(action);button.disabled=true;
  try{render(await request('/choice','action='+action,'application/x-www-form-urlencoded'));}catch{progress.textContent='当前接续未取得确认结果。保留原申请，回原 Agent 核对。';}finally{button.disabled=false;}};
 const timer=setInterval(async()=>{if(ended||reading)return;reading=true;
  try{
   if(popup?.closed){render(await request('/message',envelope('canceled',null)));return;}
   render(await request('/state'));
  }catch{ended=true;offerPanel.hidden=true;progress.textContent='本机接续窗口已停止或过期。原操作仍可在原设备查询，不能据此认定远端已取消。';}
  finally{reading=false;if(ended){clearInterval(timer);window.removeEventListener('message',receive);}}
 },500);
 window.addEventListener('pagehide',()=>{ended=true;clearInterval(timer);window.removeEventListener('message',receive);});
}
