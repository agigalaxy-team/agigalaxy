import {createDeviceMaterial,identityKeyId,signIdentityPayload,fromBase64Url} from './identity-material.mjs';
import {createIdentityControlClient} from './identity-control-client.mjs';

const same=(a,b)=>JSON.stringify(a,sort)===JSON.stringify(b,sort);
function sort(_key,value){return value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value;}
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort((left,right)=>left<right?-1:left>right?1:0).join(',');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const subject=value=>typeof value==='string'&&/^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(value);
const fail=(code)=>{throw Object.assign(new Error(code),{code});};
function unpack(value){if(typeof value==='string'){if(value.length>24000)fail('device_handoff_too_large');try{value=JSON.parse(value);}catch{fail('device_handoff_invalid');}}
 if(/PRIVATE KEY|galaxy-recovery-v1:/.test(JSON.stringify(value)))fail('device_handoff_private_material');return structuredClone(value);}
async function verifySignature(jws,payload,publicKeyPem,crypto){
 try{const parts=jws.split('.');if(parts.length!==3)throw 0;
  const header=JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
  if(!exact(header,['alg','typ'])||header.alg!=='Ed25519'||header.typ!=='galaxy-identity-control-v2+jws'
   ||new TextDecoder().decode(fromBase64Url(parts[1]))!==payload)throw 0;
  const der=Uint8Array.from(atob(publicKeyPem.replace(/-----[^-]+-----|\s/g,'')),c=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey('spki',der,{name:'Ed25519'},false,['verify']);
  if(!await crypto.subtle.verify('Ed25519',key,fromBase64Url(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1])))throw 0;
 }catch{fail('device_approval_signature_invalid');}
}
const handoffQueues=new WeakMap();

// Public transfer only. The runtime supplies its private local store and an
// activation callback; neither a URL nor a transferred package selects an API.
export function createIdentityDeviceHandoff({endpoint,send,store,getActive,activate,allowedScopes,captureLease,captureApprovalLease,now=()=>Math.floor(Date.now()/1000),crypto=globalThis.crypto,createDevice=()=>createDeviceMaterial({crypto})}){
 const url=new URL(endpoint);if(url.protocol!=='https:'||url.origin!==endpoint||url.username||url.password||!Array.isArray(allowedScopes)
  ||typeof send!=='function'||typeof store?.get!=='function'||typeof store?.put!=='function'||typeof getActive!=='function'||typeof activate!=='function')fail('device_handoff_configuration_invalid');
 const allowed=new Set(['manage-identity',...allowedScopes]);
 const key=id=>`identity-handoff:${endpoint}:${id}`,pendingKey=`identity-handoff:${endpoint}:pending`;
 const opKey=id=>`identity-operation:${endpoint}:${id}`;
 if(!handoffQueues.has(store))handoffQueues.set(store,new Map());const queues=handoffQueues.get(store);
 const localSelections=new WeakMap();
 async function ownerLease(approvalLease=null){
  const runtimeLease=captureLease?.(),checkRuntime=()=>{
   for(const value of [approvalLease,runtimeLease])if(value){const check=value.assertCurrent??value.check;if(typeof check!=='function')fail('device_handoff_lease_invalid');check.call(value);}
  };
  checkRuntime();const owner=await getActive();checkRuntime();const original=JSON.stringify(owner??null,sort);
  const check=async()=>{checkRuntime();const current=await getActive();checkRuntime();if(JSON.stringify(current??null,sort)!==original)fail('device_handoff_owner_changed');};
  await check();return{owner,check,async wait(action){await check();let result;try{result=await action();}catch(error){await check();throw error;}await check();return result;}};
 }
 function serial(action,approvalRead=false){
  // Capture before waiting for another local operation. Blank joining browsers
  // have an owner lease too; selecting any identity invalidates that old turn.
  const lease=ownerLease(approvalRead?captureApprovalLease?.():null),work=async()=>{const captured=await lease;await captured.check();return action(captured);};void lease.catch(()=>{});
  const result=(queues.get(endpoint)??Promise.resolve()).then(work,work),tail=result.catch(()=>{});queues.set(endpoint,tail);
  void tail.then(()=>{if(queues.get(endpoint)===tail)queues.delete(endpoint);});return result;
 }
 const call=(lease,name,input)=>lease.wait(()=>send(`${endpoint}/v2/identity/control/${name}`,{method:'POST',bodyJson:JSON.stringify(input)}));
 async function state(subjectId,lease){const value=await lease.wait(()=>send(`${endpoint}/v2/identity/${subjectId}/control`,{method:'GET'}));
  if(value?.authority!==endpoint||value.subjectId!==subjectId||!Array.isArray(value.devices)||!Number.isSafeInteger(value.epoch)||value.epoch<1)fail('device_control_state_invalid');return value;}
 function scopes(value){if(!Array.isArray(value)||!value.length||value.length>64||new Set(value).size!==value.length||value.some(s=>!allowed.has(s))||!value.includes('binding'))fail('device_scopes_invalid');return [...value];}
 function offer(input){const value=unpack(input);
  if(!exact(value,['version','type','endpoint','subjectId','operationId','deviceId','publicKeyPem','scopes'])||value.version!==1||value.type!=='galaxy-device-request'
   ||value.endpoint!==endpoint||!subject(value.subjectId)||!uuid(value.operationId)||!uuid(value.deviceId)||typeof value.publicKeyPem!=='string'
   ||value.publicKeyPem.length>256||!value.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----'))fail('device_request_invalid');scopes(value.scopes);return value;}
 function approval(input){const value=unpack(input);
  if(!exact(value,['version','type','endpoint','offer','request','challenge','controllerSignature'])||value.version!==1||value.type!=='galaxy-device-approval'
   ||value.endpoint!==endpoint||typeof value.challenge!=='string'||typeof value.controllerSignature!=='string')fail('device_approval_invalid');
  value.offer=offer(value.offer);const r=value.request;
  if(!exact(r,['version','operationId','subjectId','kind','expectedEpoch','previousEventHash','signerKeyId','newDevice'])||r.version!==2||r.kind!=='authorize-device'
   ||r.operationId!==value.offer.operationId||r.subjectId!==value.offer.subjectId||!exact(r.newDevice,['deviceId','publicKeyPem','scopes'])
   ||r.newDevice.deviceId!==value.offer.deviceId||r.newDevice.publicKeyPem!==value.offer.publicKeyPem
   ||scopes(r.newDevice.scopes).some(s=>!value.offer.scopes.includes(s)))fail('device_approval_changed_request');
  let c;try{c=JSON.parse(value.challenge);}catch{fail('device_challenge_invalid');}
  if(!exact(c,['version','type','audience','request','nonce','expiresAt'])||c.version!==2||c.type!=='identity-control'||c.audience!==endpoint
   ||!same(c.request,r)||typeof c.nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(c.nonce)||!Number.isSafeInteger(c.expiresAt))fail('device_challenge_changed');return value;
 }
 async function localRecord(input,lease){const value=approval(input),record=await lease.wait(()=>store.get(key(value.offer.operationId)));
  if(!record||!same(record.offer,value.offer))fail('device_request_not_owned');
  const material=await lease.wait(()=>store.get(`device:${value.offer.subjectId}:${value.offer.deviceId}`));if(!material||material.publicKeyPem!==value.offer.publicKeyPem)fail('device_key_unavailable');
  const current=lease.owner;if(current&&current.subjectId!==value.offer.subjectId)fail('device_identity_switch_required');return{value,record,material};}
 async function inspect(input,lease){const {value}=await localRecord(input,lease),current=await state(value.offer.subjectId,lease),request=value.request;
  const signer=current.devices.find(d=>d.key_id===request.signerKeyId&&d.status==='active'&&d.epoch===current.epoch);
  if(current.epoch!==request.expectedEpoch||current.chainHead!==request.previousEventHash||!signer||!signer.scopes.some(s=>s==='manage-identity'||s==='*'))fail('device_approval_control_changed');
  await lease.wait(()=>verifySignature(value.controllerSignature,value.challenge,signer.public_key,crypto));
  const challenge=JSON.parse(value.challenge);if(challenge.expiresAt<=now()||challenge.expiresAt>now()+180)fail('device_approval_expired');
  return {subjectId:request.subjectId,deviceId:request.newDevice.deviceId,endpoint,scopes:request.newDevice.scopes,
   fingerprint:await lease.wait(()=>identityKeyId(request.newDevice.publicKeyPem,{crypto})),expiresAt:challenge.expiresAt,operationId:request.operationId};
 }
 function client(value,material,lease,{original=null,readOnly=false}={}){
  const immutable=record=>JSON.stringify([record?.request,record?.challenge,record?.commit??null],sort),expected=original?immutable(original):null;
  return createIdentityControlClient({endpoint,now,send:(...args)=>lease.wait(()=>send(...args)),
   store:{get:async name=>{const record=await lease.wait(()=>store.get(name));if(expected&&name===opKey(value.offer.operationId)&&immutable(record)!==expected)fail('device_handoff_original_changed');return record;},
    put:async(name,record)=>{if(expected&&name===opKey(value.offer.operationId)&&immutable(record)!==expected)fail('device_handoff_original_changed');
     if(expected){const current=await lease.wait(()=>store.get(name));if(immutable(current)!==expected)fail('device_handoff_original_changed');}
     return lease.wait(()=>store.put(name,record));}},
   signController:async()=>{if(readOnly)fail('device_handoff_new_signature_not_allowed');await lease.check();return value.controllerSignature;},
   signNewDevice:challenge=>{if(readOnly)fail('device_handoff_new_signature_not_allowed');return lease.wait(()=>signIdentityPayload(challenge,material.privateKey,{crypto}));}});
 }
 async function finish(receipt,record,lease){
  if(receipt.state!=='committed')return {receipt,activated:false};
  if(['canceled','expired'].includes(record.state))return{receipt,activated:false,localState:record.state};
  const current=await state(record.offer.subjectId,lease),device=current.devices.find(d=>d.device_id===record.offer.deviceId);
  if(!device||device.status!=='active'||device.epoch!==current.epoch||device.public_key!==record.offer.publicKeyPem
   ||record.approval?.request.expectedEpoch!==current.epoch||receipt.epoch!==current.epoch
   ||!device.scopes.some(scope=>scope==='binding'||scope==='*'))fail('device_authorization_no_longer_current');
  const active=lease.owner;if(active&&active.subjectId!==record.offer.subjectId)fail('device_identity_switch_required');
  if(active&&active.deviceId!==record.offer.deviceId){
   // Remote authorization did not select a different device on this browser.
   // Keep the exact operation pending until its owner makes that local choice.
   if(record.state!=='committed')await lease.wait(()=>store.put(key(record.offer.operationId),{...record,state:'awaiting-result',receipt}));
   return{receipt,identity:{subjectId:record.offer.subjectId,deviceId:record.offer.deviceId},activated:false,
    needsLocalDeviceSelection:true,connectionRequired:false,dataRecovery:'separate/not-performed'};
  }
  const identity={subjectId:record.offer.subjectId,genesisProof:current.genesisProof,deviceId:record.offer.deviceId,installationId:record.installationId};
  if(record.state==='committed'){
   // A completed receipt is history, not a selection of the browser's current
   // identity. Reading it never reactivates a lost selection or reconnects a
   // deliberately disconnected device.
   return{receipt,identity:{subjectId:identity.subjectId,deviceId:identity.deviceId},activated:false,alreadyActivated:!!active,
    needsLocalActivation:!active,connectionRequired:false,dataRecovery:'separate/not-performed'};
  }
  if(active?.subjectId===identity.subjectId&&active.deviceId===identity.deviceId){
   await lease.wait(()=>store.put(key(record.offer.operationId),{...record,state:'committed',receipt}));
   return{receipt,identity:{subjectId:identity.subjectId,deviceId:identity.deviceId},activated:false,alreadyActivated:true,connectionRequired:false,dataRecovery:'separate/not-performed'};
  }
  await lease.check();await activate(identity,{expectedOwner:lease.owner});
  // Activation is the intended owner transition. Capture its new owner before
  // returning or persisting completion, so a later selection gets no old UI.
  const completed=await ownerLease();if(completed.owner?.subjectId!==identity.subjectId||completed.owner.deviceId!==identity.deviceId)fail('device_handoff_owner_changed');
  await completed.wait(()=>store.put(key(record.offer.operationId),{...record,state:'committed',receipt}));
  return {receipt,identity:{subjectId:identity.subjectId,deviceId:identity.deviceId},activated:true,connectionRequired:true,dataRecovery:'separate/not-performed'};
 }
 async function createOffer(subjectId,{scopes:selected=[...allowed],confirmed=false}={},lease){
  if(!confirmed||!subject(subjectId))fail('device_request_confirmation_required');const active=lease.owner;if(active&&active.subjectId!==subjectId)fail('device_identity_switch_required');scopes(selected);
  const pending=await lease.wait(()=>store.get(pendingKey));if(pending){const existing=await lease.wait(()=>store.get(key(pending)));if(existing&&!['canceled','committed','expired'].includes(existing.state)){
   if(existing.offer.subjectId!==subjectId||!same(existing.offer.scopes,selected))fail('device_pending_request_exists');return structuredClone(existing.offer);}}
  await state(subjectId,lease);const material=await lease.wait(()=>createDevice()),operationId=crypto.randomUUID();
  const value={version:1,type:'galaxy-device-request',endpoint,subjectId,operationId,deviceId:material.deviceId,publicKeyPem:material.publicKeyPem,scopes:[...selected]};
  await lease.wait(()=>store.put(`device:${subjectId}:${material.deviceId}`,material));
  await lease.wait(()=>store.put(key(operationId),{offer:value,installationId:crypto.randomUUID(),state:'offered'}));await lease.wait(()=>store.put(pendingKey,operationId));return structuredClone(value);
 }
 async function previewOffer(input,lease){const value=offer(input);return {...value,fingerprint:await lease.wait(()=>identityKeyId(value.publicKeyPem,{crypto}))};}
 async function approveOffer(input,{scopes:selected,confirmed=false}={},lease){
  if(!confirmed)fail('device_approval_confirmation_required');const value=offer(input),active=lease.owner;if(!active||active.subjectId!==value.subjectId)fail('device_controller_identity_mismatch');
  const material=await lease.wait(()=>store.get(`device:${active.subjectId}:${active.deviceId}`));if(!material)fail('device_key_unavailable');
  const current=await state(active.subjectId,lease),signer=current.devices.find(d=>d.device_id===active.deviceId&&d.status==='active'&&d.epoch===current.epoch);
  if(!signer||signer.public_key!==material.publicKeyPem||!signer.scopes.some(s=>s==='manage-identity'||s==='*'))fail('device_controller_not_authorized');
  selected=scopes(selected??value.scopes);if(selected.some(s=>!value.scopes.includes(s)||(!signer.scopes.includes('*')&&!signer.scopes.includes(s))))fail('device_scopes_expanded');
  const existing=await lease.wait(()=>store.get(opKey(value.operationId)));
  const request={version:2,kind:'authorize-device',operationId:value.operationId,subjectId:value.subjectId,expectedEpoch:current.epoch,previousEventHash:current.chainHead,
   signerKeyId:await lease.wait(()=>identityKeyId(material.publicKeyPem,{crypto})),newDevice:{deviceId:value.deviceId,publicKeyPem:value.publicKeyPem,scopes:selected}};
  if(existing&&!same(existing.request,request))fail('device_approval_control_changed');
  const c=createIdentityControlClient({endpoint,send:(...args)=>lease.wait(()=>send(...args)),store:{get:name=>lease.wait(()=>store.get(name)),put:(name,value)=>lease.wait(()=>store.put(name,value))},now,
   signController:challenge=>lease.wait(()=>signIdentityPayload(challenge,material.privateKey,{crypto}))});
  await c.prepare(request);const record=await lease.wait(()=>store.get(opKey(value.operationId)));
  const signature=record.controllerApproval??await lease.wait(()=>signIdentityPayload(record.challenge,material.privateKey,{crypto}));
  await lease.check();
  await lease.wait(()=>store.put(opKey(value.operationId),{...record,controllerApproval:signature}));
  return{version:1,type:'galaxy-device-approval',endpoint,offer:value,request,challenge:record.challenge,controllerSignature:signature};
 }
 async function acceptApproval(input,{confirmed=false}={},lease){
  if(!confirmed)fail('device_join_confirmation_required');const {value,record,material}=await localRecord(input,lease),saved=await lease.wait(()=>store.get(opKey(value.offer.operationId)));
  if(['canceled','expired'].includes(record.state))fail(record.state==='canceled'?'device_request_canceled':'device_approval_expired');
  const c=client(value,material,lease);if(saved?.commit)return reconcile(value.offer.operationId,{retry:true,confirmed:true},lease);
  await inspect(value,lease);const preview=await c.prepare(value.request),prepared=await lease.wait(()=>store.get(opKey(value.offer.operationId)));
  if(prepared.challenge!==value.challenge)fail('device_challenge_changed');await lease.wait(()=>store.put(key(value.offer.operationId),{...record,approval:value,state:'awaiting-result'}));
  return finish(await c.confirm(preview,{confirmed:true}),{...record,approval:value},lease);
 }
 async function readApprovalStatus(input,lease){
  const value=approval(input),request=value.request,active=lease.owner;
  if(!active||active.subjectId!==request.subjectId)fail('device_controller_identity_mismatch');
  const saved=await lease.wait(()=>store.get(opKey(request.operationId)));
  if(!saved||!same(saved.request,request)||saved.challenge!==value.challenge||saved.controllerApproval!==value.controllerSignature)fail('device_approval_not_owned');
  const original=JSON.stringify([saved.request,saved.challenge,saved.controllerApproval],sort);
  const checkOriginal=async()=>{const current=await lease.wait(()=>store.get(opKey(request.operationId)));
   if(JSON.stringify([current?.request,current?.challenge,current?.controllerApproval],sort)!==original)fail('device_handoff_original_changed');};
  const current=await state(request.subjectId,lease),signer=current.devices.find(d=>d.device_id===active.deviceId&&d.key_id===request.signerKeyId&&d.status==='active'&&d.epoch===current.epoch);
  if(current.epoch!==request.expectedEpoch||!signer||!signer.scopes.some(s=>s==='manage-identity'||s==='*'))fail('device_controller_not_authorized');
  await lease.wait(()=>verifySignature(value.controllerSignature,value.challenge,signer.public_key,crypto));
  await checkOriginal();
  // The approving browser has its original controller approval, never the new
  // device's possession proof. Read that exact receipt without constructing a
  // commit, signing, activating, or updating either local operation record.
  const receipt=await call(lease,'status',{operationId:request.operationId,controllerSignature:value.controllerSignature});
  if(receipt?.operationId!==request.operationId||receipt.subjectId!==request.subjectId||!['requested','committed','canceled','expired'].includes(receipt.state)
   ||receipt.state==='committed'&&(!Number.isSafeInteger(receipt.epoch)||receipt.epoch<1||!/^[a-f0-9]{64}$/.test(receipt.chainHead)))fail('device_approval_receipt_invalid');
  await checkOriginal();
  return{receipt,state:receipt.state,operationId:request.operationId,subjectId:request.subjectId,deviceId:request.newDevice.deviceId,
   scopes:[...request.newDevice.scopes],expiresAt:JSON.parse(value.challenge).expiresAt,readOnly:true};
 }
 const metadata=(record,saved,receipt)=>({registered:receipt?.registered!==false&&!!saved?.commit,hasOriginalCommit:!!saved?.commit,
  canRetryOriginalCommit:!!saved?.commit&&receipt?.state==='requested'&&!['canceled','expired','committed'].includes(record.state),
  needsReview:!!record.approval&&!saved?.commit&&!['canceled','expired','committed'].includes(record.state)
   &&!['canceled','expired','committed'].includes(receipt?.state)});
 function checkOriginalReceipt(receipt,operationId,subjectId){
  if(receipt?.operationId!==operationId||receipt.subjectId!==subjectId||!['requested','committed','canceled','expired'].includes(receipt.state)
   ||receipt.state==='committed'&&(!Number.isSafeInteger(receipt.epoch)||receipt.epoch<1||!/^[a-f0-9]{64}$/.test(receipt.chainHead)))fail('device_handoff_receipt_invalid');
  return receipt;
 }
 const selectionOriginal=(record,saved)=>JSON.stringify([record.offer,record.approval,record.installationId,saved.request,saved.challenge,saved.commit],sort);
 async function inspectLocalDeviceSelection(operationId,lease){
  if(!uuid(operationId))fail('device_request_not_owned');
  const record=await lease.wait(()=>store.get(key(operationId)));
  if(!record?.approval)fail('device_handoff_not_submitted');
  if(['canceled','expired'].includes(record.state))fail(record.state==='canceled'?'device_request_canceled':'device_approval_expired');
  const {value,material}=await localRecord(record.approval,lease),saved=await lease.wait(()=>store.get(opKey(operationId)));
  if(!saved?.commit||operationId!==value.offer.operationId||!same(saved.request,value.request)||saved.challenge!==value.challenge
   ||saved.commit.operationId!==operationId||saved.commit.controllerSignature!==value.controllerSignature||typeof saved.commit.newDeviceProof!=='string')fail('device_handoff_original_changed');
  if(!uuid(record.installationId)||material.deviceId!==value.offer.deviceId||material.privateKey?.type!=='private'
   ||material.privateKey.algorithm?.name!=='Ed25519'||!material.privateKey.usages?.includes('sign'))fail('device_key_unavailable');
  const original=selectionOriginal(record,saved);
  const checkOriginal=async()=>{
   const local=await lease.wait(()=>store.get(key(operationId))),operation=await lease.wait(()=>store.get(opKey(operationId)));
   if(!local||!operation||selectionOriginal(local,operation)!==original)fail('device_handoff_original_changed');
   if(['canceled','expired'].includes(local.state))fail(local.state==='canceled'?'device_request_canceled':'device_approval_expired');
   const currentMaterial=await lease.wait(()=>store.get(`device:${value.offer.subjectId}:${value.offer.deviceId}`));
   if(currentMaterial?.deviceId!==material.deviceId||currentMaterial.publicKeyPem!==material.publicKeyPem
    ||currentMaterial.privateKey?.type!=='private'||currentMaterial.privateKey.algorithm?.name!=='Ed25519'
    ||!currentMaterial.privateKey.usages?.includes('sign'))fail('device_key_unavailable');
  };
  // Read the original signed commit. Local adoption creates no new signature,
  // authorization, commit, subject, or device material.
  await lease.wait(()=>verifySignature(saved.commit.newDeviceProof,value.challenge,value.offer.publicKeyPem,crypto));
  await checkOriginal();
  const receipt=checkOriginalReceipt(await call(lease,'status',saved.commit),operationId,value.offer.subjectId);
  if(receipt.state!=='committed')fail(receipt.state==='canceled'?'device_request_canceled':receipt.state==='expired'?'device_approval_expired':'device_handoff_not_completed');
  await checkOriginal();
  const current=await state(value.offer.subjectId,lease),device=current.devices.find(row=>row.device_id===value.offer.deviceId);
  if(current.epoch!==value.request.expectedEpoch||receipt.epoch!==current.epoch||!device||device.status!=='active'
   ||device.epoch!==current.epoch||device.public_key!==value.offer.publicKeyPem||!same(device.scopes,value.request.newDevice.scopes)
   ||!device.scopes.some(scope=>scope==='binding'||scope==='*'))fail('device_authorization_no_longer_current');
  await checkOriginal();
  return{record,value,saved,receipt,current,original,checkOriginal};
 }
 async function previewLocalDeviceSelection(operationId,lease){
  const inspected=await inspectLocalDeviceSelection(operationId,lease),{value,current,original}=inspected;
  if(!lease.owner||lease.owner.subjectId!==value.offer.subjectId)fail('device_identity_switch_required');
  if(lease.owner.deviceId===value.offer.deviceId)fail('device_local_selection_not_required');
  const view=Object.freeze({endpoint,subjectId:value.offer.subjectId,operationId,previousDeviceId:lease.owner.deviceId,
   deviceId:value.offer.deviceId,scopes:Object.freeze([...value.request.newDevice.scopes]),
   fingerprint:await lease.wait(()=>identityKeyId(value.offer.publicKeyPem,{crypto}))});
  localSelections.set(view,{lease,owner:JSON.stringify(lease.owner,sort),original,epoch:current.epoch,chainHead:current.chainHead,
   completed:null,inFlight:null});return view;
 }
 async function selectLocalDevice(view,token,lease){
  await (token.completed??token.lease).check();
  const inspected=await inspectLocalDeviceSelection(view.operationId,lease),{record,value,receipt,current,original}=inspected;
  if(original!==token.original)fail('device_handoff_original_changed');
  if(token.completed){
   await token.completed.check();
   if(lease.owner?.subjectId!==value.offer.subjectId||lease.owner.deviceId!==value.offer.deviceId)fail('device_handoff_owner_changed');
   await lease.wait(()=>store.put(key(value.offer.operationId),{...record,state:'committed',receipt}));
   return{receipt,identity:{subjectId:value.offer.subjectId,deviceId:value.offer.deviceId},activated:false,alreadyActivated:true,
    localDeviceSelected:true,needsLocalDeviceSelection:false,connectionRequired:false,dataRecovery:'separate/not-performed'};
  }
  await token.lease.check();
  if(JSON.stringify(lease.owner,sort)!==token.owner)fail('device_handoff_owner_changed');
  if(current.epoch!==token.epoch||current.chainHead!==token.chainHead)fail('device_local_selection_changed');
  await inspected.checkOriginal();await lease.check();await token.lease.check();
  await activate({subjectId:value.offer.subjectId,genesisProof:current.genesisProof,deviceId:value.offer.deviceId,installationId:record.installationId},{expectedOwner:lease.owner});
  const completed=await ownerLease();
  if(completed.owner?.subjectId!==value.offer.subjectId||completed.owner.deviceId!==value.offer.deviceId)fail('device_handoff_owner_changed');
  // Retain the completed owner lease before saving the local completion. A lost
  // local ACK can be resumed without activating again; a later owner/binding
  // transition invalidates this token rather than reviving its old selection.
  token.completed=completed;
  await completed.wait(()=>store.put(key(value.offer.operationId),{...record,state:'committed',receipt}));
  return{receipt,identity:{subjectId:value.offer.subjectId,deviceId:value.offer.deviceId},activated:true,alreadyActivated:false,
   localDeviceSelected:true,needsLocalDeviceSelection:false,connectionRequired:true,dataRecovery:'separate/not-performed'};
 }
 function confirmLocalDeviceSelection(view,{confirmed=false}={}){
  if(!confirmed)return Promise.reject(Object.assign(new Error('device_join_confirmation_required'),{code:'device_join_confirmation_required'}));
  const token=localSelections.get(view);
  if(!token)return Promise.reject(Object.assign(new Error('device_local_selection_preview_required'),{code:'device_local_selection_preview_required'}));
  if(token.inFlight)return token.inFlight;
  const result=serial(lease=>selectLocalDevice(view,token,lease));token.inFlight=result;
  void result.then(()=>{if(token.inFlight===result)token.inFlight=null;},()=>{if(token.inFlight===result)token.inFlight=null;});
  return result;
 }
 async function resumeLocalIdentity(operationId,{confirmed=false}={},lease){
  if(!confirmed)fail('device_join_confirmation_required');
  if(lease.owner)fail('device_identity_switch_required');
  const record=await lease.wait(()=>store.get(key(operationId)));
  if(record?.state!=='committed'||!record.approval)fail('device_handoff_not_completed');
  const {value,material}=await localRecord(record.approval,lease),saved=await lease.wait(()=>store.get(opKey(operationId)));
  if(!saved?.commit||operationId!==value.offer.operationId||!same(saved.request,value.request)||saved.challenge!==value.challenge
   ||saved.commit.operationId!==operationId||saved.commit.controllerSignature!==value.controllerSignature||typeof saved.commit.newDeviceProof!=='string')fail('device_handoff_original_changed');
  if(!uuid(record.installationId)||material.deviceId!==value.offer.deviceId||material.privateKey?.type!=='private'
   ||material.privateKey.algorithm?.name!=='Ed25519'||!material.privateKey.usages?.includes('sign'))fail('device_key_unavailable');
  const original=JSON.stringify([record.offer,record.approval,record.installationId,record.state,saved.request,saved.challenge,saved.commit],sort);
  const checkOriginal=async()=>{const local=await lease.wait(()=>store.get(key(operationId))),operation=await lease.wait(()=>store.get(opKey(operationId))),device=await lease.wait(()=>store.get(`device:${value.offer.subjectId}:${value.offer.deviceId}`));
   if(JSON.stringify([local?.offer,local?.approval,local?.installationId,local?.state,operation?.request,operation?.challenge,operation?.commit],sort)!==original)fail('device_handoff_original_changed');
   if(device?.deviceId!==material.deviceId||device.publicKeyPem!==material.publicKeyPem||device.privateKey?.type!=='private'
    ||device.privateKey.algorithm?.name!=='Ed25519'||!device.privateKey.usages?.includes('sign'))fail('device_key_unavailable');
  };
  // Possession was proved by this exact completed operation. Verify that proof
  // rather than signing again or creating a replacement device authorization.
  await lease.wait(()=>verifySignature(saved.commit.newDeviceProof,value.challenge,value.offer.publicKeyPem,crypto));await checkOriginal();
  const receipt=checkOriginalReceipt(await call(lease,'status',saved.commit),operationId,value.offer.subjectId);
  if(receipt.state!=='committed')fail('device_handoff_not_completed');await checkOriginal();
  const current=await state(value.offer.subjectId,lease),device=current.devices.find(row=>row.device_id===value.offer.deviceId);
  if(current.epoch!==value.request.expectedEpoch||receipt.epoch!==current.epoch||!device||device.status!=='active'
   ||device.epoch!==current.epoch||device.public_key!==value.offer.publicKeyPem||!device.scopes.some(scope=>scope==='binding'||scope==='*'))fail('device_authorization_no_longer_current');
  await checkOriginal();await lease.check();
  await activate({subjectId:value.offer.subjectId,genesisProof:current.genesisProof,deviceId:value.offer.deviceId,installationId:record.installationId},{expectedOwner:lease.owner});
  const completed=await ownerLease();if(completed.owner?.subjectId!==value.offer.subjectId||completed.owner.deviceId!==value.offer.deviceId)fail('device_handoff_owner_changed');
  return{receipt,identity:{subjectId:value.offer.subjectId,deviceId:value.offer.deviceId},activated:true,connectionRequired:true,
   resumedLocalIdentity:true,dataRecovery:'separate/not-performed'};
 }
 async function reconcile(operationId,{retry=false,confirmed=false}={},lease){
  const record=await lease.wait(()=>store.get(key(operationId)));if(!record?.approval)fail('device_handoff_not_submitted');
  const {value,material}=await localRecord(record.approval,lease),saved=await lease.wait(()=>store.get(opKey(operationId)));
  if(saved&&(!same(saved.request,value.request)||saved.challenge!==value.challenge||saved.commit&&(saved.commit.operationId!==operationId
    ||saved.commit.controllerSignature!==value.controllerSignature||typeof saved.commit.newDeviceProof!=='string')))fail('device_handoff_original_changed');
  if(!saved?.commit&&JSON.parse(value.challenge).expiresAt<=now()&&record.state!=='canceled'){
   const receipt={operationId,subjectId:record.offer.subjectId,state:'expired',registered:false,localOnly:true};
   await lease.wait(()=>store.put(key(operationId),{...record,state:'expired',receipt}));
   return{receipt,activated:false,...metadata({...record,state:'expired'},saved,receipt)};
  }
  if(!saved)return{receipt:{operationId,subjectId:record.offer.subjectId,state:record.state,registered:false},activated:false,...metadata(record,saved,{registered:false})};
  if(record.state==='committed'){
   if(!saved.commit)fail('device_handoff_original_changed');
   const original=JSON.stringify([saved.request,saved.challenge,saved.commit],sort),receipt=checkOriginalReceipt(await call(lease,'status',saved.commit),operationId,record.offer.subjectId);
   const latest=await lease.wait(()=>store.get(opKey(operationId)));if(JSON.stringify([latest?.request,latest?.challenge,latest?.commit],sort)!==original)fail('device_handoff_original_changed');
   return{...await finish(receipt,record,lease),...metadata(record,saved,receipt)};
  }
  const c=client(value,material,lease,{original:saved,readOnly:true});
  let receipt=await c.status(operationId);
  if(receipt.state==='requested'&&retry&&saved.commit&&!['canceled','expired','committed'].includes(record.state)){
   if(!confirmed)fail('device_join_confirmation_required');receipt=await c.retry(operationId,{confirmed:true});
  }
  if(['expired','canceled'].includes(receipt.state))await lease.wait(()=>store.put(key(operationId),{...record,state:receipt.state,receipt}));
  const result=await finish(receipt,record,lease);
  return{...result,...metadata(record,saved,receipt)};
 }
 async function cancel(operationId,{confirmed=false}={},lease){
  if(!confirmed)fail('device_cancel_confirmation_required');const record=await lease.wait(()=>store.get(key(operationId)));if(!record)fail('device_request_not_owned');
  if(lease.owner&&lease.owner.subjectId!==record.offer.subjectId)fail('device_identity_switch_required');
  const saved=await lease.wait(()=>store.get(opKey(operationId)));if(saved?.commit){
   if(saved.commit.operationId!==operationId||saved.request?.operationId!==operationId||saved.request.subjectId!==record.offer.subjectId
    ||saved.request.newDevice?.deviceId!==record.offer.deviceId||saved.request.newDevice.publicKeyPem!==record.offer.publicKeyPem
    ||record.approval&&(!same(saved.request,record.approval.request)||saved.challenge!==record.approval.challenge
     ||saved.commit.controllerSignature!==record.approval.controllerSignature))fail('device_handoff_original_changed');
   const receipt=await call(lease,'cancel',saved.commit);
   if(receipt?.operationId!==operationId||receipt.subjectId!==record.offer.subjectId||!['canceled','expired','committed'].includes(receipt.state))fail('device_cancel_receipt_invalid');
   if(receipt.state==='committed')return finish(receipt,record,lease);await lease.wait(()=>store.put(key(operationId),{...record,state:receipt.state,receipt}));return{receipt,activated:false};}
  await lease.wait(()=>store.put(key(operationId),{...record,state:'canceled'}));return{receipt:{operationId,state:'canceled',localOnly:true},activated:false};
 }
 async function pending(lease){const id=await lease.wait(()=>store.get(pendingKey));if(!id)return null;const record=await lease.wait(()=>store.get(key(id)));if(!record)return null;
  if(lease.owner&&lease.owner.subjectId!==record.offer.subjectId)fail('device_identity_switch_required');
  const saved=await lease.wait(()=>store.get(opKey(id)));return{operationId:id,offer:record.offer,state:record.state,approval:record.approval??null,receipt:record.receipt??null,
   needsLocalDeviceSelection:!!lease.owner&&lease.owner.subjectId===record.offer.subjectId&&lease.owner.deviceId!==record.offer.deviceId
    &&record.receipt?.state==='committed'&&!!saved?.commit&&!['canceled','expired'].includes(record.state),
   ...metadata(record,saved,record.receipt??{registered:!!saved?.commit})};}
 return Object.freeze({
  createOffer:(subjectId,options={})=>serial(lease=>createOffer(subjectId,options,lease)),
  previewOffer:input=>serial(lease=>previewOffer(input,lease)),
  approveOffer:(input,options={})=>serial(lease=>approveOffer(input,options,lease)),
  previewApproval:input=>serial(lease=>inspect(input,lease)),
  acceptApproval:(input,options={})=>serial(lease=>acceptApproval(input,options,lease)),
  readApprovalStatus:input=>serial(lease=>readApprovalStatus(input,lease),true),
  reconcile:(operationId,options={})=>serial(lease=>reconcile(operationId,options,lease)),
  resumePending:operationId=>serial(lease=>reconcile(operationId,{retry:true,confirmed:true},lease)),
  resumeLocalIdentity:(operationId,options={})=>serial(lease=>resumeLocalIdentity(operationId,options,lease)),
  previewLocalDeviceSelection:operationId=>serial(lease=>previewLocalDeviceSelection(operationId,lease)),
  selectLocalDevice:confirmLocalDeviceSelection,
  cancel:(operationId,options={})=>serial(lease=>cancel(operationId,options,lease)),
  pending:()=>serial(pending),
 });
}
