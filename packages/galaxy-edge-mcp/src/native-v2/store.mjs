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
 async function update(key,change){return withLocalWrite(dataDirectory,async d=>{
  const file=record(d,key),old=await readJson(file,null),next=change(structuredClone(old));
  if(next?.then)throw new Error('native_async_mutation_forbidden');
  const bytes=JSON.stringify(next);if(Buffer.byteLength(bytes)>2*1024*1024||/-----BEGIN (?:PRIVATE|RSA PRIVATE) KEY-----/.test(bytes))throw new Error('native_record_invalid');
  await mkdir(join(d,'native-v2','records'),{recursive:true,mode:0o700});await writeJson(file,next);return structuredClone(next);
 });}
 const get=key=>withLocalRead(dataDirectory,async d=>restore(await readJson(record(d,key),null),d));
 const put=(key,value)=>update(key,()=>serialise(value));
 async function createDevice(){return withLocalWrite(dataDirectory,async d=>{
  const deviceId=randomUUID(),pair=generateKeyPairSync('ed25519'),publicKeyPem=pair.publicKey.export({type:'spki',format:'pem'});
  await mkdir(join(d,'native-v2','keys'),{recursive:true,mode:0o700});
  await writeFile(keyPath(d,deviceId),pair.privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
  return restore({deviceId,publicKeyPem,nativeDeviceKey:deviceId},d);
 });}
 const genesisDevice=publicKeyPem=>withLocalRead(dataDirectory,d=>restore({deviceId:randomUUID(),publicKeyPem,nativeGenesis:true,nativeDeviceKey:randomUUID()},d));
 return Object.freeze({get,put,read:get,update,createDevice,genesisDevice,dataDirectory,
  readWithin:async(directory,key)=>{if(await realpath(directory)!==await realpath(dataDirectory))throw new Error('native_directory_changed');return readJson(record(directory,key),null);}});
}
