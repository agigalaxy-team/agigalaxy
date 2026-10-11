import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {serveStdio,StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import {createNativeRuntime} from './runtime.mjs';
import {createNativeToolServer} from './server.mjs';
import {nativeA2aSchema,createConfiguredNativeA2a} from './a2a.mjs';
import {loadCompactArtifact} from '../../../../integrations/native-v2/compact-app/server.mjs';
import {nativeWatchHostConfigSchema} from './watch-host-config.mjs';
import {nativeWorkerPacksSchema,createConfiguredNativeWorkerHost} from './worker-pack-host.mjs';
import {nativeNotificationConfigSchema} from './notifications/config.mjs';
const pin=z.strictObject({publicKeyPem:z.string().min(1).max(4096),notBefore:z.number().int(),notAfter:z.number().int(),revoked:z.boolean()});
export const nativeConfigSchema=z.strictObject({version:z.literal(2),endpoint:z.url(),website:z.url(),dataDirectory:z.string().refine(isAbsolute),trustedKeys:z.record(z.string().min(1).max(160),pin),a2a:nativeA2aSchema.optional(),watchHost:nativeWatchHostConfigSchema.optional(),workerPacks:nativeWorkerPacksSchema.optional(),hostNotifications:nativeNotificationConfigSchema.optional()}).refine(config=>!config.workerPacks||config.workerPacks.workers.every(worker=>config.a2a?.peers.some(peer=>peer.id===worker.peerId)),'Every Worker requires an explicitly configured A2A peer');
export async function startNativeStdio({configPath=process.env.GALAXY_NATIVE_CONFIG,transport}={}){
 if(!configPath||!isAbsolute(configPath))throw new Error('GALAXY_NATIVE_CONFIG must name an absolute public configuration file.');
 const raw=await readFile(configPath,'utf8');if(Buffer.byteLength(raw)>65536)throw new Error('Native configuration too large.');
 const config=nativeConfigSchema.parse(JSON.parse(raw));
 const runtime=await createNativeRuntime({...config,trustedKeys:new Map(Object.entries(config.trustedKeys))});
 const a2aHost=config.a2a?createConfiguredNativeA2a({runtime,directory:config.dataDirectory,configuration:config.a2a}):undefined;
 let compactArtifact;
 try{compactArtifact=await loadCompactArtifact();}catch(error){runtime.close();throw error;}
 // serveStdio may replace a discovery probe with a negotiated instance. Keep
 // every actual product rather than guessing which server the entry owns.
 const instances=new Set(),wire=transport??new StdioServerTransport();let closing;
 const report=()=>process.stderr.write('Galaxy MCP shutdown failed.\n');
 const handle=serveStdio(()=>{if(closing)throw new Error('native_runtime_closed');
  const workerHost=config.workerPacks?createConfiguredNativeWorkerHost({runtime,directory:config.dataDirectory,configuration:config.workerPacks,a2aConfiguration:config.a2a}):undefined;
  const server=createNativeToolServer(runtime,{a2aHost,workerHost,compactArtifact,watchHost:config.watchHost,notificationOptions:{configuration:config.hostNotifications}});instances.add(server);return server;},
  {transport:wire,onerror:()=>process.stderr.write('Galaxy MCP transport error.\n')});
 const resultClose=()=>closing??=Promise.resolve().then(async()=>{
  process.off('SIGTERM',shutdown);process.off('SIGINT',shutdown);if(!transport)process.stdin.off('end',shutdown);
  const errors=[];
  // The SDK first stops inbound dispatch and gracefully ends subscriptions.
  // Each product drains local work before closing its protocol channel.
  try{await handle.close();}catch(error){errors.push(error);}
  const drained=await Promise.allSettled([...instances].map(server=>server.close()));
  for(const result of drained)if(result.status==='rejected')errors.push(result.reason);
  try{runtime.close();}catch(error){errors.push(error);}finally{instances.clear();}
  if(errors.length)throw new AggregateError(errors,'native_shutdown_failed');
 });
 const shutdown=()=>{void resultClose().catch(report);};
 const protocolClosed=wire.onclose;wire.onclose=()=>{try{protocolClosed?.();}finally{shutdown();}};
 process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);if(!transport)process.stdin.once('end',shutdown);
 return{close:resultClose};
}
