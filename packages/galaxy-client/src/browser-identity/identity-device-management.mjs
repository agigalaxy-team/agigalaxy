import {createIdentityControlClient} from './identity-control-client.mjs';
import {identityKeyId,signIdentityPayload} from '../../../galaxy-contracts/src/identity/identity-material.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const frozen=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;};
const terminal=state=>['committed','canceled','expired'].includes(state);

// Device management consumes the established public control protocol. Its
// local journal is an owner-scoped locator, never a second control authority.
export function createIdentityDeviceManagement({endpoint,send,store,getActive,captureLease,now=()=>Math.floor(Date.now()/1000),crypto=globalThis.crypto,locks=globalThis.navigator?.locks}){
 const url=new URL(endpoint);
 if(url.protocol!=='https:'||url.origin!==endpoint||url.username||url.password||typeof send!=='function'
  ||typeof store?.get!=='function'||typeof store?.put!=='function'||typeof getActive!=='function'||typeof captureLease!=='function')throw fail('device_management_configuration_invalid');
 let tail=Promise.resolve();const previews=new WeakMap();
 const journalKey=subjectId=>'identity-device-management:'+endpoint+':'+subjectId;
 const operationKey=id=>'identity-operation:'+endpoint+':'+id;
 function capture(){
  const lease=captureLease();if(!lease||typeof lease.assertCurrent!=='function'||!lease.subjectId||!uuid(lease.deviceId)||lease.endpoint!==endpoint)throw fail('device_management_identity_required');
  const check=()=>lease.assertCurrent();
  const wait=async fn=>{check();const value=await fn();check();return value;};
  check();return{lease,check,wait,key:journalKey(lease.subjectId)};
 }
 function run(fn){const context=capture(),job=async()=>{context.check();return fn(context);},locked=()=>locks?locks.request(context.key,job):job();
  const result=tail.then(locked,locked);tail=result.catch(()=>{});return result;
 }
 async function owner(c){const active=await c.wait(getActive);
  if(active?.subjectId!==c.lease.subjectId||active.deviceId!==c.lease.deviceId)throw fail('device_management_identity_changed');return active;
 }
 async function load(c){return await c.wait(()=>store.get(c.key))??{active:null,history:[]};}
 async function update(c,change){
  if(typeof store.update==='function')return c.wait(()=>store.update(c.key,old=>{c.check();return change(old??{active:null,history:[]});}));
  const old=await load(c),next=change(old);await c.wait(()=>store.put(c.key,next));return next;
 }
 function reference(row){return row?{operationId:row.operationId,subjectId:row.subjectId,deviceId:row.deviceId,initiatorDeviceId:row.initiatorDeviceId,
  kind:'revoke-device',requestHash:row.requestHash,challengeHash:row.challengeHash??null,state:row.state,
  localRetryStopped:!!(row.stopped||row.localRetryStopped),serverCancellationConfirmed:row.state==='canceled',currentAccessGranted:false}:null;}
 async function state(c){
  await owner(c);const value=await c.wait(()=>send(endpoint+'/v2/identity/'+c.lease.subjectId+'/control',{method:'GET'}));
  if(value?.authority!==endpoint||value.subjectId!==c.lease.subjectId||!Number.isSafeInteger(value.epoch)||value.epoch<1
   ||!/^[a-f0-9]{64}$/.test(value.chainHead)||!Array.isArray(value.devices))throw fail('device_control_state_invalid');
  return value;
 }
 function manager(c,s){return s.devices.find(d=>d.device_id===c.lease.deviceId&&d.status==='active'&&d.epoch===s.epoch);}
 function controls(d){return !!d&&d.scopes.some(scope=>scope==='manage-identity'||scope==='*');}
 async function currentWithin(c){
  const s=await state(c),own=manager(c,s),canManage=controls(own);
  const devices=s.devices.map(d=>({deviceId:d.device_id,keyId:d.key_id,epoch:d.epoch,scopes:[...d.scopes],state:d.status,
   currentDevice:d.device_id===c.lease.deviceId,canRevoke:canManage&&d.status==='active'&&d.epoch===s.epoch
    &&(d.device_id!==c.lease.deviceId||!!s.recovery||s.devices.some(other=>other.device_id!==d.device_id&&other.status==='active'&&other.epoch===s.epoch&&controls(other)))}));
  return{subjectId:s.subjectId,endpoint,deviceId:c.lease.deviceId,epoch:s.epoch,chainHead:s.chainHead,canManage,devices,
   recoveryReadiness:s.recoveryReadiness,recoveryConfigured:!!s.recovery,checkedAt:s.checkedAt,
   identityMeaning:'device-control-only; no-professional-qualification-or-data-recovery'};
 }
 function client(c,signController=()=>{throw fail('device_management_read_only');}){
  return createIdentityControlClient({endpoint,now,send:(...args)=>c.wait(()=>send(...args)),
   store:{get:key=>c.wait(()=>store.get(key)),put:(key,value)=>c.wait(()=>store.put(key,value))},signController});
 }
 async function recordReceipt(c,row,receipt){
  if(receipt.operationId!==row.operationId||receipt.subjectId!==row.subjectId)throw fail('device_management_receipt_invalid');
  await update(c,j=>{
   if(j.active?.operationId!==row.operationId)throw fail('device_management_pending_changed');
   const next={...j.active,state:receipt.state,receipt};
   return terminal(receipt.state)?{active:null,history:[reference(next),...j.history.filter(x=>x.operationId!==row.operationId)].slice(0,50)}:{...j,active:next};
  });
  return{...reference({...row,state:receipt.state}),receipt,acceptedOperationOnly:receipt.state==='committed',currentAccessGranted:false};
 }
 async function receiptWithin(c,row){const saved=await c.wait(()=>store.get(operationKey(row.operationId)));
  if(!saved?.commit)return{...reference(row),receipt:null,registered:false,submission:'not-dispatched-by-this-client'};
  return recordReceipt(c,row,await client(c).status(row.operationId));
 }
 async function prepareWithin(c,{deviceId}){
  if(!uuid(deviceId))throw fail('device_management_target_invalid');
  let journal=await load(c),row=journal.active;
  if(row&&row.deviceId!==deviceId)throw fail('device_management_pending_exists');
  if(row?.stopped)throw fail('device_management_local_retry_stopped');
  if(row){
   const result=await receiptWithin(c,row);if(result.receipt&&terminal(result.receipt.state))throw Object.assign(fail('device_management_operation_closed'),{receipt:result});
   journal=await load(c);row=journal.active;
  }
  const s=await state(c),own=manager(c,s),target=s.devices.find(d=>d.device_id===deviceId&&d.status==='active'&&d.epoch===s.epoch);
  if(!controls(own))throw fail('device_controller_not_authorized');if(!target)throw fail('identity_device_not_active');
  if(target.device_id===own.device_id&&!s.recovery&&!s.devices.some(d=>d.device_id!==own.device_id&&d.status==='active'&&d.epoch===s.epoch&&controls(d)))throw fail('identity_last_controller');
  const request=row?.request??{version:2,operationId:crypto.randomUUID(),subjectId:s.subjectId,kind:'revoke-device',
   expectedEpoch:s.epoch,previousEventHash:s.chainHead,signerKeyId:own.key_id,deviceId};
  if(request.expectedEpoch!==s.epoch||request.previousEventHash!==s.chainHead||request.signerKeyId!==own.key_id
   ||row&&row.initiatorDeviceId!==c.lease.deviceId)throw fail('device_management_control_changed');
  if(!row){row={operationId:request.operationId,subjectId:s.subjectId,deviceId,initiatorDeviceId:c.lease.deviceId,request,
   requestHash:await c.wait(()=>identityKeyId(JSON.stringify(request),{crypto})),state:'preparing',stopped:false};
   await update(c,j=>{if(j.active)throw fail('device_management_pending_exists');return{...j,active:row};});
  }
  const control=client(c),prepared=await control.prepare(request),saved=await c.wait(()=>store.get(operationKey(row.operationId)));
  const challengeHash=await c.wait(()=>identityKeyId(saved.challenge,{crypto}));
  await update(c,j=>{if(j.active?.operationId!==row.operationId)throw fail('device_management_pending_changed');
   return{...j,active:{...j.active,state:saved.commit?'requested':'prepared',challengeHash,expiresAt:prepared.expiresAt}};});
  const preview=frozen({version:1,operationId:request.operationId,subjectId:s.subjectId,endpoint,kind:'revoke-device',request,
   requestHash:row.requestHash,challengeHash,expiresAt:prepared.expiresAt,initiatorDeviceId:c.lease.deviceId,
   target:{deviceId:target.device_id,keyId:target.key_id,scopes:[...target.scopes],currentDevice:target.device_id===c.lease.deviceId},
   control:{deviceId:c.lease.deviceId,signerKeyId:own.key_id,epoch:s.epoch,chainHead:s.chainHead},
   effects:{deviceAccess:'revoked-on-this-authority',existingBindings:'revoked-for-target-device',existingCredentials:'revoked-for-target-device',
    originalGuid:'preserved',historicalProofs:'preserved',recoveryCode:'not-consumed',dataDeletion:'not-performed',otherAuthorities:'not-asserted'}});
  previews.set(preview,{context:c,serialized:JSON.stringify(preview),used:false});return preview;
 }
 async function confirmWithin(c,preview,confirmed){
  const p=previews.get(preview);if(confirmed!==true||!p||p.used||p.serialized!==JSON.stringify(preview))throw fail('device_management_confirmation_required');
  p.context.check();c.check();
  const journal=await load(c),row=journal.active;
  if(!row||row.operationId!==preview.operationId||row.stopped)throw fail('device_management_pending_changed');
  const prior=await receiptWithin(c,row);if(prior.receipt&&terminal(prior.receipt.state))return prior;
  const s=await state(c),own=manager(c,s);
  if(!controls(own)||own.key_id!==preview.control.signerKeyId||s.epoch!==preview.control.epoch||s.chainHead!==preview.control.chainHead)throw fail('device_management_control_changed');
  if(preview.expiresAt<=now())throw fail('device_approval_expired');
  const material=await c.wait(()=>store.get('device:'+c.lease.subjectId+':'+c.lease.deviceId));
  if(!material?.privateKey||material.publicKeyPem!==own.public_key)throw fail('device_key_unavailable');
  const saved=await c.wait(()=>store.get(operationKey(row.operationId)));
  if(!saved||await c.wait(()=>identityKeyId(saved.challenge,{crypto}))!==preview.challengeHash||JSON.stringify(saved.request)!==JSON.stringify(row.request))throw fail('device_management_pending_changed');
  p.used=true;await update(c,j=>{if(j.active?.operationId!==row.operationId)throw fail('device_management_pending_changed');return{...j,active:{...j.active,state:'submitting'}};});
  const control=client(c,challenge=>c.wait(()=>signIdentityPayload(challenge,material.privateKey,{crypto})));
  try{
   const prepared=await control.prepare(row.request);
   return await recordReceipt(c,row,await control.confirm(prepared,{confirmed:true}));
  }catch(error){
   // The original commit proof is already durable before dispatch. A stale
   // caller never clears that locator or returns another owner's late result.
   try{c.check();await update(c,j=>j.active?.operationId===row.operationId?{...j,active:{...j.active,state:'result-unknown'}}:j);}catch{}
   throw error;
  }
 }
 return Object.freeze({
  current:()=>run(currentWithin),list:()=>run(currentWithin),
  prepareRevoke:input=>run(c=>prepareWithin(c,input??{})),
  confirm:(preview,{confirmed=false}={})=>run(c=>confirmWithin(c,preview,confirmed)),
  pending:()=>run(async c=>{const j=await load(c);return{active:reference(j.active),history:j.history.map(reference)};}),
  reconcile:operationId=>run(async c=>{const j=await load(c),row=j.active;
   if(row?.operationId===operationId)return receiptWithin(c,row);
   const known=j.history.find(r=>r.operationId===operationId);if(known)return{...known,acceptedOperationOnly:known.state==='committed',recordedLocalReceipt:true,currentAccessGranted:false};
   throw fail('device_management_operation_unavailable');}),
  stopRetry:(operationId,{confirmed=false}={})=>run(async c=>{
   if(confirmed!==true)throw fail('device_management_confirmation_required');const j=await load(c),row=j.active;
   if(row?.operationId!==operationId)throw fail('device_management_operation_unavailable');
   let result;try{result=await receiptWithin(c,row);}catch{c.check();result={...reference(row),receipt:null,state:'result-unknown',receiptUnavailable:true};}
   if(result.receipt&&terminal(result.receipt.state))return result;
   const saved=await c.wait(()=>store.get(operationKey(operationId)));
   await update(c,state=>{if(state.active?.operationId!==operationId)throw fail('device_management_pending_changed');
    const stopped={...reference(state.active),state:saved?.commit?'result-unknown':'stopped-local',stopped:true};
    return saved?.commit?{...state,active:{...state.active,stopped:true}}:{active:null,history:[stopped,...state.history].slice(0,50)};
   });
   return{...result,localRetryStopped:true,serverCancellationConfirmed:false,currentAccessGranted:false};
  }),
 });
}
