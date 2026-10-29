import {browserScopes} from "../../../../galaxy-client/src/browser-client.mjs";
import {fromBase64Url,identityKeyId} from "../../../../galaxy-contracts/src/identity/identity-material.mjs";

const protocol='galaxy-web-identity-handoff',proofType='galaxy-web-identity-handoff-v1+jws';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const guid=value=>typeof value==='string'&&/^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const keyOrder=(left,right)=>left<right?-1:left>right?1:0;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort(keyOrder).join(',')===[...keys].sort(keyOrder).join(',');
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const failure=code=>Object.assign(new Error(code),{code});
const fail=code=>{throw failure(code);};
const scopeNames=new Set(['manage-identity',...browserScopes]);
const covers=(granted,requested)=>Array.isArray(granted)&&requested.every(scope=>granted.includes('*')||granted.includes(scope));
const owner=value=>value?.identity?`${value.identity.subjectId}:${value.identity.deviceId}`:null;

export function agentIdentityReturnPath(value,origin){
 if(typeof value!=='string'||value.length>2048||!value.startsWith('/')||value.startsWith('//')||value.includes('\\')||Array.from(value).some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127))return null;
 try{const target=new URL(value,origin);
  if(target.origin!==origin||!(target.pathname==='/app'||target.pathname.startsWith('/app/'))
   ||/^\/app\/settings\/identity(?:\/|$)/.test(target.pathname)&&target.pathname+target.search+target.hash!=='/app/settings/identity?section=account')return null;
  return target.pathname+target.search+target.hash;
 }catch{return null;}
}

export function capsuleIdentityContinuation(taskId,capsuleId,versionId){
 if(!uuid(taskId)||!uuid(capsuleId)||!uuid(versionId))return null;
 return `/app/capsules/${capsuleId}/versions/${versionId}?`+new URLSearchParams({sourceTask:taskId,returnTo:`/app/tasks/${taskId}?section=collaboration`});
}

export function methodSearchIdentityContinuation(taskId,query){
 if(!uuid(taskId)||typeof query!=='string'||!query.trim()||query!==query.trim()||query.length>200
  ||Array.from(query).some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127))return null;
 return '/app/search?'+new URLSearchParams({q:query,sourceTask:taskId,returnTo:`/app/tasks/${taskId}?section=collaboration`});
}

// Query values locate an already opened local bridge. They never choose the API,
// a public key, an identity, or a credential destination.
export function readAgentIdentityEntry(location){
 const query=new URLSearchParams(location.search),names=['agentConnect','agentBridgeOrigin','agentNavigation','returnTo'];
 if(!names.slice(0,3).some(name=>query.has(name)))return null;
 try{
  if(location.pathname!=='/app/settings/identity'||names.some(name=>query.getAll(name).length!==1))throw 0;
  const handoffId=query.get('agentConnect'),navigationId=query.get('agentNavigation'),bridgeOrigin=query.get('agentBridgeOrigin');
  const bridge=new URL(bridgeOrigin),port=Number(bridge.port),targetPath=agentIdentityReturnPath(query.get('returnTo'),location.origin);
  if(!uuid(handoffId)||!uuid(navigationId)||bridge.protocol!=='http:'||bridge.hostname!=='127.0.0.1'||!Number.isInteger(port)||port<1||port>65535
   ||bridge.origin!==bridgeOrigin||bridge.username||bridge.password||bridge.pathname!=='/'||bridge.search||bridge.hash||!targetPath)throw 0;
  const target=new URL(targetPath,location.origin),method=/^\/app\/capsules\/([^/]+)\/versions\/([^/]+)$/.exec(target.pathname);
  if(method&&(target.search||target.hash)&&targetPath!==capsuleIdentityContinuation(target.searchParams.get('sourceTask'),method[1],method[2]))throw 0;
  if(target.pathname==='/app/search'&&(target.searchParams.has('sourceTask')||target.searchParams.has('returnTo'))
   &&targetPath!==methodSearchIdentityContinuation(target.searchParams.get('sourceTask'),target.searchParams.get('q')))throw 0;
  return Object.freeze({valid:true,handoffId,navigationId,bridgeOrigin,targetPath,website:location.origin});
 }catch{return Object.freeze({valid:false,code:'agent_handoff_entry_invalid'});}
}

function publicPacket(value){
 let encoded;try{encoded=JSON.stringify(value);}catch{fail('agent_handoff_packet_invalid');}
 if(typeof encoded!=='string'||encoded.length>32768||/PRIVATE KEY|galaxy-recovery-v1:/.test(encoded))fail('agent_handoff_packet_invalid');
 return value;
}

function contextPayload(value,entry,nonce,existingDevice,endpoint,now){
 if(!exact(value,['endpoint','website','subjectId','controller','scopes','expiresAt','targetPath','existingDevice','nonce','bridgeOrigin','proof'])
  ||value.endpoint!==endpoint||value.website!==entry.website||!guid(value.subjectId)||value.nonce!==nonce||value.bridgeOrigin!==entry.bridgeOrigin
  ||value.targetPath!==entry.targetPath||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||value.expiresAt>now+180
  ||!exact(value.controller,['deviceId','keyId','epoch','chainHead'])||!uuid(value.controller.deviceId)||!digest(value.controller.keyId)
  ||!Number.isSafeInteger(value.controller.epoch)||value.controller.epoch<1||!digest(value.controller.chainHead)
  ||!Array.isArray(value.scopes)||!value.scopes.length||value.scopes.length>64||new Set(value.scopes).size!==value.scopes.length
  ||value.scopes.some(scope=>!scopeNames.has(scope))||!value.scopes.includes('binding')
  ||!same(value.existingDevice,existingDevice)
  ||!exact(value.proof,['payloadJson','signature'])||typeof value.proof.payloadJson!=='string'||typeof value.proof.signature!=='string')fail('agent_handoff_context_invalid');
 const context={endpoint:value.endpoint,website:value.website,subjectId:value.subjectId,
  controller:{deviceId:value.controller.deviceId,keyId:value.controller.keyId,epoch:value.controller.epoch,chainHead:value.controller.chainHead},
  scopes:[...value.scopes],expiresAt:value.expiresAt,targetPath:value.targetPath,existingDevice};
 const payloadJson=JSON.stringify({protocol,version:1,handoffId:entry.handoffId,navigationId:entry.navigationId,nonce,bridgeOrigin:entry.bridgeOrigin,context});
 if(payloadJson!==value.proof.payloadJson)fail('agent_handoff_proof_changed');
 return {context,payloadJson,signature:value.proof.signature};
}

function currentDevice(control,subjectId,deviceId,endpoint){
 if(control?.authority!==endpoint||control.subjectId!==subjectId||!Number.isSafeInteger(control.epoch)||control.epoch<1||!digest(control.chainHead)||!Array.isArray(control.devices))fail('agent_handoff_control_invalid');
 const device=control.devices.find(row=>row.device_id===deviceId&&row.status==='active'&&row.epoch===control.epoch);
 if(!device||typeof device.public_key!=='string'||!Array.isArray(device.scopes))fail('agent_handoff_device_not_current');
 return device;
}

async function verifyContextProof(proof,control,endpoint,crypto){
 const {context,payloadJson,signature}=proof,expected=context.controller;
 const device=currentDevice(control,context.subjectId,expected.deviceId,endpoint);
 if(control.epoch!==expected.epoch||control.chainHead!==expected.chainHead||device.key_id!==expected.keyId
  ||!covers(device.scopes,context.scopes)||!covers(device.scopes,['manage-identity'])||await identityKeyId(device.public_key,{crypto})!==expected.keyId)fail('agent_handoff_control_changed');
 try{
  const parts=signature.split('.');if(parts.length!==3)throw 0;
  const header=JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
  if(!exact(header,['alg','typ'])||header.alg!=='Ed25519'||header.typ!==proofType||new TextDecoder().decode(fromBase64Url(parts[1]))!==payloadJson)throw 0;
  const der=Uint8Array.from(atob(device.public_key.replace(/-----[^-]+-----|\s/g,'')),character=>character.charCodeAt(0));
  const key=await crypto.subtle.importKey('spki',der,{name:'Ed25519'},false,['verify']);
  if(!await crypto.subtle.verify('Ed25519',key,fromBase64Url(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1])))throw 0;
 }catch{fail('agent_handoff_proof_invalid');}
 return context;
}

// The transport carries only existing public device packages and a narrowly
// scoped native possession proof. The existing device-handoff runtime owns keys,
// approval validation, exact-operation receipts, and activation.
export function createAgentIdentityHandoff({runtime,entry,window:host=globalThis.window,now=()=>Math.floor(Date.now()/1000),crypto=globalThis.crypto,onUpdate=()=>{},onConnected=/** @type {(result:{subjectId:string,deviceId:string,targetPath:string,operationId:string|null})=>unknown} */(()=>{})}){
 let alive=true,started=false,done=false,context=null,offer=null,approvedScopes=null,expectedOwner,lease=null,localSelection=null;
 let deadline=now()+180,timer=null,serial=Promise.resolve(),contextMessage=null,approvalMessage=null,existingDevice=null,ready=false;
 const source=host?.opener,nonce=crypto.randomUUID();
 let snapshot={phase:'waiting',context:null,operationId:null,fingerprint:null,code:null};
 const update=values=>{if(alive){snapshot={...snapshot,...values};onUpdate({...snapshot});}};
 const envelope=(kind,payload)=>({protocol,version:1,handoffId:entry.handoffId,navigationId:entry.navigationId,kind,payload});
 function send(kind,payload){if(!source||source.closed||host.opener!==source)fail('agent_handoff_opener_lost');source.postMessage(publicPacket(envelope(kind,payload)),entry.bridgeOrigin);}
 function assertLive(){
  if(!alive||done)fail('agent_handoff_stopped');
  if(!source||source.closed||host.opener!==source)fail('agent_handoff_opener_lost');
  if(now()>=deadline)fail('agent_handoff_expired');
  lease?.assertCurrent();
 }
 async function wait(action){assertLive();const value=await action();assertLive();return value;}
 async function status(){const value=await wait(()=>runtime.status());if(expectedOwner!==undefined&&owner(value)!==expectedOwner)fail('agent_handoff_browser_identity_changed');return value;}
 function capture(){lease=runtime.receiptStatus?.captureLease?.()??null;}
 function cleanup(){if(timer!==null)host.clearInterval(timer);timer=null;host.removeEventListener('message',receive);}
 function stop(code='agent_handoff_stopped',notify=false){
  if(!alive||done)return;
  if(notify)try{send('canceled',null);}catch{}
  lease=null;update({phase:code==='agent_handoff_expired'?'expired':'stopped',code});alive=false;cleanup();
 }
 async function complete(operationId){
  let state=await status();if(!state.identity||state.identity.subjectId!==context.subjectId)fail('agent_handoff_browser_identity_changed');
  const deviceId=state.identity.deviceId,control=await wait(()=>runtime.publicControl(context.subjectId));
  const device=currentDevice(control,context.subjectId,deviceId,runtime.api.endpoint),required=approvedScopes??context.scopes;
  if(!covers(device.scopes,required))fail('agent_handoff_scopes_changed');
  if(offer&&device.public_key!==offer.publicKeyPem)fail('agent_handoff_device_not_current');
  if(operationId===null&&(control.epoch!==context.controller.epoch||control.chainHead!==context.controller.chainHead))fail('agent_handoff_control_changed');
  const connectionScopes=required.filter(scope=>scope!=='manage-identity');
  if(!state.connection||state.connection.subjectId!==context.subjectId||state.connection.endpoint!==runtime.api.endpoint
   ||state.connection.control?.deviceId!==deviceId||state.connection.control?.epoch!==control.epoch||!covers(state.connection.scopes,connectionScopes)){
   update({phase:'connecting'});assertLive();lease=null;
   await wait(()=>runtime.connect({confirmed:true}));state=await status();capture();
  }
  if(state.connection?.subjectId!==context.subjectId||state.connection.endpoint!==runtime.api.endpoint||state.connection.control?.deviceId!==deviceId
   ||state.connection.control?.epoch!==control.epoch||!covers(state.connection.scopes,connectionScopes))fail('agent_handoff_connection_not_current');
  const fresh=await wait(()=>runtime.publicControl(context.subjectId)),current=currentDevice(fresh,context.subjectId,deviceId,runtime.api.endpoint);
  if(!covers(current.scopes,required)||(offer&&current.public_key!==offer.publicKeyPem)
   ||operationId===null&&(fresh.epoch!==context.controller.epoch||fresh.chainHead!==context.controller.chainHead))fail('agent_handoff_control_changed');
  await wait(()=>runtime.agentContinuity.requireCurrent());await status();assertLive();send('completed',{operationId,subjectId:context.subjectId,deviceId,epoch:fresh.epoch,chainHead:fresh.chainHead,connected:true});
  update({phase:'connected',operationId});done=true;lease=null;cleanup();
  await onConnected({subjectId:context.subjectId,deviceId,targetPath:context.targetPath,operationId});
 }
 async function receiveContext(payload){
  if(contextMessage){if(!same(contextMessage,payload))fail('agent_handoff_context_changed');return;}
  contextMessage=structuredClone(payload);update({phase:'verifying-native'});
  const proof=contextPayload(payload,entry,nonce,existingDevice,runtime.api.endpoint,now());deadline=proof.context.expiresAt;
  const initial=await status();expectedOwner=owner(initial);
  if(initial.identity&&initial.identity.subjectId!==proof.context.subjectId)fail('device_identity_switch_required');
  if(initial.identity)capture();
  const control=await wait(()=>runtime.publicControl(proof.context.subjectId));
  context=await wait(()=>verifyContextProof(proof,control,runtime.api.endpoint,crypto));update({context});
  const pending=await wait(()=>runtime.deviceHandoff.pending()),unresolved=pending&&!['canceled','expired','committed'].includes(pending.state);
  if(unresolved&&(pending.approval||initial.identity))fail('agent_handoff_original_result_pending');
  // A same-ID shortcut still needs the fresh native nonce proof above and this
  // browser's independently authorized current device; neither side self-attests.
  if(initial.identity){
   const own=currentDevice(control,context.subjectId,initial.identity.deviceId,runtime.api.endpoint);
   if(context.existingDevice?.subjectId!==context.subjectId||context.existingDevice.deviceId!==initial.identity.deviceId||context.existingDevice.keyId!==own.key_id)fail('agent_handoff_proof_changed');
   if(covers(own.scopes,context.scopes)){
    await wait(()=>runtime.agentContinuity.retainHandoff({handoffId:entry.handoffId,navigationId:entry.navigationId,context:contextMessage,offer:null,approval:null}));
    return complete(null);
   }
   // Core authorizes a distinct device; it never enlarges an existing key's
   // scopes. Preserve the current device/connection until explicit Native
   // approval commits the same GUID's newly generated browser device.
   update({additionalDeviceApproval:true});
  }
  update({phase:'preparing'});await status();
  offer=await wait(()=>runtime.deviceHandoff.createOffer(context.subjectId,{scopes:context.scopes,confirmed:true}));
  await status();const preview=await wait(()=>runtime.deviceHandoff.previewOffer(offer));
  if(offer.subjectId!==context.subjectId||offer.endpoint!==runtime.api.endpoint||!same(offer.scopes,context.scopes)||initial.identity&&offer.deviceId===initial.identity.deviceId)fail('agent_handoff_offer_changed');
  send('offer',offer);update({phase:'awaiting-approval',operationId:offer.operationId,fingerprint:preview.fingerprint});
 }
 async function receiveApproval(payload){
  if(!context||!offer||payload?.offer?.operationId!==offer.operationId||!same(payload.offer,offer))fail('agent_handoff_approval_changed');
  if(approvalMessage){if(!same(approvalMessage,payload))fail('agent_handoff_approval_changed');return;}
  approvalMessage=structuredClone(payload);await status();update({phase:'accepting'});
  const preview=await wait(()=>runtime.deviceHandoff.previewApproval(payload));
  if(preview.subjectId!==context.subjectId||preview.operationId!==offer.operationId||preview.deviceId!==offer.deviceId)fail('agent_handoff_approval_changed');
  approvedScopes=[...preview.scopes];await status();
  await wait(()=>runtime.agentContinuity.retainHandoff({handoffId:entry.handoffId,navigationId:entry.navigationId,context:contextMessage,offer,approval:payload}));assertLive();lease=null;
  const result=await wait(()=>runtime.deviceHandoff.acceptApproval(payload,{confirmed:true}));
  if(result.needsLocalDeviceSelection){
   await status();
   const selection=await wait(()=>runtime.deviceHandoff.previewLocalDeviceSelection(offer.operationId));
   if(selection.endpoint!==runtime.api.endpoint||selection.subjectId!==context.subjectId||selection.operationId!==offer.operationId
    ||selection.deviceId!==offer.deviceId||`${selection.subjectId}:${selection.previousDeviceId}`!==expectedOwner
    ||!same(selection.scopes,approvedScopes))fail('agent_handoff_approval_changed');
   localSelection=selection;capture();update({phase:'choose-device',localDeviceSelection:selection});return;
  }
  if(!result.activated&&!result.alreadyActivated)fail('agent_handoff_original_result_pending');
  expectedOwner=`${context.subjectId}:${offer.deviceId}`;await status();capture();await wait(()=>runtime.agentContinuity.retainReceipt(result.receipt));
  return complete(offer.operationId);
 }
 function selectLocalDevice(){
  serial=serial.then(async()=>{
   if(snapshot.phase!=='choose-device'||!localSelection)return;
   assertLive();await status();const selection=localSelection;update({phase:'selecting-device'});lease=null;
   const result=await wait(()=>runtime.deviceHandoff.selectLocalDevice(selection,{confirmed:true}));
   if((!result.activated&&!result.alreadyActivated)||result.identity?.subjectId!==context.subjectId||result.identity?.deviceId!==offer.deviceId)fail('agent_handoff_browser_identity_changed');
   expectedOwner=`${context.subjectId}:${offer.deviceId}`;await status();capture();await wait(()=>runtime.agentContinuity.retainReceipt(result.receipt));
   localSelection=null;update({localDeviceSelection:null});await complete(offer.operationId);
  }).catch(reason=>{if(alive&&!done)stop(typeof reason?.code==='string'?reason.code:'agent_handoff_failed');});
  return serial;
 }
 function receive(event){
  if(!alive||done||event.source!==source||event.origin!==entry.bridgeOrigin)return;
  let message;try{message=publicPacket(event.data);}catch{return;}
  if(!exact(message,['protocol','version','handoffId','navigationId','kind','payload'])||message.protocol!==protocol||message.version!==1
   ||message.handoffId!==entry.handoffId||message.navigationId!==entry.navigationId)return;
  if(message.kind==='stopped'&&exact(message.payload,['state'])&&typeof message.payload.state==='string'){stop('agent_handoff_native_stopped');return;}
  if(message.kind==='error'&&exact(message.payload,['code'])&&typeof message.payload.code==='string'){
   stop(['web_identity_existing_device_control_required','web_identity_existing_device_invalid'].includes(message.payload.code)?'agent_handoff_existing_device_mismatch':'agent_handoff_native_error');return;
  }
  if(!['context','approval'].includes(message.kind))return;
  const value=structuredClone(message.payload);
  serial=serial.then(()=>{assertLive();return message.kind==='context'?receiveContext(value):receiveApproval(value);})
   .catch(reason=>{if(alive&&!done)stop(typeof reason?.code==='string'?reason.code:'agent_handoff_failed');});
 }
 function start(){
  if(started)return;started=true;
  if(!entry?.valid){stop(entry?.code??'agent_handoff_entry_invalid');return;}
  host.addEventListener('message',receive);
  serial=(async()=>{
   const initial=await status();expectedOwner=owner(initial);
   if(initial.identity){
    capture();const control=await wait(()=>runtime.publicControl(initial.identity.subjectId));
    const device=currentDevice(control,initial.identity.subjectId,initial.identity.deviceId,runtime.api.endpoint),keyId=await wait(()=>identityKeyId(device.public_key,{crypto}));
    if(keyId!==device.key_id)fail('agent_handoff_control_invalid');
    existingDevice={subjectId:initial.identity.subjectId,deviceId:initial.identity.deviceId,keyId};
   }
   await status();send('ready',{nonce,existingDevice});ready=true;update({phase:'waiting'});
  })().catch(reason=>stop(reason.code??'agent_handoff_failed'));
  timer=host.setInterval(()=>{try{assertLive();if(ready&&!contextMessage)send('ready',{nonce,existingDevice});}catch(reason){stop(reason.code??'agent_handoff_failed');}},1000);
 }
 return Object.freeze({start,selectLocalDevice,cancel:()=>stop('agent_handoff_stopped',true),close:()=>{if(!done)stop('agent_handoff_stopped',true);else{alive=false;cleanup();}},snapshot:()=>({...snapshot})});
}
