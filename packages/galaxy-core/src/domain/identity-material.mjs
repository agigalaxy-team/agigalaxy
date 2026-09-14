// Browser/Node WebCrypto adapter. No private material belongs in a server request.
const encoder=new TextEncoder();
export const recoveryPrefix='galaxy-recovery-v1:';
export const toBase64Url=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
export function fromBase64Url(text){
  if(typeof text!=='string'||!/^[A-Za-z0-9_-]+$/.test(text))throw new Error('Invalid base64url.');
  const bytes=Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
  if(toBase64Url(bytes)!==text)throw new Error('Noncanonical base64url.');return bytes;
}
export function spkiPem(bytes){const body=btoa(String.fromCharCode(...new Uint8Array(bytes)));return `-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;}
const validateSubject=subjectId=>{
  if(typeof subjectId!=='string'||!/^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(subjectId))throw new Error('Invalid Galaxy GUID.');
};
export async function createDeviceMaterial({crypto=globalThis.crypto}={}){
  if(!crypto?.subtle)throw new Error('This client lacks WebCrypto; use a supported local client.');
  let keys;try{keys=await crypto.subtle.generateKey({name:'Ed25519'},false,['sign','verify']);}
  catch{throw new Error('This client does not support Ed25519 device keys; use a supported local client.');}
  const publicKeyPem=spkiPem(await crypto.subtle.exportKey('spki',keys.publicKey));
  return {deviceId:crypto.randomUUID(),publicKeyPem,privateKey:keys.privateKey};
}
export function parseRecoveryCode(code){
  if(typeof code!=='string'||!code.startsWith(recoveryPrefix))throw new Error('Unsupported recovery code version.');
  const parts=code.slice(recoveryPrefix.length).split(':');
  if(parts.length!==2)throw new Error('Invalid recovery code.');validateSubject(parts[0]);
  const seed=fromBase64Url(parts[1]);if(seed.length!==32)throw new Error('Recovery code requires 32 bytes.');
  return {subjectId:parts[0],seed};
}
export async function importRecoveryMaterial(code,{crypto=globalThis.crypto}={}){
  const {subjectId,seed}=parseRecoveryCode(code);
  // RFC 8410 OneAsymmetricKey: version 0, id-Ed25519, nested OCTET STRING seed.
  const der=new Uint8Array(48);der.set([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);der.set(seed,16);
  try {
    const temporary=await crypto.subtle.importKey('pkcs8',der,{name:'Ed25519'},true,['sign']);
    const publicJwk=await crypto.subtle.exportKey('jwk',temporary);
    const publicKey=await crypto.subtle.importKey('raw',fromBase64Url(publicJwk.x),{name:'Ed25519'},true,['verify']);
    const privateKey=await crypto.subtle.importKey('pkcs8',der,{name:'Ed25519'},false,['sign']);
    return {subjectId,publicKeyPem:spkiPem(await crypto.subtle.exportKey('spki',publicKey)),privateKey};
  }finally{der.fill(0);seed.fill(0);}
}
export async function createRecoveryMaterial(subjectId,{crypto=globalThis.crypto}={}){
  validateSubject(subjectId);const seed=crypto.getRandomValues(new Uint8Array(32));
  const code=`${recoveryPrefix}${subjectId}:${toBase64Url(seed)}`;seed.fill(0);
  return {code,...await importRecoveryMaterial(code,{crypto})};
}
export async function signIdentityPayload(payloadText,privateKey,{type='galaxy-identity-control-v2+jws',crypto=globalThis.crypto}={}){
  const header=toBase64Url(encoder.encode(JSON.stringify({alg:'Ed25519',typ:type}))),payload=toBase64Url(encoder.encode(payloadText));
  const input=`${header}.${payload}`;
  return `${input}.${toBase64Url(await crypto.subtle.sign('Ed25519',privateKey,encoder.encode(input)))}`;
}
export async function identityKeyId(publicKeyPem,{crypto=globalThis.crypto}={}){
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(publicKeyPem)))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
