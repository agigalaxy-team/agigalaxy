import {lstat,readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {smtpHostSchema,smtpRefSchema,smtpSenderKeys} from '../shared/operations-smtp-schema.mjs';
import {ServiceError} from '../shared/service-error.mjs';

const binding=z.strictObject({ref:smtpRefSchema,label:z.string().trim().min(1).max(100),host:smtpHostSchema,
 port:z.number().int().min(1).max(65535),tls:z.enum(['implicit','starttls']),
 purposes:z.array(z.enum(smtpSenderKeys)).min(1).max(5).refine(x=>new Set(x).size===x.length),
 user:z.string().min(1).max(320),password:z.string().min(1).max(4096)});
const schema=z.strictObject({version:z.literal(1),endpoint:z.url(),credentials:z.array(binding).max(32).refine(x=>new Set(x.map(y=>y.ref)).size===x.length)});

// This constructor is for protected deployment injection and isolated tests.
// Request input can select a public ref; it can never choose a secret path/key.
export function createSmtpCredentialResolver(entries=[]){
 const rows=entries.map(x=>binding.parse(x));
 const publicView=rows.map(({ref,label,host,port,tls,purposes})=>({ref,label,host,port,tls,purposes:[...purposes],available:true}));
 return Object.freeze({
  list:()=>publicView.map(x=>({...x,purposes:[...x.purposes]})),
  resolve({ref,host,port,tls,purpose}){
   const value=rows.find(x=>x.ref===ref);
   if(!value)return null;
   if(value.host!==host||value.port!==port||value.tls!==tls||purpose&&!value.purposes.includes(purpose))throw new ServiceError('smtp_credential_binding_mismatch',409);
   return {user:value.user,pass:value.password};
  },
 });
}
export async function loadOperationsSmtpCredentials(path,{endpoint}={}){
 if(!path)return createSmtpCredentialResolver();
 if(!isAbsolute(path))throw new Error('Absolute protected SMTP credential reference required.');
 const info=await lstat(path);
 if(!info.isFile()||info.isSymbolicLink()||info.size>65536||process.platform!=='win32'&&(info.mode&0o007))throw new Error('Invalid protected SMTP credential file.');
 let config;try{config=schema.parse(JSON.parse(await readFile(path,'utf8')));}catch{throw new Error('Invalid protected SMTP credential configuration.');}
 if(config.endpoint!==endpoint)throw new Error('SMTP credential endpoint mismatch.');
 return createSmtpCredentialResolver(config.credentials);
}
