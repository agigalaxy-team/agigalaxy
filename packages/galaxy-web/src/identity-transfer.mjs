import {base64url} from '../../galaxy-official/src/shared/web-primitives.mjs';

const guid=/^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const fail=()=>{throw Object.assign(new Error('device_transfer_invalid'),{code:'device_transfer_invalid'});};
/** @typedef {{kind:'identity',subjectId:string}|{kind:'request',value:any}|{kind:'approval',value:any}} IdentityTransfer */
/** @returns {IdentityTransfer} */
function publicTransfer(value){
  const text=JSON.stringify(value);
  if(!text||text.length>24000||/PRIVATE KEY|galaxy-recovery-v1:/.test(text))fail();
  if(value?.kind==='identity'&&guid.test(value.subjectId))return {kind:'identity',subjectId:value.subjectId};
  if(value?.type==='galaxy-device-request')return {kind:'request',value};
  if(value?.type==='galaxy-device-approval')return {kind:'approval',value};
  return fail();
}
// These links carry only the existing public transfer. They never select an
// API destination or authorize a device; the pinned handoff verifies the packet.
export function identityTransferLink(website,value){
  publicTransfer(value);
  const url=new URL('/app/settings/identity',website);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)fail();
  url.hash=new URLSearchParams({device:base64url(new TextEncoder().encode(JSON.stringify(value)))}).toString();
  return url.href;
}
/** @returns {IdentityTransfer} */
export function readIdentityTransfer(input){
  if(typeof input!=='string'||input.length>48000)fail();
  const text=input.trim();if(guid.test(text))return {kind:'identity',subjectId:text};
  if(text.startsWith('{')){try{return publicTransfer(JSON.parse(text));}catch{return fail();}}
  try{
    const url=new URL(text);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/app/settings/identity')fail();
    const params=new URLSearchParams(url.hash.slice(1));
    if(params.getAll('device').length!==1)fail();
    const encoded=params.get('device');if(!encoded||!/^[A-Za-z0-9_-]+$/.test(encoded))fail();
    const bytes=Uint8Array.from(atob(encoded.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
    return publicTransfer(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  }catch{return fail();}
}
