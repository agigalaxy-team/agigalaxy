import {readFile,lstat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {externalCredentialsConfigurationSchema} from './shared/external-credentials-schema.mjs';
import {validatePublicUrl} from './public-fetch.mjs';

export function validateExternalCredentialsConfiguration(input={version:1,issuers:[]}) {
  const parsed=externalCredentialsConfigurationSchema.safeParse(input);
  if(!parsed.success)throw Error('Invalid external credential configuration.');
  for(const issuer of parsed.data.issuers)if(issuer.revocation)validatePublicUrl(issuer.revocation.url);
  return parsed.data;
}
// Fixed public keys and fixed status sources. Submitted VC/JWS fields never
// select a key server, context resolver, DID resolver or network destination.
export async function loadExternalCredentialsConfiguration(path) {
  if(!path)return validateExternalCredentialsConfiguration();
  if(!isAbsolute(path))throw Error('Absolute external credential configuration required.');
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>262144)throw Error('Invalid external credential configuration file.');
  let input;try{input=JSON.parse(await readFile(path,'utf8'));}catch{throw Error('Invalid external credential configuration.');}
  return validateExternalCredentialsConfiguration(input);
}
