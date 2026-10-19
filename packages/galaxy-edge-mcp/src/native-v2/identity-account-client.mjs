import {createIdentityLinkClient} from '../../../galaxy-official/src/identity-link-client.mjs';
import {identityIntentSchema} from '../../../galaxy-official/src/shared/identity-link-schema.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const terminal=new Set(['linked','revoked','binding-inactive','provider-unavailable']);
const codeOf=error=>/^[a-z0-9_-]{1,100}$/.test(error?.code??error?.message??'')?error.code??error.message:'native_account_link_unavailable';

// Reuse the existing OIDC intent and current-device signature. The journal
// retains only this exact already approved operation; no bearer or key is saved.
export function createNativeIdentityAccountClient({api,store,ensureConnection,syncSelection,captureLease,readControl,sign,now}){
 const current=actor=>{const selected=api.snapshot();return !!actor&&!!selected&&['endpoint','subjectId','bindingId','generation'].every(key=>selected[key]===actor[key]);};
 const key=(subjectId,id,action)=>'native-account-link:'+api.endpoint+':'+subjectId+':'+id+':'+action;
 const index=subjectId=>'native-account-link-index:'+api.endpoint+':'+subjectId;
 const recovering=new Map();
 async function actor(){await ensureConnection();const selected=api.snapshot();if(!selected)fail('native_connection_choice_required');return selected;}
 async function checked(lease,operation){lease.assertCurrent();const value=await operation();lease.assertCurrent();return value;}
 const sessions={readAuthorization:async endpoint=>{if(endpoint!==api.endpoint)fail('native_origin_changed');return actor();},
  matchesAuthorization:current,isAuthorizationCurrent:async selected=>{await syncSelection();return current(selected);},
  invalidateAuthorization:()=>api.disconnect?.()};
 async function send(url,{bodyJson,signal}){
  if(!url.startsWith(api.endpoint+'/v1/identity/'))fail('native_origin_changed');
  const path=url.slice(api.endpoint.length),input=JSON.parse(bodyJson),lease=captureLease();
  let recordKey;
  if(path==='/v1/identity/confirm'||path==='/v1/identity/revoke'){
   const selected=api.snapshot();if(!selected||selected.subjectId!==lease.subjectId)fail('native_account_identity_changed');
   const action=path.endsWith('/confirm')?'link':'unlink';recordKey=key(lease.subjectId,input.id,action);
   const row={id:input.id,action,subjectId:lease.subjectId,bindingId:selected.bindingId,
    deviceId:lease.deviceId,endpoint:api.endpoint,request:input,state:'submitting',createdAt:now()};
   await checked(lease,()=>store.update(recordKey,prior=>{
    if(prior&&(!same(prior.request,input)||prior.bindingId!==row.bindingId||prior.deviceId!==row.deviceId))fail('native_account_original_operation_changed');
    return prior?{...prior,state:'submitting'}:row;
   }));
   await checked(lease,()=>store.update(index(lease.subjectId),rows=>[...(rows??[]).filter(row=>row.id!==input.id||row.action!==action),{id:input.id,action}]));
  }
  try{
   const result=await checked(lease,()=>api.call(path,input,{signal}));
   if(recordKey)await checked(lease,()=>store.update(recordKey,row=>({...row,state:result.state,receipt:result})));
   return result;
  }catch(error){
   if(recordKey)await store.update(recordKey,row=>({...row,state:error?.outcome==='rejected'?'rejected':'unknown',error:codeOf(error)}));
   throw error;
  }
 }
 let client;const getClient=()=>client??=createIdentityLinkClient({endpoint:api.endpoint,sessions,send,now,sign:async(payloadJson,type)=>{
  if(type!=='galaxy-identity-link+jws'||!client.isSigningPayload(payloadJson))fail('native_account_review_required');
  const intent=identityIntentSchema.parse(JSON.parse(payloadJson)),selected=await actor(),lease=captureLease();
  if(intent.subjectId!==lease.subjectId||intent.bindingId!==selected.bindingId||intent.endpoint!==api.endpoint
   ||intent.expiresAt<=now()||intent.issuedAt>now())fail('native_account_identity_changed');
  const control=await checked(lease,()=>readControl(lease.subjectId));
  const device=control.devices?.find(row=>row.device_id===lease.deviceId&&row.status==='active'&&row.epoch===control.epoch);
  if(control.authority!==api.endpoint||control.subjectId!==lease.subjectId||control.epoch!==selected.control?.epoch
   ||device?.key_id!==selected.control?.keyId||!device?.scopes.some(scope=>scope==='binding'||scope==='*'))fail('native_account_current_control_required');
  const signature=await checked(lease,()=>sign(payloadJson,type));
  if(!client.isSigningPayload(payloadJson))fail('native_account_review_required');
  return signature;
 }});
 async function recoverOne(id){
  const selected=await actor(),lease=captureLease();
  const unlink=await checked(lease,()=>store.get(key(lease.subjectId,id,'unlink'))),recordKey=key(lease.subjectId,id,unlink?'unlink':'link');
  const saved=unlink??await checked(lease,()=>store.get(recordKey));
  if(!saved||saved.subjectId!==lease.subjectId||saved.endpoint!==api.endpoint)fail('native_account_original_operation_unavailable');
  const publicResult=(state,extra={})=>({id,action:saved.action,subjectId:lease.subjectId,state,originalOperationRetained:true,...extra});
  const page=await checked(lease,()=>getClient().read('query',{id,limit:1})),found=page.items.find(row=>row.id===id);
  if(found&&terminal.has(found.state)&&!(saved.action==='unlink'&&found.state!=='revoked')){
   const receipt={id,state:found.state,galaxyAuthorization:false};
   await checked(lease,()=>store.update(recordKey,row=>({...row,state:found.state,receipt})));
   return publicResult(found.state,{remoteResent:false,receipt});
  }
  if(saved.state==='rejected')return publicResult('rejected',{remoteResent:false,reason:saved.error});
  // A newer binding can read an old outcome, but cannot execute its old intent.
  if(saved.bindingId!==selected.bindingId||saved.deviceId!==lease.deviceId)return publicResult('unknown',{remoteResent:false,reason:'native_account_original_binding_changed'});
  if(saved.action==='link'){
   let status;
   try{status=await checked(lease,()=>getClient().read('status',{id}));}
   catch(error){lease.assertCurrent();return publicResult('unknown',{remoteResent:false,reason:codeOf(error)});}
   if(status.state!=='awaiting-local-signature'||status.expiresAt<=now())return publicResult(status.state,{remoteResent:false});
   const intent=JSON.parse(Buffer.from(saved.request.signed.split('.')[1],'base64url').toString());
   if(status.payloadJson!==JSON.stringify(intent)||intent.expiresAt<=now())return publicResult('unknown',{remoteResent:false,reason:'native_account_original_intent_changed'});
  }
  const receipt=await checked(lease,()=>api.call('/v1/identity/'+(saved.action==='link'?'confirm':'revoke'),saved.request));
  if(receipt.id!==id||receipt.galaxyAuthorization!==false||receipt.state!==(saved.action==='link'?'linked':'revoked'))fail('native_account_original_result_changed');
  await checked(lease,()=>store.update(recordKey,row=>({...row,state:receipt.state,receipt})));
  return publicResult(receipt.state,{remoteResent:true,originalSignedBytes:true,receipt});
 }
 async function recover(id){
  const selected=await actor(),recordKey=selected.subjectId+':'+id;
  if(recovering.has(recordKey))return recovering.get(recordKey);
  const operation=recoverOne(id);recovering.set(recordKey,operation);
  try{return await operation;}finally{recovering.delete(recordKey);}
 }
 async function pending(){
  await actor();const lease=captureLease(),entries=await checked(lease,()=>store.get(index(lease.subjectId)))??[],items=[];
  for(const {id,action} of entries){const row=await checked(lease,()=>store.get(key(lease.subjectId,id,action)));if(row&&!terminal.has(row.state))items.push({id,action:row.action,state:row.state,subjectId:row.subjectId});}
  return{items,originalOperationRetained:true};
 }
 return Object.freeze({read:(...args)=>getClient().read(...args),prepare:(...args)=>getClient().prepare(...args),execute:(...args)=>getClient().execute(...args),cancel:preview=>getClient().cancel(preview),recover,pending});
}
