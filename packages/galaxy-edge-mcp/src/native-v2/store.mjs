import {createHash,generateKeyPairSync,createPrivateKey,createPublicKey,randomUUID,webcrypto} from 'node:crypto';
import {readFile,mkdir,writeFile,realpath} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {withLocalRead,withLocalWrite} from '../../../galaxy-core/src/storage/write-lock.mjs';
import {readJson,writeJson,localPaths} from '../../../galaxy-core/src/storage/files.mjs';

// Native hosts retain a device PEM in their user-owned data directory. This is
// deliberately distinct from the browser's non-exportable IndexedDB key store.
// Only the private adapter below reads PEM; the MCP surface receives public data.
export function createNativeStore(dataDirectory){
 if(!isAbsolute(dataDirectory))throw new Error('native_data_directory_must_be_absolute');
 const digest=s=>createHash('sha256').update(s).digest('hex');
 const record=(d,key)=>join(d,'native-v2','records',digest(key)+'.json');
 const keyPath=(d,id)=>{if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('invalid_device_id');return join(d,'native-v2','keys',id+'.pem');};
 async function restore(value,d){if(!value?.nativeDeviceKey)return value;
  const raw=await readFile(value.nativeGenesis===true?localPaths(d).privateKey:keyPath(d,value.nativeDeviceKey));if(raw.length>4096)throw new Error('native_device_key_invalid');const privateObject=createPrivateKey(raw);
  const pem=createPublicKey(privateObject).export({type:'spki',format:'pem'});
  if(pem!==value.publicKeyPem)throw new Error('native_device_key_mismatch');
  const privateKey=await webcrypto.subtle.importKey('pkcs8',privateObject.export({type:'pkcs8',format:'der'}),{name:'Ed25519'},false,['sign']);
  const result={...value,privateKey};delete result.nativeDeviceKey;return result;
 }
 function serialise(value){if(!value?.privateKey)return value;
  if(!value.deviceId||!value.publicKeyPem)throw new Error('native_private_material_not_allowed');
  const result={...value,nativeDeviceKey:value.deviceId};delete result.privateKey;return result;
 }
 function connectionPart(key){
  for(const [prefix,part] of [['native-active:','active'],['native-connection:','permission']]){
   if(key.startsWith(prefix))return{endpoint:key.slice(prefix.length),part};
  }
  return null;
 }
 async function readConnectionWithin(d,endpoint){
  const current=await readJson(record(d,'native-selection:'+endpoint),null);
  if(current){
   if(current.version!==1||!Number.isSafeInteger(current.revision)||current.revision<1
    ||!Object.hasOwn(current,'active')||!Object.hasOwn(current,'permission'))throw new Error('native_selection_invalid');
   return current;
  }
  // Reading an older installation never creates a file or changes its choice.
  return{version:1,revision:0,active:await readJson(record(d,'native-active:'+endpoint),null),
   permission:await readJson(record(d,'native-connection:'+endpoint),null)};
 }
 function validateRecord(value){
  const bytes=JSON.stringify(value);
  if(typeof bytes!=='string'||Buffer.byteLength(bytes)>2*1024*1024||/-----BEGIN (?:PRIVATE|RSA PRIVATE) KEY-----/.test(bytes))throw new Error('native_record_invalid');
 }
 async function updateConnection(endpoint,change){return withLocalWrite(dataDirectory,async d=>{
  const old=await readConnectionWithin(d,endpoint),next=change(structuredClone(old));
  if(next?.then)throw new Error('native_async_mutation_forbidden');
  if(!next||!Object.hasOwn(next,'active')||!Object.hasOwn(next,'permission')||old.revision===Number.MAX_SAFE_INTEGER)throw new Error('native_selection_invalid');
  const selected={version:1,revision:old.revision+1,active:next.active,permission:next.permission};validateRecord(selected);
  await mkdir(join(d,'native-v2','records'),{recursive:true,mode:0o700});
  // One atomic rename commits the identity and local connection choice together.
  // The original two files remain readable history; all current readers project
  // this record under the same cross-process read/write lock.
  await writeJson(record(d,'native-selection:'+endpoint),selected);return structuredClone(selected);
 });}
 async function update(key,change){return withLocalWrite(dataDirectory,async d=>{
  const file=record(d,key),old=await readJson(file,null),next=change(structuredClone(old));
  if(next?.then)throw new Error('native_async_mutation_forbidden');
  validateRecord(next);
  await mkdir(join(d,'native-v2','records'),{recursive:true,mode:0o700});await writeJson(file,next);return structuredClone(next);
 });}
 const readValue=async(d,key)=>{const part=connectionPart(key);return part?(await readConnectionWithin(d,part.endpoint))[part.part]:readJson(record(d,key),null);};
 const get=key=>withLocalRead(dataDirectory,async d=>restore(await readValue(d,key),d));
 const updateValue=async(key,change)=>{
  const part=connectionPart(key);if(!part)return update(key,change);
  const selected=await updateConnection(part.endpoint,current=>{
   const next=change(current[part.part]);if(next?.then)throw new Error('native_async_mutation_forbidden');
   return{...current,[part.part]:next};
  });
  return selected[part.part];
 };
 const put=(key,value)=>updateValue(key,()=>serialise(value));
 async function createDevice(){return withLocalWrite(dataDirectory,async d=>{
  const deviceId=randomUUID(),pair=generateKeyPairSync('ed25519'),publicKeyPem=pair.publicKey.export({type:'spki',format:'pem'});
  await mkdir(join(d,'native-v2','keys'),{recursive:true,mode:0o700});
  await writeFile(keyPath(d,deviceId),pair.privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
  return restore({deviceId,publicKeyPem,nativeDeviceKey:deviceId},d);
 });}
 const genesisDevice=publicKeyPem=>withLocalRead(dataDirectory,d=>restore({deviceId:randomUUID(),publicKeyPem,nativeGenesis:true,nativeDeviceKey:randomUUID()},d));
 return Object.freeze({get,put,read:get,update:updateValue,createDevice,genesisDevice,dataDirectory,
  readConnection:endpoint=>withLocalRead(dataDirectory,d=>readConnectionWithin(d,endpoint)),updateConnection,
  readWithin:async(directory,key)=>{if(await realpath(directory)!==await realpath(dataDirectory))throw new Error('native_directory_changed');return readValue(directory,key);}});
}
