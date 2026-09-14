import {readFile} from 'node:fs/promises';
import {createPrivateKey,createPublicKey,randomUUID} from 'node:crypto';
import {CompactSign} from 'jose';
import {createBrowserClient,browserScopes} from '../../../galaxy-official/src/browser-client.mjs';
import {createIdentityControlClient} from '../../../galaxy-core/src/domain/identity-control-client.mjs';
import {createIdentityDeviceHandoff} from '../../../galaxy-core/src/domain/identity-device-handoff.mjs';
import {signIdentityPayload,identityKeyId} from '../../../galaxy-core/src/domain/identity-material.mjs';
import {getLocalSnapshot,initializeGalaxyIntegration,getGalaxyCommandSurface} from '../../../galaxy-core/src/local-store.mjs';
import {resolveGalaxyInitialization} from '../../../galaxy-core/src/integration-modules.mjs';
import {localPaths,readJson} from '../../../galaxy-core/src/storage/files.mjs';
import {createHelpRuntimeV2} from '../../../galaxy-official/src/help-runtime-v2.mjs';
import {verifyGalaxyGenesis} from '../../../galaxy-core/src/galaxy-guid.mjs';
import {createNativeStore} from './store.mjs';
import {createNativeNavigation} from './navigation.mjs';
import {createTrustPackageClient} from '../../../galaxy-official/src/trust-package-client.mjs';
import {createTrustPackageDeviceAdapter} from '../../../galaxy-official/src/trust-package-device-adapter.mjs';
import {createIdentityGroupClientV2} from '../../../galaxy-official/src/identity-group-client-v2.mjs';
import {createIdentityGroupDeviceSignerV2} from '../../../galaxy-official/src/identity-group-device-signer-v2.mjs';

// Same pinned current-control browser protocol, with a native local signer.
// No token, PEM or recovery seed is exposed through the returned public methods.
export async function createNativeRuntime({dataDirectory,endpoint,website,trustedKeys,fetch,now=()=>Math.floor(Date.now()/1000),openBrowser}){
 const store=createNativeStore(dataDirectory),activeKey='native-active:'+endpoint,permissionKey='native-connection:'+endpoint;
 let active=await store.get(activeKey),connecting=null,closed=false;
 const sign=async(payload,type)=>{if(!active)throw new Error('native_identity_required');
  const device=await store.get('device:'+active.subjectId+':'+active.deviceId);if(!device?.privateKey)throw new Error('native_device_key_unavailable');
  return signIdentityPayload(payload,device.privateKey,{type});};
 const api=createBrowserClient({endpoint,trustedKeys,fetch,sign,now});
 const send=(url,o={})=>{if(!url.startsWith(endpoint+'/'))throw new Error('native_origin_changed');
  return api.call(url.slice(endpoint.length),o.bodyJson===undefined?undefined:JSON.parse(o.bodyJson),{method:o.method??'POST',authenticated:false,...(o.signal?{signal:o.signal}:{})});};
 const saveActive=async value=>{api.disconnect();await store.put(activeKey,value);active=value;};
 const handoff=createIdentityDeviceHandoff({endpoint,send,store,getActive:()=>active,activate:saveActive,allowedScopes:browserScopes,now,createDevice:store.createDevice});
 const fetchPublicControl=subjectId=>api.call('/v2/identity/'+subjectId+'/control',undefined,{method:'GET',authenticated:false});
 const trustDevice=createTrustPackageDeviceAdapter({endpoint,now,getBinding:api.snapshot,
  getMaterial:async()=>{if(closed)throw new Error('native_runtime_closed');const selected=active;
   if(selected){const material=await store.get('device:'+selected.subjectId+':'+selected.deviceId);
    if(active!==selected)throw new Error('trust_identity_changed');return{subjectId:selected.subjectId,genesisProof:selected.genesisProof,material,localGenesis:false};}
   const local=await localIdentity(),material=await store.genesisDevice(local.genesisProof.publicKeyPem);
   if(active)throw new Error('trust_identity_changed');return{subjectId:local.id,genesisProof:local.genesisProof,material,localGenesis:true};},
  readIdentity:subjectId=>store.get('native-trust-identity:'+endpoint+':'+subjectId),
  writeIdentity:(subjectId,value)=>store.put('native-trust-identity:'+endpoint+':'+subjectId,value),fetchIdentity:fetchPublicControl});
 async function publicControl(subjectId){const state=await fetchPublicControl(subjectId);await trustDevice.remember(state);return state;}
 async function localIdentity(){const s=await getLocalSnapshot(dataDirectory);if(s.recoveryRequired)throw new Error('local_initialization_requires_recovery');
  if(!s.identity||!verifyGalaxyGenesis(s.identity.id,s.identity.genesisProof))throw new Error('local_identity_required');return s.identity;}
 async function initialize(input,{confirmed=false}={}){if(!confirmed)throw new Error('local_initialization_choice_required');
  const before=await getLocalSnapshot(dataDirectory);
  if(active&&before.identity?.id!==active.subjectId){const plan=resolveGalaxyInitialization(input);
   await store.put('native-modules:'+endpoint+':'+active.subjectId,{plan,selectedAt:now()});
   return{initialized:true,localOnly:true,identity:active.subjectId,connectionCreated:false,result:plan,existingIdentityPreserved:true};}
  const r=await initializeGalaxyIntegration(dataDirectory,{...input,source:'native-v2'});
  return{initialized:true,localOnly:true,identity:(await localIdentity()).id,connectionCreated:false,result:r};}
 async function bootstrap(){const identity=await localIdentity();
  if(active&&active.subjectId!==identity.id)throw new Error('native_identity_selection_required');
  if(!active){const device=await store.genesisDevice(identity.genesisProof.publicKeyPem);await store.put('device:'+identity.id+':'+device.deviceId,device);
   await saveActive({subjectId:identity.id,genesisProof:identity.genesisProof,deviceId:device.deviceId,installationId:randomUUID(),bootstrapOperationId:randomUUID()});}
  const device=await store.get('device:'+active.subjectId+':'+active.deviceId);
  let state;try{state=await publicControl(active.subjectId);}catch(e){if(e.code!=='identity_not_registered')throw e;}
  if(state?.epoch>0){if(!state.devices.some(d=>d.device_id===active.deviceId&&d.status==='active'&&d.epoch===state.epoch&&d.public_key===device.publicKeyPem))throw new Error('old_device_approval_or_browser_recovery_required');return state;}
  const genesisSign=async text=>{const raw=await readFile(localPaths(dataDirectory).privateKey);if(raw.length>4096)throw new Error('local_genesis_key_invalid');
   const key=createPrivateKey(raw);if(createPublicKey(key).export({type:'spki',format:'pem'})!==identity.genesisProof.publicKeyPem)throw new Error('local_genesis_key_mismatch');
   return new CompactSign(Buffer.from(text)).setProtectedHeader({alg:'Ed25519',typ:'galaxy-identity-control-v2+jws'}).sign(key);};
  const control=createIdentityControlClient({endpoint,store,send,signController:genesisSign,signNewDevice:text=>signIdentityPayload(text,device.privateKey),now});
  const old=await store.get('identity-operation:'+endpoint+':'+active.bootstrapOperationId);
  if(old?.commit){const receipt=await control.status(active.bootstrapOperationId);if(receipt.state!=='committed')await control.retry(active.bootstrapOperationId,{confirmed:true});}
  else{const preview=await control.prepare({version:2,operationId:active.bootstrapOperationId,subjectId:active.subjectId,kind:'bootstrap',expectedEpoch:0,previousEventHash:null,
   signerKeyId:await identityKeyId(identity.genesisProof.publicKeyPem),genesisProof:identity.genesisProof,
   newDevice:{deviceId:device.deviceId,publicKeyPem:device.publicKeyPem,scopes:['manage-identity',...browserScopes]}});await control.confirm(preview,{confirmed:true});}
  return publicControl(active.subjectId);
 }
 async function connect({confirmed=false}={}){if(!confirmed)throw new Error('native_connection_choice_required');if(closed)throw new Error('native_runtime_closed');
  if(connecting)return connecting;
  connecting=(async()=>{let state;if(active){state=await publicControl(active.subjectId).catch(e=>{if(e.code==='identity_not_registered')return null;throw e;});}
   if(!state?.epoch)state=await bootstrap();
   const device=await store.get('device:'+active.subjectId+':'+active.deviceId),current=state.devices.find(d=>d.device_id===active.deviceId&&d.status==='active'&&d.epoch===state.epoch);
   if(!current||current.public_key!==device.publicKeyPem)throw new Error('current_device_control_required');
   const scopes=browserScopes.filter(s=>current.scopes.includes(s)||current.scopes.includes('*'));
   const result=await api.connect({subjectId:active.subjectId,genesisProof:active.genesisProof,installationId:active.installationId,scopes,
    control:{deviceId:active.deviceId,keyId:await identityKeyId(device.publicKeyPem),epoch:state.epoch}},{confirmed:true});
   await store.put(permissionKey,{enabled:true,subjectId:active.subjectId,deviceId:active.deviceId,scopes,selectedAt:now()});return result;
  })();try{return await connecting;}finally{connecting=null;}}
 async function ensure(){if(api.snapshot())return;
  const permission=await store.get(permissionKey);if(!permission?.enabled||permission.subjectId!==active?.subjectId||permission.deviceId!==active?.deviceId)throw new Error('native_connection_choice_required');
  await connect({confirmed:true});}
 async function call(path,input,options){await ensure();return api.call(path,input,options);}
 async function authorize(input,{confirmed=false}={}){
  const key='native-authorization:'+endpoint+':'+input.requestId;let saved=await store.get(key);
  if(saved&&JSON.stringify(saved.input)!==JSON.stringify(input))throw new Error('native_authorization_request_changed');
  if(!saved&&!confirmed)throw new Error('native_authorization_choice_required');await ensure();
  if(!saved){const prepared=await api.prepareAuthorization(input.payloadJson,{action:input.action,objectId:input.objectId,visibility:input.visibility,
    viewers:input.viewers,expiresAt:input.expiresAt,id:input.requestId,confirmed:true});saved={input,prepared,state:'prepared'};await store.put(key,saved);}
  try{const result=await api.submitAuthorization(saved.prepared,{confirmed:true,reconcile:true});await store.put(key,{...saved,state:'active'});return{requestId:input.requestId,...result,state:'active'};}
  catch(error){await store.put(key,{...saved,state:'result-unknown'});throw error;}
 }
 const navigation=createNativeNavigation({website,store,openBrowser,now,refresh:async object=>{
  if(object.kind==='task')return call('/v2/tasks/'+object.id,undefined,{method:'GET'});
  if(object.kind==='room')return call('/v2/chat/rooms/'+object.id+'/read',{});
  if(object.kind==='project')return call('/v2/projects/'+object.id,undefined,{method:'GET'});
  if(object.kind==='capsule')return call('/v2/capsules/read',{capsuleId:object.id,...(object.versionId?{versionId:object.versionId}:{})});
  return{state:'browser-detail-required',object};}});
 async function status(){const local=await getLocalSnapshot(dataDirectory),modules=active?await store.get('native-modules:'+endpoint+':'+active.subjectId):null;
  return{version:2,endpoint,website,identity:active?.subjectId??local.identity?.id??null,
  connected:!!api.snapshot(),connection:api.snapshot(),localInitialized:active&&local.identity?.id!==active.subjectId?!!modules:!!local.state?.integration,modelService:'user-host',backgroundModel:'not-started',embeddedUi:'unverified',activeEntries:['match','publish','participate'],
  helpPaths:['continue-current-ai','capsule-or-history','open-assistance','bounty-or-expert']};}
 async function command(name,options){const local=await getLocalSnapshot(dataDirectory);
  if(active&&local.identity?.id!==active.subjectId)return{...(await status()),command:name,interface:'chat',identityAlreadyAdopted:true,
   instruction:'Use this adopted identity. Setup changes local modules only; do not create another GUID. Full rooms open through galaxy_open.'};
  return getGalaxyCommandSurface(dataDirectory,name,options);}
 let helpSubject,helpInstance;
 const sameAuthorization=auth=>!!auth&&api.snapshot()?.bindingId===auth.bindingId&&api.snapshot()?.subjectId===auth.subjectId;
 const helpSessions={readAuthorization:async origin=>{if(origin!==endpoint)throw new Error('native_origin_changed');await ensure();return api.snapshot();},
  matchesAuthorization:sameAuthorization,isAuthorizationCurrent:async auth=>!closed&&sameAuthorization(auth),invalidateAuthorization:()=>api.disconnect()};
 const helpSend=(url,options)=>{if(!url.startsWith(endpoint+'/'))throw new Error('native_origin_changed');return call(url.slice(endpoint.length),JSON.parse(options.bodyJson),{signal:options.signal});};
 const helpRead=(url,options)=>{if(!url.startsWith(endpoint+'/'))throw new Error('native_origin_changed');return call(url.slice(endpoint.length),undefined,{method:'GET',signal:options.signal});};
 const helpFlow=Object.freeze(Object.fromEntries(['start','get','query','compose','select','pause','publish','reconcile','refresh','returnToTask','forget'].map(method=>[method,async(...args)=>{
  if(closed)throw new Error('native_runtime_closed');const subjectId=(await status()).identity;if(!subjectId)throw new Error('native_identity_required');
  if(helpSubject!==subjectId){helpInstance=createHelpRuntimeV2({dataDirectory,endpoint,subjectId,now,sessions:helpSessions,send:helpSend,read:helpRead,
   readIdentityWithin:async directory=>{const current=await store.readWithin(directory,activeKey);return current?{id:current.subjectId,genesisProof:current.genesisProof}:readJson(localPaths(directory).identity,null);}});helpSubject=subjectId;}
  return helpInstance[method](...args);
 }])));
 const trustLocalKey=async name=>'native-trust:'+endpoint+':'+(await trustDevice.current()).identity.subjectId+':'+name;
 const trustPackages=Object.freeze({...createTrustPackageClient({api:{call,snapshot:api.snapshot,endpoint},now,current:trustDevice.current,sign:trustDevice.sign,
  getLocal:async name=>store.get(await trustLocalKey(name)),putLocal:async(name,value)=>store.put(await trustLocalKey(name),value)}),refreshIdentity:trustDevice.refreshIdentity});
 let groupSubject=null,groupClient=null;
 const groupSigner=createIdentityGroupDeviceSignerV2({endpoint,current:trustDevice.refreshIdentity,getMaterial:async()=>{if(closed||!active)throw new Error('identity_group_identity_changed');const selected=active,material=await store.get('device:'+selected.subjectId+':'+selected.deviceId);if(active!==selected||!material)throw new Error('identity_group_identity_changed');return material;}});
 function identityGroups(){const subjectId=active?.subjectId;if(closed||!subjectId)return null;
  if(groupSubject!==subjectId){groupSubject=subjectId;const check=()=>{if(closed||active?.subjectId!==subjectId)throw new Error('identity_group_identity_changed');};
   groupClient=createIdentityGroupClientV2({api:{call,snapshot:api.snapshot,endpoint},subjectId,now,sign:groupSigner,getLocal:async name=>{check();const v=await store.get('native-identity-group:'+endpoint+':'+subjectId+':'+name);check();return v;},putLocal:async(name,value)=>{check();await store.put('native-identity-group:'+endpoint+':'+subjectId+':'+name,value);check();}});}
  return groupClient;}
 return Object.freeze({website,api:{call,snapshot:api.snapshot,endpoint},store,initialize,command,connect,authorize,navigation,status,helpFlow,trustPackages,get identityGroups(){return identityGroups();},
  authorizationExists:async input=>{const r=await store.get('native-authorization:'+endpoint+':'+input.requestId);return !!r&&JSON.stringify(r.input)===JSON.stringify(input);},
  device:{pending:handoff.pending,offer:handoff.createOffer,approve:handoff.approveOffer,accept:handoff.acceptApproval,reconcile:handoff.reconcile,cancel:handoff.cancel,
   previewOffer:handoff.previewOffer,previewApproval:handoff.previewApproval},
  disconnect:async()=>{await store.put(permissionKey,{enabled:false});api.disconnect();return{connected:false,remoteBindingRevoked:false};},
  close:()=>{closed=true;api.close();},now});
}
