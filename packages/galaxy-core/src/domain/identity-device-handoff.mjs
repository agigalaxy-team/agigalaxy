import {createDeviceMaterial,identityKeyId,signIdentityPayload,fromBase64Url} from './identity-material.mjs';
import {createIdentityControlClient} from './identity-control-client.mjs';

const same=(a,b)=>JSON.stringify(a,sort)===JSON.stringify(b,sort);
function sort(_key,value){return value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value;}
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
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

// Public transfer only. The runtime supplies its private local store and an
// activation callback; neither a URL nor a transferred package selects an API.
export function createIdentityDeviceHandoff({endpoint,send,store,getActive,activate,allowedScopes,now=()=>Math.floor(Date.now()/1000),crypto=globalThis.crypto,createDevice=()=>createDeviceMaterial({crypto})}){
 const url=new URL(endpoint);if(url.protocol!=='https:'||url.origin!==endpoint||url.username||url.password||!Array.isArray(allowedScopes)
  ||typeof send!=='function'||typeof store?.get!=='function'||typeof store?.put!=='function'||typeof getActive!=='function'||typeof activate!=='function')fail('device_handoff_configuration_invalid');
 const allowed=new Set(['manage-identity',...allowedScopes]);
 const key=id=>`identity-handoff:${endpoint}:${id}`,pendingKey=`identity-handoff:${endpoint}:pending`;
 const opKey=id=>`identity-operation:${endpoint}:${id}`;
 const call=(name,input)=>send(`${endpoint}/v2/identity/control/${name}`,{method:'POST',bodyJson:JSON.stringify(input)});
 async function state(subjectId){const value=await send(`${endpoint}/v2/identity/${subjectId}/control`,{method:'GET'});
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
 async function localRecord(input){const value=approval(input),record=await store.get(key(value.offer.operationId));
  if(!record||!same(record.offer,value.offer))fail('device_request_not_owned');
  const material=await store.get(`device:${value.offer.subjectId}:${value.offer.deviceId}`);if(!material||material.publicKeyPem!==value.offer.publicKeyPem)fail('device_key_unavailable');
  const current=await getActive();if(current&&current.subjectId!==value.offer.subjectId)fail('device_identity_switch_required');return{value,record,material};}
 async function inspect(input){const {value}=await localRecord(input),current=await state(value.offer.subjectId),request=value.request;
  const signer=current.devices.find(d=>d.key_id===request.signerKeyId&&d.status==='active'&&d.epoch===current.epoch);
  if(current.epoch!==request.expectedEpoch||current.chainHead!==request.previousEventHash||!signer||!signer.scopes.some(s=>s==='manage-identity'||s==='*'))fail('device_approval_control_changed');
  await verifySignature(value.controllerSignature,value.challenge,signer.public_key,crypto);
  const challenge=JSON.parse(value.challenge);if(challenge.expiresAt<=now()||challenge.expiresAt>now()+180)fail('device_approval_expired');
  return {subjectId:request.subjectId,deviceId:request.newDevice.deviceId,endpoint,scopes:request.newDevice.scopes,
   fingerprint:await identityKeyId(request.newDevice.publicKeyPem,{crypto}),expiresAt:challenge.expiresAt,operationId:request.operationId};
 }
 function client(value,material){return createIdentityControlClient({endpoint,send,store,now,
  signController:async()=>value.controllerSignature,signNewDevice:challenge=>signIdentityPayload(challenge,material.privateKey,{crypto})});}
 async function finish(receipt,record){
  if(receipt.state!=='committed')return {receipt,activated:false};
  const current=await state(record.offer.subjectId),device=current.devices.find(d=>d.device_id===record.offer.deviceId);
  if(!device||device.status!=='active'||device.epoch!==current.epoch||device.public_key!==record.offer.publicKeyPem)fail('device_authorization_no_longer_current');
  const active=await getActive();if(active&&active.subjectId!==record.offer.subjectId)fail('device_identity_switch_required');
  const identity={subjectId:record.offer.subjectId,genesisProof:current.genesisProof,deviceId:record.offer.deviceId,installationId:record.installationId};
  await activate(identity);await store.put(key(record.offer.operationId),{...record,state:'committed',receipt});
  return {receipt,identity:{subjectId:identity.subjectId,deviceId:identity.deviceId},activated:true,connectionRequired:true,dataRecovery:'separate/not-performed'};
 }
 async function createOffer(subjectId,{scopes:selected=[...allowed],confirmed=false}={}){
  if(!confirmed||!subject(subjectId))fail('device_request_confirmation_required');const active=await getActive();if(active&&active.subjectId!==subjectId)fail('device_identity_switch_required');scopes(selected);
  const pending=await store.get(pendingKey);if(pending){const existing=await store.get(key(pending));if(existing?.state!=='canceled'&&existing?.state!=='committed'){
   if(existing.offer.subjectId!==subjectId||!same(existing.offer.scopes,selected))fail('device_pending_request_exists');return structuredClone(existing.offer);}}
  await state(subjectId);const material=await createDevice(),operationId=crypto.randomUUID();
  const value={version:1,type:'galaxy-device-request',endpoint,subjectId,operationId,deviceId:material.deviceId,publicKeyPem:material.publicKeyPem,scopes:[...selected]};
  await store.put(`device:${subjectId}:${material.deviceId}`,material);
  await store.put(key(operationId),{offer:value,installationId:crypto.randomUUID(),state:'offered'});await store.put(pendingKey,operationId);return structuredClone(value);
 }
 async function previewOffer(input){const value=offer(input);return {...value,fingerprint:await identityKeyId(value.publicKeyPem,{crypto})};}
 async function approveOffer(input,{scopes:selected,confirmed=false}={}){
  if(!confirmed)fail('device_approval_confirmation_required');const value=offer(input),active=await getActive();if(!active||active.subjectId!==value.subjectId)fail('device_controller_identity_mismatch');
  const material=await store.get(`device:${active.subjectId}:${active.deviceId}`);if(!material)fail('device_key_unavailable');
  const current=await state(active.subjectId),signer=current.devices.find(d=>d.device_id===active.deviceId&&d.status==='active'&&d.epoch===current.epoch);
  if(!signer||signer.public_key!==material.publicKeyPem||!signer.scopes.some(s=>s==='manage-identity'||s==='*'))fail('device_controller_not_authorized');
  selected=scopes(selected??value.scopes);if(selected.some(s=>!value.scopes.includes(s)||(!signer.scopes.includes('*')&&!signer.scopes.includes(s))))fail('device_scopes_expanded');
  const existing=await store.get(opKey(value.operationId));
  const request={version:2,kind:'authorize-device',operationId:value.operationId,subjectId:value.subjectId,expectedEpoch:current.epoch,previousEventHash:current.chainHead,
   signerKeyId:await identityKeyId(material.publicKeyPem,{crypto}),newDevice:{deviceId:value.deviceId,publicKeyPem:value.publicKeyPem,scopes:selected}};
  if(existing&&!same(existing.request,request))fail('device_approval_control_changed');
  const c=createIdentityControlClient({endpoint,send,store,now,signController:challenge=>signIdentityPayload(challenge,material.privateKey,{crypto})});
  await c.prepare(request);const record=await store.get(opKey(value.operationId));
  const signature=record.controllerApproval??await signIdentityPayload(record.challenge,material.privateKey,{crypto});
  if(!same(active,await getActive()))fail('device_controller_changed');
  await store.put(opKey(value.operationId),{...record,controllerApproval:signature});
  return{version:1,type:'galaxy-device-approval',endpoint,offer:value,request,challenge:record.challenge,controllerSignature:signature};
 }
 async function acceptApproval(input,{confirmed=false}={}){
  if(!confirmed)fail('device_join_confirmation_required');const {value,record,material}=await localRecord(input),saved=await store.get(opKey(value.offer.operationId));
  if(record.state==='canceled')fail('device_request_canceled');
  const c=client(value,material);if(saved?.commit)return reconcile(value.offer.operationId,{retry:true,confirmed:true});
  await inspect(value);const preview=await c.prepare(value.request),prepared=await store.get(opKey(value.offer.operationId));
  if(prepared.challenge!==value.challenge)fail('device_challenge_changed');await store.put(key(value.offer.operationId),{...record,approval:value,state:'awaiting-result'});
  return finish(await c.confirm(preview,{confirmed:true}),{...record,approval:value});
 }
 async function reconcile(operationId,{retry=false,confirmed=false}={}){
  const record=await store.get(key(operationId));if(!record?.approval)fail('device_handoff_not_submitted');const {material}=await localRecord(record.approval),c=client(record.approval,material);
  let receipt=await c.status(operationId);if(receipt.state==='requested'&&retry){if(!confirmed)fail('device_join_confirmation_required');receipt=await c.retry(operationId,{confirmed:true});}
  return finish(receipt,record);
 }
 async function cancel(operationId,{confirmed=false}={}){
  if(!confirmed)fail('device_cancel_confirmation_required');const record=await store.get(key(operationId));if(!record)fail('device_request_not_owned');
  const saved=await store.get(opKey(operationId));if(saved?.commit){const receipt=await call('cancel',saved.commit);
   if(receipt?.operationId!==operationId||receipt.subjectId!==record.offer.subjectId||!['canceled','expired','committed'].includes(receipt.state))fail('device_cancel_receipt_invalid');
   if(receipt.state==='committed')return finish(receipt,record);await store.put(key(operationId),{...record,state:receipt.state,receipt});return{receipt,activated:false};}
  await store.put(key(operationId),{...record,state:'canceled'});return{receipt:{operationId,state:'canceled',localOnly:true},activated:false};
 }
 async function pending(){const id=await store.get(pendingKey);if(!id)return null;const record=await store.get(key(id));return record?{operationId:id,offer:record.offer,state:record.state,approval:record.approval??null,receipt:record.receipt??null}:null;}
 return Object.freeze({createOffer,previewOffer,approveOffer,previewApproval:inspect,acceptApproval,reconcile,cancel,pending});
}
