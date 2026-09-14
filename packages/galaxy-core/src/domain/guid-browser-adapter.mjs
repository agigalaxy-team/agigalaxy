import { toBase64Url } from './identity-material.mjs';
const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function base32(value,length){let out='';for(let i=0;i<length;i++){out=alphabet[Number(value&31n)]+out;value>>=5n;}if(value)throw new Error('GUID overflow.');return out;}
// Byte-for-byte adapter for the existing Node GUID commitment, not a new ID scheme.
export async function createBrowserGenesis({publicKeyPem,issuedAtMs=Date.now(),originCode='0',nonce,crypto=globalThis.crypto}){
  if(!Number.isSafeInteger(issuedAtMs)||issuedAtMs<0||BigInt(issuedAtMs)>=(1n<<50n)||!/^([0-5])$/.test(originCode))throw new Error('Invalid GUID metadata.');
  nonce=nonce??crypto.getRandomValues(new Uint8Array(32));
  if(!(nonce instanceof Uint8Array)||nonce.length<16||nonce.length>64)throw new Error('Invalid genesis nonce.');
  const body=publicKeyPem.replace('-----BEGIN PUBLIC KEY-----','').replace('-----END PUBLIC KEY-----','').replaceAll(/\s/g,'');
  await crypto.subtle.importKey('spki',Uint8Array.from(atob(body),c=>c.charCodeAt(0)),{name:'Ed25519'},false,['verify']);
  const head=new TextEncoder().encode(`galaxy/guid/v1\0${originCode}\0${issuedAtMs}\0${publicKeyPem.trim()}\0`);
  const input=new Uint8Array(head.length+nonce.length);input.set(head);input.set(nonce,head.length);
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',input));let value=0n;for(const byte of hash.slice(0,10))value=(value<<8n)+BigInt(byte);
  return {id:`GUID1${originCode}${base32(BigInt(issuedAtMs),10)}${base32(value,16)}`,
    genesisProof:{version:1,publicKeyPem,nonce:toBase64Url(nonce)}};
}
