import {serveStdio,StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {createNativeRuntime} from './runtime.mjs';
import {createNativeToolServer} from './server.mjs';
import {createConfiguredNativeA2a} from './a2a.mjs';
import {loadCompactArtifact} from '../../../../integrations/native-v2/compact-app/server.mjs';
import {createConfiguredNativeWorkerHost} from './worker-pack-host.mjs';
import {readNativeConfiguration} from './configuration.mjs';
export {nativeConfigSchema} from './configuration.mjs';
/** @param {{configPath?:string,transport?:import('@modelcontextprotocol/server').Transport,openBrowser?:(url:string)=>Promise<unknown>}} [options] */
export async function startNativeStdio({configPath=process.env.GALAXY_NATIVE_CONFIG,transport,openBrowser}={}){
 const config=await readNativeConfiguration(configPath);
 const runtime=await createNativeRuntime({...config,trustedKeys:new Map(Object.entries(config.trustedKeys)),...(openBrowser?{openBrowser}:{})});
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
