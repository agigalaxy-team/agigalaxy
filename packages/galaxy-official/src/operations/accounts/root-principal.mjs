import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';

const MAX_BYTES=16384;
const subject=value=>typeof value==='string'&&/^[A-Za-z0-9._:@-]{1,255}$/.test(value);
const operatorId=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fixedId=(issuer,sub)=>createHash('sha256').update(issuer+'\0'+sub).digest('hex');
const issuerValue=value=>{
 if(typeof value!=='string'||value.length>2048)return false;
 try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.href===value;}catch{return false;}
};
const endpointValue=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\p{Cc}\s]/u.test(value);
const record=value=>value&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).sort().join(',')==='endpoint,externalSubject,issuer,operatorId,version'
 &&value.version===1&&endpointValue(value.endpoint)&&issuerValue(value.issuer)&&subject(value.externalSubject)
 &&operatorId(value.operatorId)&&value.operatorId===fixedId(value.issuer,value.externalSubject);
const protectedFile=info=>info.isFile()&&!info.isSymbolicLink()&&info.size<=MAX_BYTES
 &&(process.platform==='win32'||(info.mode&0o007)===0);
const invalid=()=>Object.assign(new Error('Invalid protected operations root principal.'),{code:'operations_root_principal_invalid'});

// Loaded once from protected startup configuration. Email and mutable profile
// fields cannot select a root identity; runtime callers receive no file path.
export async function loadOperationsRootPrincipal(file,{endpoint,issuer}={}){
 let handle;
 try{
  if(typeof file!=='string'||!isAbsolute(file)||!endpointValue(endpoint)||!issuerValue(issuer))throw invalid();
  const before=await lstat(file);
  if(!protectedFile(before))throw invalid();
  handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  const opened=await handle.stat();
  if(!protectedFile(opened)||opened.dev!==before.dev||opened.ino!==before.ino)throw invalid();
  const bytes=Buffer.alloc(MAX_BYTES+1);let count=0;
  while(count<bytes.length){const next=await handle.read(bytes,count,bytes.length-count,null);if(next.bytesRead===0)break;count+=next.bytesRead;}
  const after=await handle.stat();
  if(count>MAX_BYTES||!protectedFile(after)||after.size!==count||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)throw invalid();
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count)));
  if(!record(value)||value.endpoint!==endpoint||value.issuer!==issuer)throw invalid();
  return Object.freeze({version:1,endpoint:value.endpoint,issuer:value.issuer,externalSubject:value.externalSubject,operatorId:value.operatorId});
 }catch{throw invalid();}finally{if(handle)await handle.close();}
}

export function isOperationsRootPrincipal(root,principal){
 if(!record(root)||!principal||typeof principal!=='object'||Array.isArray(principal)
  ||principal.issuer!==root.issuer||principal.externalSubject!==root.externalSubject||!subject(principal.externalSubject))return false;
 return !Object.hasOwn(principal,'operatorId')||operatorId(principal.operatorId)&&principal.operatorId===root.operatorId
  &&principal.operatorId===fixedId(principal.issuer,principal.externalSubject);
}

// Native roles admit an identity to the management surface. They do not grant
// business actions or make another native administrator a root administrator.
export function managementAdmission(names,roles){
 if(!Array.isArray(names)||!roles||typeof roles!=='object'||Array.isArray(roles)
  ||![roles.administrator,roles.reader].every(value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(value))
  ||roles.administrator===roles.reader)return null;
 return names.includes(roles.administrator)?'administrator':names.includes(roles.reader)?'reader':null;
}

export function rootOperationsRole(root,principal,names,roles){
 if(!managementAdmission(names,roles))return null;
 return isOperationsRootPrincipal(root,principal)?'administrator':'reader';
}
