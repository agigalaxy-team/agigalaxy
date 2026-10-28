import {createGalaxyAdapter,createGalaxyPlugin} from './galaxy.tui.ts';
import {createNativeRuntimeBridge} from './native-runtime-bridge.mjs';
import {createHostLocalClient} from './bridge/host-local-client.mjs';
import {createHostInputHandler} from './bridge/host-input.mjs';
import type {StableHostApi} from './adapter-types.ts';
import {nativeDiagnostics} from '../../../packages/galaxy-edge-mcp/src/native-v2/diagnostics.mjs';
export {prepareOpenCodeLocalWork} from './bridge/host-local-client.mjs';

type Options={configPath?:string;dataDirectory?:string;endpoint?:string;backend?:'go';executable?:string;onInputRequest?:(params:unknown,options:unknown)=>Promise<{action:'accept'|'decline'|'cancel';content?:Record<string,unknown>}>;openLink?:(url:string)=>Promise<unknown>;openBrowser?:(url:string)=>Promise<unknown>};

// Ordinary install entry. Native is loaded lazily from the selected public
// configuration, with the same real tools and choices used by stdio clients.
// OpenCode continues to own its providers, conversation and unsent prompt.
export function createNativeGalaxyPlugin({configPath,dataDirectory:installedDirectory,backend='go',executable, onInputRequest,openLink,openBrowser}:Options={}){
  if(backend!=='go')throw Error('native_bridge_backend_invalid');
  const diagnostics=nativeDiagnostics('host-client');
  return createGalaxyPlugin(async()=>{
  // The public service configuration locates the same user-owned local store.
  // Reading it does not start Native, authenticate or run a model.
  let dataDirectory = installedDirectory??process.env.GALAXY_DATA_DIR;
  const connectionUnavailable=false;
  let readLocalIdentity:((directory:string)=>Promise<{id:string}|null>)|undefined;
  let onWorkSessionComplete:((input:{galaxyId:string;host:string;sessionId:string})=>Promise<unknown>)|undefined;
  const selected = configPath ?? process.env.GALAXY_NATIVE_CONFIG;
  const hostPersistence=createHostLocalClient({configPath:selected,executable,dataDirectory});
  if(hostPersistence)readLocalIdentity=async()=>hostPersistence.history.identity() as Promise<{id:string}|null>;
  let hostApi:StableHostApi|undefined;
  const bridge=createNativeRuntimeBridge({configPath,backend,executable,dataDirectory,onInputRequest:onInputRequest??createHostInputHandler(()=>hostApi),...(openBrowser?{openBrowser}:{})});
  if(selected)onWorkSessionComplete=input=>bridge.sessionComplete(input);
  const adapter=createGalaxyAdapter(null,{dataDirectory,readLocalIdentity,onWorkSessionComplete,hostPersistence,connectionUnavailable,nativeTools:selected?{call:bridge.call,...(openLink?{openLink}: {})}:null});
  let unregister:(()=>void)|undefined;
  let closing:Promise<void>|undefined;
  const shutdown=()=>closing??=(async()=>{try{await adapter.close();}finally{unregister?.();unregister=undefined;await Promise.all([bridge.close(),hostPersistence?.close()]);}})();
  return{
   ...adapter,
   tui:async(api:StableHostApi)=>{
    hostApi=api;
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
