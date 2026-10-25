import {lstat,readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {z} from 'zod';

const schema=z.strictObject({version:z.literal(1),endpoint:z.url(),url:z.url(),signingKey:z.string().min(32).max(4096),serviceKey:z.string().min(32).max(4096)});

// Only deployment configuration selects an internal runtime or its credentials.
// Neither the CMS nor a browser request can select an arbitrary URL or key file.
export async function loadOperationsAgentOsConfiguration(path,{endpoint}={}){
 if(!path)return {url:null,signingKey:null,serviceKey:null};
 if(!isAbsolute(path))throw new Error('Absolute protected AgentOS configuration reference required.');
 const info=await lstat(path);
 if(!info.isFile()||info.isSymbolicLink()||info.size>16384||process.platform!=='win32'&&(info.mode&0o007))throw new Error('Invalid protected AgentOS configuration file.');
 let value;
 try{value=schema.parse(JSON.parse(await readFile(path,'utf8')));}catch{throw new Error('Invalid protected AgentOS configuration.');}
 const url=new URL(value.url);
 if(value.endpoint!==endpoint||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw new Error('Invalid AgentOS deployment binding.');
 if(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Plaintext AgentOS connections require loopback.');
 return {url:url.origin,signingKey:value.signingKey,serviceKey:value.serviceKey};
}
