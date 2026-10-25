import {lstat,readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {moderatorIdsSchema} from '../shared/moderation-schema.mjs';

const secret=z.string().min(32).max(4096);
const schema=z.strictObject({version:z.literal(1),endpoint:z.url(),websiteOrigin:z.url(),visitorSecret:secret,
 meilisearch:z.strictObject({url:z.url(),apiKey:secret,index:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional()}),
 gorse:z.strictObject({url:z.url(),apiKey:secret}),
 openpanel:z.strictObject({url:z.url(),clientId:z.uuid(),clientSecret:secret,readClientId:z.uuid(),readClientSecret:secret,projectId:z.uuid()}),
 sourceMetadata:z.strictObject({moderatorIds:moderatorIdsSchema,identityProviders:z.array(z.strictObject({issuer:z.url(),clientId:z.string().min(1).max(200)})).max(8)}).optional()});

export async function loadDiscoveryConfiguration(path,{endpoint}={}){
 if(!path)return null;
 if(!isAbsolute(path))throw new Error('Absolute protected discovery configuration reference required.');
 const info=await lstat(path);
 if(!info.isFile()||info.isSymbolicLink()||info.size>32768||process.platform!=='win32'&&(info.mode&0o007))throw new Error('Invalid protected discovery configuration file.');
 let config;
 try{config=schema.parse(JSON.parse(await readFile(path,'utf8')));}catch{throw new Error('Invalid protected discovery configuration.');}
 if(config.endpoint!==endpoint||new URL(config.websiteOrigin).origin!==config.websiteOrigin||!config.websiteOrigin.startsWith('https://'))throw new Error('Invalid discovery deployment binding.');
 for(const service of [config.meilisearch,config.gorse,config.openpanel]){
  const url=new URL(service.url);
  if(url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname)||!['http:','https:'].includes(url.protocol)
   ||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Invalid native discovery origin.');
  service.url=url.origin;
 }
 return config;
}
