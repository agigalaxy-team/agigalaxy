import {lstat,readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createKeycloakWebsiteDirectory} from "../identity/authentication/keycloak-website-directory.mjs";

async function protectedJson(path){
  if(typeof path!=='string'||!isAbsolute(path))throw Error('Absolute registered directory reference required.');
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>16384||process.platform!=='win32'&&(info.mode&0o007))
    throw Error('Invalid protected registered directory configuration.');
  return JSON.parse(await readFile(path,'utf8'));
}
async function credential(path){
  const value=await protectedJson(path);
  if(value.version!==1||Object.keys(value).sort().join(',')!=='clientId,clientSecret,version'||
    !/^[a-z0-9][a-z0-9._-]{0,199}$/.test(value.clientId??'')||
    typeof value.clientSecret!=='string'||!value.clientSecret||value.clientSecret.length>4096)
    throw Error('Invalid registered directory credential.');
  return {clientId:value.clientId,clientSecret:value.clientSecret};
}
// Reuse the existing, separate website realm. The worker never reads the
// optional writer credential. A read-only directory cannot become a writer
// merely because the caller asks for an account-management action.
export async function loadRegisteredWebsiteDirectory(path,{write=false,expectedIssuer=null}={}){
  if(!path)return null;
  const config=await protectedJson(path),ref=config.accountDirectory;
  if(config.version!==1||!ref||Array.isArray(ref)||typeof ref!=='object'||
    !Object.keys(ref).every(key=>['issuer','credentialFile','writerCredentialFile'].includes(key))||
    !Object.hasOwn(ref,'issuer')||!Object.hasOwn(ref,'credentialFile')||
    ref.issuer===config.issuer||expectedIssuer!==null&&ref.issuer!==expectedIssuer)
    throw Error('Invalid registered website directory reference.');
  if(Object.hasOwn(ref,'writerCredentialFile')&&
    (typeof ref.writerCredentialFile!=='string'||!isAbsolute(ref.writerCredentialFile)||ref.writerCredentialFile===ref.credentialFile))
    throw Error('Independent registered directory writer required.');
  const reader=await credential(ref.credentialFile);
  const writer=write&&ref.writerCredentialFile?await credential(ref.writerCredentialFile):null;
  if(writer&&writer.clientId===reader.clientId)throw Error('Independent registered directory writer required.');
  return createKeycloakWebsiteDirectory({issuer:ref.issuer,reader,writer,adminOrigin:config.directoryOrigin});
}
