import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {attachmentPolicySchema} from '../src/shared/chat-attachments-schema.mjs';

const failed=(code,status=503)=>Object.assign(new Error(code),{code,status});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

// The process receives only an isolated proxy token. S3 access/encryption keys
// and the scanner configuration remain on the selected Galaxy host.
export async function createAttachmentProxyConfiguration({endpoint,secretFile,namespace,fetch:request=globalThis.fetch}){
 const url=new URL(endpoint);
 if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))
  throw failed('isolated_attachment_proxy_loopback_required');
 const token=(await readFile(secretFile,'utf8')).trim();
 if(!/^[a-f0-9]{64}$/.test(token))throw failed('isolated_attachment_proxy_token_invalid');
 async function call(path,input,{binary=null,headers={},missing=false}={}){
  let response;
  try{response=await request(url.origin+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':binary?'application/octet-stream':'application/json',...headers},
   body:binary??JSON.stringify(input),signal:AbortSignal.timeout(90000)});}
  catch{throw failed('isolated_attachment_proxy_unavailable');}
  if(missing&&response.status===404){await response.arrayBuffer();return null;}
  if(!response.ok){let value;try{value=await response.json();}catch{}throw failed(typeof value?.error==='string'?value.error:'isolated_attachment_proxy_failed',response.status);}
  return response;
 }
 const response=await call('/configuration',{namespace}),value=await response.json();
 if(value?.version!==1||value.namespace!==namespace||value.keyId!=='isolated-'+namespace)throw failed('isolated_attachment_proxy_configuration_mismatch');
 const policy=attachmentPolicySchema.parse(value.policy),keyId=value.keyId;
 return{policy,store:{keyId,bucket:'isolated-proxy-'+namespace,
  async put({key,bytes,sha256}){const response=await call('/store/put',null,{binary:bytes,headers:{'x-galaxy-object-key':key,'x-galaxy-sha256':sha256}});
   const receipt=await response.json();if(receipt.stored!==true||receipt.keyId!==keyId)throw failed('isolated_attachment_proxy_put_mismatch');return receipt;},
  async get(input){const response=await call('/store/get',input,{missing:true});if(!response)return null;
   const bytes=Buffer.from(await response.arrayBuffer());
   if(bytes.length!==input.size||digest(bytes)!==response.headers.get('x-galaxy-content-sha256'))throw failed('isolated_attachment_proxy_read_mismatch');
   return bytes;},
  async head(input){const response=await call('/store/head',input);return response.json();},
  async erase(input){const response=await call('/store/erase',input);return response.json();},
  close(){}
 },scanner:{async scan(bytes){const response=await call('/scan',null,{binary:bytes,headers:{'x-galaxy-sha256':digest(bytes)}});return response.json();}}};
}
