import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import {createNativeRuntime} from './runtime.mjs';
import {createNativeToolServer} from './server.mjs';
import {nativeA2aSchema,createConfiguredNativeA2a} from './a2a.mjs';
import {loadCompactArtifact} from '../../../../integrations/native-v2/compact-app/server.mjs';
const pin=z.strictObject({publicKeyPem:z.string().min(1).max(4096),notBefore:z.number().int(),notAfter:z.number().int(),revoked:z.boolean()});
export const nativeConfigSchema=z.strictObject({version:z.literal(2),endpoint:z.url(),website:z.url(),dataDirectory:z.string().refine(isAbsolute),trustedKeys:z.record(z.string().min(1).max(160),pin),a2a:nativeA2aSchema.optional()});
export async function startNativeStdio({configPath=process.env.GALAXY_NATIVE_CONFIG,transport}={}){
 if(!configPath||!isAbsolute(configPath))throw new Error('GALAXY_NATIVE_CONFIG must name an absolute public configuration file.');
 const raw=await readFile(configPath,'utf8');if(Buffer.byteLength(raw)>65536)throw new Error('Native configuration too large.');
 const config=nativeConfigSchema.parse(JSON.parse(raw));
 const runtime=await createNativeRuntime({...config,trustedKeys:new Map(Object.entries(config.trustedKeys))});
 const a2aHost=config.a2a?createConfiguredNativeA2a({runtime,directory:config.dataDirectory,configuration:config.a2a}):undefined;
 const compactArtifact=await loadCompactArtifact();
 const handle=serveStdio(()=>createNativeToolServer(runtime,{a2aHost,compactArtifact}),{...(transport?{transport}:{}),onerror:()=>process.stderr.write('Galaxy MCP transport error.\n')});
 const close=handle.close.bind(handle);let closed=false;
 const shutdown=()=>{void resultClose();};
 const resultClose=async()=>{if(closed)return;closed=true;process.off('SIGTERM',shutdown);process.off('SIGINT',shutdown);await server.close?.();runtime.close();await close();};
 process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
 return{close:resultClose};
}
