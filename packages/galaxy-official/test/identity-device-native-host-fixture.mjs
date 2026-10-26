import {createNativeStore} from '../../galaxy-edge-mcp/src/native-v2/store.mjs';
import {createBrowserClient,browserScopes} from '../src/browser-client.mjs';
import {createBrowserGenesis} from '../../galaxy-core/src/domain/guid-browser-adapter.mjs';
import {createIdentityControlClient} from '../../galaxy-core/src/domain/identity-control-client.mjs';
import {createIdentityDeviceHandoff} from '../../galaxy-core/src/domain/identity-device-handoff.mjs';
import {createIdentityDeviceManagement} from '../../galaxy-core/src/domain/identity-device-management.mjs';
import {createRecoveryMaterial,importRecoveryMaterial,identityKeyId,signIdentityPayload} from '../../galaxy-core/src/domain/identity-material.mjs';

// Test the actual core local-device consumer with Native key persistence. This
// host adapter is not a claim that every core method is a Native public API.
export async function createNativeDeviceCoreHost({directory,config,fetch,now,initialize=false,onRead}){
 const records=createNativeStore(directory),writes=[],activeKey='native-active:'+config.endpoint;
 const store={...records,get:async key=>{const value=await records.get(key);await onRead?.(key);return value;},
  put:async(key,value)=>{writes.push(key);return records.put(key,value);},
  update:async(key,change)=>{writes.push(key);return records.update(key,change);}};
 let active=await store.get(activeKey),closed=false,lifecycle=0;
 const sign=async(payload,type)=>{if(!active||closed)throw Error('native_identity_required');const material=await store.get('device:'+active.subjectId+':'+active.deviceId);return signIdentityPayload(payload,material.privateKey,{type});};
 const transport=createBrowserClient({...config,fetch,now,sign});
 const api={...transport,connect:async(...args)=>{const result=await transport.connect(...args);lifecycle++;return result;},
  disconnect:()=>{lifecycle++;transport.disconnect();}};
 const publicControl=subjectId=>api.call('/v2/identity/'+subjectId+'/control',undefined,{method:'GET',authenticated:false});
 const captureLease=(code='device_handoff_owner_changed')=>{const owner=active,turn=lifecycle,binding=api.snapshot();return {subjectId:owner?.subjectId,deviceId:owner?.deviceId,endpoint:config.endpoint,
  assertCurrent(){const current=api.snapshot();if(closed||owner!==active||turn!==lifecycle||(binding===null)!==(current===null)||binding&&['subjectId','bindingId','generation'].some(key=>binding[key]!==current?.[key]))throw Object.assign(Error(code),{code});}};};
 const activate=async(value,{expectedOwner}={})=>{
  if(closed)throw Object.assign(Error('device_handoff_owner_changed'),{code:'device_handoff_owner_changed'});
  const selected=await store.update(activeKey,current=>{if(JSON.stringify(current??null)!==JSON.stringify(expectedOwner??null))throw Object.assign(Error('device_handoff_owner_changed'),{code:'device_handoff_owner_changed'});return value;});
  active=selected;api.disconnect();
 };
 const deviceHandoff=createIdentityDeviceHandoff({endpoint:config.endpoint,send:api.send,store,getActive:async()=>active,activate,
  captureLease:()=>captureLease(),captureApprovalLease:()=>captureLease('receipt_status_authority_changed'),allowedScopes:browserScopes,now,createDevice:records.createDevice});
 const deviceManagement=createIdentityDeviceManagement({endpoint:config.endpoint,send:api.send,store,getActive:async()=>active,captureLease:()=>captureLease('receipt_status_authority_changed'),now});
 const recovery=new Map();
 const control=async(kind,fields,material,subjectId=active.subjectId)=>{
  const state=await publicControl(subjectId),client=createIdentityControlClient({endpoint:config.endpoint,send:api.send,store,now,
   signController:text=>signIdentityPayload(text,material.privateKey),signNewDevice:text=>signIdentityPayload(text,(fields.newMaterial??material).privateKey)});
  return client.confirm(await client.prepare({version:2,kind,operationId:crypto.randomUUID(),subjectId,expectedEpoch:state.epoch,previousEventHash:state.chainHead,
   signerKeyId:await identityKeyId(material.publicKeyPem),...Object.fromEntries(Object.entries(fields).filter(([key])=>key!=='newMaterial'))}),{confirmed:true});
 };
 async function bootstrap(){
  const material=await records.createDevice(),genesis=await createBrowserGenesis({publicKeyPem:material.publicKeyPem,originCode:'5'}),owner={subjectId:genesis.id,genesisProof:genesis.genesisProof,deviceId:material.deviceId,installationId:crypto.randomUUID()};
  const client=createIdentityControlClient({endpoint:config.endpoint,send:api.send,store,now,signController:text=>signIdentityPayload(text,material.privateKey),signNewDevice:text=>signIdentityPayload(text,material.privateKey)});
  await client.confirm(await client.prepare({version:2,kind:'bootstrap',operationId:crypto.randomUUID(),subjectId:owner.subjectId,expectedEpoch:0,previousEventHash:null,
   signerKeyId:await identityKeyId(material.publicKeyPem),genesisProof:owner.genesisProof,newDevice:{deviceId:owner.deviceId,publicKeyPem:material.publicKeyPem,scopes:['manage-identity',...browserScopes]}}),{confirmed:true});
  await store.put('device:'+owner.subjectId+':'+owner.deviceId,material);await store.put(activeKey,owner);active=owner;
 }
 const host={api,deviceHandoff,deviceManagement,
  async connect({confirmed=false}={}){if(!confirmed||!active||closed)throw Error('native_connection_choice_required');const state=await publicControl(active.subjectId),material=await store.get('device:'+active.subjectId+':'+active.deviceId),device=state.devices.find(item=>item.device_id===active.deviceId&&item.status==='active');
   return api.connect({subjectId:active.subjectId,genesisProof:active.genesisProof,installationId:active.installationId,scopes:browserScopes.filter(scope=>device.scopes.includes(scope)||device.scopes.includes('*')),control:{deviceId:active.deviceId,keyId:await identityKeyId(material.publicKeyPem),epoch:state.epoch}},{confirmed:true});},
  disconnect:async()=>api.disconnect(),status:async()=>({identity:active?{subjectId:active.subjectId,deviceId:active.deviceId}:null}),close(){closed=true;lifecycle++;transport.close();},
  async prepareRecovery(){const material=await createRecoveryMaterial(active.subjectId),operationId=crypto.randomUUID();recovery.set(operationId,material);return{code:material.code,subjectId:material.subjectId,operationId};},
  async saveRecovery({operationId,confirmed}){if(!confirmed||!recovery.has(operationId))throw Error('Native recovery confirmation required');const state=await publicControl(active.subjectId),material=await store.get('device:'+active.subjectId+':'+active.deviceId);return control('set-recovery',{recoveryGeneration:state.recovery?.generation??0,nextRecoveryPublicKey:recovery.get(operationId).publicKeyPem,saveDeclaration:true},material);},
  async recover(code,{confirmed}){if(!confirmed)throw Error('Native recovery confirmation required');const recoveryMaterial=await importRecoveryMaterial(code),state=await publicControl(recoveryMaterial.subjectId),material=await records.createDevice(),next=await createRecoveryMaterial(recoveryMaterial.subjectId);
   const receipt=await control('recover',{recoveryGeneration:state.recovery.generation,newDevice:{deviceId:material.deviceId,publicKeyPem:material.publicKeyPem,scopes:['manage-identity',...browserScopes]},nextRecoveryPublicKey:next.publicKeyPem,newMaterial:material},recoveryMaterial,recoveryMaterial.subjectId);
   await store.put('device:'+recoveryMaterial.subjectId+':'+material.deviceId,material);await store.put(activeKey,{subjectId:recoveryMaterial.subjectId,genesisProof:state.genesisProof,deviceId:material.deviceId,installationId:crypto.randomUUID()});active=await store.get(activeKey);api.disconnect();return receipt;}
 };
 try{if(initialize)await bootstrap();return{host,store,writes,directory,injectRecord:records.put};}catch(error){host.close();throw error;}
}
