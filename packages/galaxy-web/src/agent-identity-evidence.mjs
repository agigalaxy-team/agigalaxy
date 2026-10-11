import {identityKeyId} from '../../galaxy-core/src/domain/identity-material.mjs';
import {verifyTrustIdentity,verifyTrustJws} from '../../galaxy-official/src/shared/trust-package-crypto.mjs';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';
import {readAgentIdentityEntry} from './agent-identity-handoff.mjs';

const protocol='galaxy-web-identity-handoff',proofType='galaxy-web-identity-handoff-v1+jws';
const type='galaxy-web-agent-handoff-history',allowed=new Set(['manage-identity',...browserScopes]);
const keyOrder=(left,right)=>left<right?-1:left>right?1:0;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort(keyOrder).join(',')===[...keys].sort(keyOrder).join(',');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const guid=value=>typeof value==='string'&&/^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const same=(left,right)=>stable(left)===stable(right);
const covers=(granted,requested)=>Array.isArray(granted)&&requested.every(scope=>granted.includes('*')||granted.includes(scope));
const fail=code=>{throw Object.assign(new Error(code),{code});};
const scopes=value=>Array.isArray(value)&&value.length>0&&value.length<=64&&new Set(value).size===value.length&&value.includes('binding')&&value.every(scope=>allowed.has(scope));
const descriptor=value=>exact(value,['subjectId','deviceId','keyId'])&&guid(value.subjectId)&&uuid(value.deviceId)&&digest(value.keyId);
function publicClone(input){let encoded;try{encoded=JSON.stringify(input);}catch{fail('agent_identity_evidence_invalid');}
 if(typeof encoded!=='string'||encoded.length>64000||/PRIVATE KEY|galaxy-recovery-v1:/.test(encoded))fail('agent_identity_evidence_invalid');return JSON.parse(encoded);}

function parseRecord(input,{endpoint,website,now,fresh=false}){
 const record=publicClone(input);
 if(!exact(record,['version','type','endpoint','website','handoffId','navigationId','context','authorization','receipt'])||record.version!==1||record.type!==type
  ||record.endpoint!==endpoint||record.website!==website||!uuid(record.handoffId)||!uuid(record.navigationId))fail('agent_identity_evidence_invalid');
 const value=record.context;
 if(!exact(value,['endpoint','website','subjectId','controller','scopes','expiresAt','targetPath','existingDevice','nonce','bridgeOrigin','proof'])
  ||value.endpoint!==endpoint||value.website!==website||!guid(value.subjectId)||!uuid(value.nonce)||!scopes(value.scopes)
  ||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<0||fresh&&(value.expiresAt<=now||value.expiresAt>now+180)
  ||!exact(value.controller,['deviceId','keyId','epoch','chainHead'])||!uuid(value.controller.deviceId)||!digest(value.controller.keyId)
  ||!Number.isSafeInteger(value.controller.epoch)||value.controller.epoch<1||!digest(value.controller.chainHead)
  ||value.existingDevice!==null&&!descriptor(value.existingDevice)||!exact(value.proof,['payloadJson','signature'])
  ||typeof value.proof.payloadJson!=='string'||typeof value.proof.signature!=='string')fail('agent_identity_evidence_invalid');
 let location;try{location=new URL('/app/settings/identity',website);location.search=new URLSearchParams({agentConnect:record.handoffId,agentNavigation:record.navigationId,agentBridgeOrigin:value.bridgeOrigin,returnTo:value.targetPath});}catch{fail('agent_identity_evidence_invalid');}
 if(!readAgentIdentityEntry(location)?.valid)fail('agent_identity_evidence_invalid');
 const context={endpoint,website,subjectId:value.subjectId,controller:{deviceId:value.controller.deviceId,keyId:value.controller.keyId,epoch:value.controller.epoch,chainHead:value.controller.chainHead},
  scopes:[...value.scopes],expiresAt:value.expiresAt,targetPath:value.targetPath,existingDevice:value.existingDevice};
 const payloadJson=JSON.stringify({protocol,version:1,handoffId:record.handoffId,navigationId:record.navigationId,nonce:value.nonce,bridgeOrigin:value.bridgeOrigin,context});
 if(payloadJson!==value.proof.payloadJson)fail('agent_identity_evidence_invalid');
 return record;
}

async function verifiedHistory(record,control,{endpoint,fresh=false}){
 const context=record.context;
 if(control?.authority!==endpoint||control.subjectId!==context.subjectId||!Array.isArray(control.events)||!Array.isArray(control.devices))fail('agent_identity_evidence_invalid');
 const identity={subjectId:control.subjectId,genesisProof:control.genesisProof,events:control.events,authority:endpoint,checkedAt:control.checkedAt};
 const current=await verifyTrustIdentity(identity);
 if(current.epoch!==control.epoch||current.chainHead!==control.chainHead||current.sequence!==control.sequence)fail('agent_identity_evidence_invalid');
 const last=control.events.findIndex(row=>row.event_hash===context.controller.chainHead);
 if(last<0)fail('agent_identity_evidence_invalid');
 const historical=last===control.events.length-1?current:await verifyTrustIdentity({...identity,events:control.events.slice(0,last+1)});
 const controller=historical.devices.find(device=>device.deviceId===context.controller.deviceId&&device.keyId===context.controller.keyId&&device.epoch===context.controller.epoch);
 if(historical.epoch!==context.controller.epoch||!controller||!covers(controller.scopes,['manage-identity'])||!covers(controller.scopes,context.scopes)
  ||fresh&&(current.epoch!==historical.epoch||current.chainHead!==historical.chainHead))fail('agent_identity_evidence_invalid');
 await verifyTrustJws(context.proof.signature,controller.publicKey,proofType,context.proof.payloadJson);
 return {current,historical,controller};
}

async function authorization(record,history,{endpoint,now,fresh=false}){
 const {context,authorization:value}=record;
 if(value===null){
  if(record.receipt!==null||!descriptor(context.existingDevice)||context.existingDevice.subjectId!==context.subjectId)fail('agent_identity_evidence_invalid');
  const device=history.historical.devices.find(row=>row.deviceId===context.existingDevice.deviceId&&row.keyId===context.existingDevice.keyId&&row.epoch===context.controller.epoch);
  if(!device||!covers(device.scopes,context.scopes))fail('agent_identity_evidence_invalid');
  return {...context.existingDevice,operationId:null,scopes:context.scopes};
 }
 if(!exact(value,['offer','approval']))fail('agent_identity_evidence_invalid');
 const {offer,approval}=value;
 if(!exact(offer,['version','type','endpoint','subjectId','operationId','deviceId','publicKeyPem','scopes'])||offer.version!==1||offer.type!=='galaxy-device-request'
  ||offer.endpoint!==endpoint||offer.subjectId!==context.subjectId||!uuid(offer.operationId)||!uuid(offer.deviceId)||typeof offer.publicKeyPem!=='string'||offer.publicKeyPem.length>256||!same(offer.scopes,context.scopes)
  ||!exact(approval,['version','type','endpoint','offer','request','challenge','controllerSignature'])||approval.version!==1||approval.type!=='galaxy-device-approval'||approval.endpoint!==endpoint
  ||!same(approval.offer,offer)||typeof approval.challenge!=='string'||typeof approval.controllerSignature!=='string')fail('agent_identity_evidence_invalid');
 if(context.existingDevice!==null){
  const previous=context.existingDevice,device=history.historical.devices.find(row=>row.deviceId===previous.deviceId&&row.keyId===previous.keyId&&row.epoch===context.controller.epoch);
  if(previous.subjectId!==context.subjectId||!device||offer.deviceId===previous.deviceId||covers(device.scopes,context.scopes))fail('agent_identity_evidence_invalid');
 }
 const request=approval.request;
 if(!exact(request,['version','operationId','subjectId','kind','expectedEpoch','previousEventHash','signerKeyId','newDevice'])||request.version!==2||request.kind!=='authorize-device'
  ||request.subjectId!==context.subjectId||request.operationId!==offer.operationId||request.expectedEpoch!==context.controller.epoch||request.previousEventHash!==context.controller.chainHead||request.signerKeyId!==context.controller.keyId
  ||!exact(request.newDevice,['deviceId','publicKeyPem','scopes'])||request.newDevice.deviceId!==offer.deviceId||request.newDevice.publicKeyPem!==offer.publicKeyPem
  ||!scopes(request.newDevice.scopes)||request.newDevice.scopes.some(scope=>!offer.scopes.includes(scope)))fail('agent_identity_evidence_invalid');
 let challenge;try{challenge=JSON.parse(approval.challenge);}catch{fail('agent_identity_evidence_invalid');}
 if(!exact(challenge,['version','type','audience','request','nonce','expiresAt'])||challenge.version!==2||challenge.type!=='identity-control'||challenge.audience!==endpoint
  ||!same(challenge.request,request)||typeof challenge.nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce)||!Number.isSafeInteger(challenge.expiresAt)
  ||fresh&&(challenge.expiresAt<=now||challenge.expiresAt>now+180))fail('agent_identity_evidence_invalid');
 await verifyTrustJws(approval.controllerSignature,history.controller.publicKey,'galaxy-identity-control-v2+jws',approval.challenge);
 return {subjectId:context.subjectId,deviceId:offer.deviceId,keyId:await identityKeyId(offer.publicKeyPem),operationId:offer.operationId,scopes:request.newDevice.scopes};
}

function committedReceipt(event,device){return{operationId:event.id,subjectId:event.subject_id,state:'committed',kind:event.kind,epoch:event.epoch,sequence:event.sequence,
 chainHead:event.event_hash,deviceId:device.deviceId,keyId:device.keyId,acceptedAt:new Date(event.accepted_at).toISOString()};}
function currentAuthorization(record,history,control,device){
 const current=history.current.devices.find(row=>row.deviceId===device.deviceId&&row.keyId===device.keyId&&row.epoch===history.current.epoch);
 const row=control.devices.find(value=>value.device_id===device.deviceId&&value.key_id===device.keyId&&value.epoch===control.epoch&&value.status==='active');
 if(!current||!row||current.publicKey!==row.public_key||!covers(current.scopes,device.scopes)||!covers(row.scopes,device.scopes))fail('agent_identity_device_not_current');
 if(device.operationId===null)return null;
 const event=control.events.find(value=>value.id===device.operationId);
 if(row.source_event_id!==device.operationId||!event||event.kind!=='authorize-device'||event.epoch!==record.context.controller.epoch
  ||event.signer_key_id!==record.context.controller.keyId||event.previous_event_hash!==record.context.controller.chainHead
  ||event.payload_text!==record.authorization.approval.challenge||event.controller_signature!==record.authorization.approval.controllerSignature)fail('agent_identity_evidence_invalid');
 const receipt=committedReceipt(event,device);
 if(record.receipt!==null&&!same(record.receipt,receipt))fail('agent_identity_evidence_invalid');
 return receipt;
}

// This is a product continuity prerequisite, not a new server capability.
// All inputs remain public; every use re-verifies historical signatures and
// independently reads current device control. Expired transfer nonces are never
// replayed as fresh approval, and historical controller revocation is permitted.
export function createAgentIdentityEvidence({endpoint,website,store,getActive,getPendingHandoff,publicControl,captureIdentityLease,now=()=>Math.floor(Date.now()/1000)}){
 const key=device=>`galaxy-web:${endpoint}:${device.subjectId}:agent-continuity:${device.deviceId}`;
 function capture(){const lease=captureIdentityLease();return{check:lease.check,wait:async action=>{lease.check();const value=await action();lease.check();return value;}};}
 async function retainHandoff(input){
  const lease=capture(),owner=getActive();
  if(!exact(input,['handoffId','navigationId','context','offer','approval']))fail('agent_identity_evidence_invalid');
  const record=parseRecord({version:1,type,endpoint,website,handoffId:input.handoffId,navigationId:input.navigationId,context:input.context,
   authorization:input.offer===null&&input.approval===null?null:{offer:input.offer,approval:input.approval},receipt:null},{endpoint,website,now:now(),fresh:true});
  const control=await lease.wait(()=>publicControl(record.context.subjectId)),history=await lease.wait(()=>verifiedHistory(record,control,{endpoint,fresh:true}));
  const device=await lease.wait(()=>authorization(record,history,{endpoint,now:now(),fresh:true}));
  if(owner&&owner.subjectId!==device.subjectId)fail('device_identity_switch_required');
  if(record.context.existingDevice&&(owner?.subjectId!==record.context.existingDevice.subjectId||owner?.deviceId!==record.context.existingDevice.deviceId))fail('agent_identity_evidence_invalid');
  if(record.authorization){const pending=await lease.wait(getPendingHandoff);if(!pending||!same(pending.offer,record.authorization.offer)||['canceled','expired'].includes(pending.state))fail('agent_identity_evidence_invalid');}
  else if(!owner||owner.subjectId!==device.subjectId||owner.deviceId!==device.deviceId)fail('agent_identity_evidence_invalid');
  await lease.wait(()=>store.put(key(device),record));return{subjectId:device.subjectId,deviceId:device.deviceId,operationId:device.operationId,publicHistoryRetained:true};
 }
 async function inspect(){
  const lease=capture(),owner=getActive();if(!owner)fail('agent_identity_required');
  const saved=await lease.wait(()=>store.get(key(owner)));if(!saved)fail('agent_identity_required');
  const record=parseRecord(saved,{endpoint,website,now:now()}),control=await lease.wait(()=>publicControl(owner.subjectId));
  const history=await lease.wait(()=>verifiedHistory(record,control,{endpoint})),device=await lease.wait(()=>authorization(record,history,{endpoint,now:now()}));
  if(device.subjectId!==owner.subjectId||device.deviceId!==owner.deviceId)fail('agent_identity_evidence_invalid');
  const receipt=currentAuthorization(record,history,control,device);lease.check();
  return{lease,record,device,receipt,view:{state:'verified',subjectId:owner.subjectId,deviceId:owner.deviceId,keyId:device.keyId,operationId:device.operationId,
   epoch:control.epoch,chainHead:control.chainHead,checkedAt:control.checkedAt,historicalNativeProofVerified:true,currentDeviceVerified:true,serverPermissionsGranted:false}};
 }
 async function requireCurrent(){try{return(await inspect()).view;}catch(reason){if(typeof reason?.code==='string')throw reason;throw Object.assign(new Error('agent_identity_evidence_invalid'),{code:'agent_identity_evidence_invalid',cause:reason});}}
 async function status(){try{return await requireCurrent();}catch(reason){return{state:'required',code:typeof reason?.code==='string'?reason.code:'agent_identity_evidence_invalid'};}}
 async function retainReceipt(receipt){
  const {lease,record,device,receipt:expected}=await inspect();if(!expected||receipt?.state!=='committed'||!Object.entries(expected).every(([name,value])=>name==='acceptedAt'?new Date(receipt[name]).toISOString()===value:receipt[name]===value))fail('agent_identity_evidence_invalid');
  await lease.wait(()=>store.put(key(device),{...record,receipt:expected}));return expected;
 }
 return Object.freeze({retainHandoff,retainReceipt,requireCurrent,status});
}
