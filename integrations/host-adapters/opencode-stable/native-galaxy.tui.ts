import {createGalaxyAdapter,createGalaxyPlugin} from './galaxy.tui.ts';
import {createNativeRuntimeBridge} from './native-runtime-bridge.mjs';
import {createHostLocalClient} from './bridge/host-local-client.mjs';
import {createHostInputHandler} from './bridge/host-input.mjs';
import type {StableHostApi} from './adapter-types.ts';
import {hostDiagnostics} from './bridge/native-diagnostics.mjs';
import {spawn} from 'node:child_process';
export {prepareOpenCodeLocalWork} from './bridge/host-local-client.mjs';

type Options={configPath?:string;dataDirectory?:string;endpoint?:string;backend?:'go';executable?:string;onInputRequest?:(params:unknown,options:unknown)=>Promise<{action:'accept'|'decline'|'cancel';content?:Record<string,unknown>}>;openLink?:(url:string)=>Promise<unknown>;openBrowser?:(url:string)=>Promise<unknown>};

// Ordinary install entry. Native is loaded lazily from the selected public
// configuration, with the same real tools and choices used by stdio clients.
// OpenCode continues to own its providers, conversation and unsent prompt.
export function createNativeGalaxyPlugin({configPath,dataDirectory:installedDirectory,backend='go',executable, onInputRequest,openLink,openBrowser}:Options={}){
  if(backend!=='go')throw Error('native_bridge_backend_invalid');
  return createGalaxyPlugin(async()=>{
  // The public service configuration locates the same user-owned local store.
  // Reading it does not start Native, authenticate or run a model.
  let dataDirectory = installedDirectory??process.env.GALAXY_DATA_DIR;
  const connectionUnavailable=false;
  let onWorkSessionComplete:((input:{galaxyId:string;host:string;sessionId:string})=>Promise<unknown>)|undefined;
  const selected = configPath ?? process.env.GALAXY_NATIVE_CONFIG;
  const resumeService=()=>new Promise<void>((resolve,reject)=>{
   const binary=executable??process.env.GALAXY_NATIVE_EXECUTABLE;
   if(!binary){reject(Error('native_bridge_executable_required'));return;}
   const child=spawn(binary,['service','start'],{stdio:'ignore',windowsHide:true,shell:false});
   const timeout=setTimeout(()=>child.kill(),30000);
   child.once('error',error=>{clearTimeout(timeout);reject(error);});
   child.once('close',code=>{clearTimeout(timeout);if(code===0){hostPersistence.resume();bridge.resume();resolve();}else reject(Error('native_service_start_failed'));});
  });
  const hostPersistence=createHostLocalClient({configPath:selected,executable,dataDirectory});
  let hostApi:StableHostApi|undefined;
  const bridge=createNativeRuntimeBridge({configPath,backend,executable,dataDirectory,onInputRequest:onInputRequest??createHostInputHandler(()=>hostApi),...(openBrowser?{openBrowser}:{})});
  if(selected)onWorkSessionComplete=input=>bridge.sessionComplete(input);
  const adapter=createGalaxyAdapter(null,{dataDirectory,onWorkSessionComplete,hostPersistence,resumeService,connectionUnavailable,nativeTools:selected?{call:bridge.call,...(openLink?{openLink}: {})}:null});
  let unregister:(()=>void)|undefined;
  let closing:Promise<void>|undefined;
  const shutdown=()=>closing??=(async()=>{try{await adapter.close();}finally{unregister?.();unregister=undefined;await Promise.all([bridge.close(),hostPersistence?.close()]);}})();
  return{
   ...adapter,
   tui:async(api:StableHostApi)=>{
    hostApi=api;
    const diagnostics=hostDiagnostics(api);
    const stop=()=>{shutdown().catch((error:unknown)=>diagnostics.emit({event:'host_bridge',stage:'shutdown',outcome:'failed',host:'opencode',error}));};
    unregister=api.lifecycle?.onDispose(stop);
    if(api.lifecycle?.signal.aborted){stop();unregister?.();return;}
    try{await adapter.tui(api);}catch(error){await shutdown();throw error;}
   },
   close:shutdown,
  };
 });
}

const plugin=createNativeGalaxyPlugin();
export default plugin;
