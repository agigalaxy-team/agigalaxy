import {createGalaxyAdapter,createGalaxyPlugin} from './galaxy.tui.ts';
import {createNativeRuntimeBridge} from './native-runtime-bridge.mjs';
import {createHostLocalClient} from './bridge/host-local-client.mjs';
import {createHostInputHandler} from './bridge/host-input.mjs';
import {legacyHostConfiguration} from './bridge/legacy-local.mjs';
import type {StableHostApi} from './adapter-types.ts';
import {nativeDiagnostics} from '../../../packages/galaxy-edge-mcp/src/native-v2/diagnostics.mjs';
export {prepareOpenCodeLocalWork} from './bridge/legacy-local.mjs';

type Options={configPath?:string;dataDirectory?:string;endpoint?:string;backend?:'javascript'|'go';executable?:string;onInputRequest?:(params:unknown,options:unknown)=>Promise<{action:'accept'|'decline'|'cancel';content?:Record<string,unknown>}>;openLink?:(url:string)=>Promise<unknown>;openBrowser?:(url:string)=>Promise<unknown>};

// Ordinary install entry. Native is loaded lazily from the selected public
// configuration, with the same real tools and choices used by stdio clients.
// OpenCode continues to own its providers, conversation and unsent prompt.
export function createNativeGalaxyPlugin({configPath,dataDirectory:installedDirectory,endpoint:installedEndpoint,backend=process.env.GALAXY_NATIVE_BACKEND==='go'?'go':'javascript',executable, onInputRequest,openLink,openBrowser}:Options={}){
  const diagnostics=nativeDiagnostics('host-client');
  return createGalaxyPlugin(async()=>{
  // The public service configuration locates the same user-owned local store.
  // Reading it does not start Native, authenticate or run a model.
  let dataDirectory = installedDirectory??process.env.GALAXY_DATA_DIR;
  let identityEndpoint=installedEndpoint,connectionUnavailable=false;
  let readLocalIdentity:((directory:string)=>Promise<{id:string}|null>)|undefined;
  let onWorkSessionComplete:((input:{galaxyId:string;host:string;sessionId:string})=>Promise<unknown>)|undefined;
  const selected = configPath ?? process.env.GALAXY_NATIVE_CONFIG;
  const hostPersistence=backend==='go'?createHostLocalClient({configPath:selected,executable}):undefined;
  if(hostPersistence)readLocalIdentity=async()=>hostPersistence.history.identity() as Promise<{id:string}|null>;
  if(backend!=='go'){
    const local=await legacyHostConfiguration({dataDirectory,endpoint:identityEndpoint,selected,diagnostics});
    dataDirectory=local.dataDirectory;readLocalIdentity=local.readLocalIdentity;
    onWorkSessionComplete=local.onWorkSessionComplete;connectionUnavailable=local.connectionUnavailable;
  }
  let hostApi:StableHostApi|undefined;
  const bridge=createNativeRuntimeBridge({configPath,backend,executable,onInputRequest:onInputRequest??createHostInputHandler(()=>hostApi),...(openBrowser?{openBrowser}:{})});
  if(backend==='go')onWorkSessionComplete=input=>bridge.sessionComplete(input);
  const adapter=createGalaxyAdapter(null,{dataDirectory,readLocalIdentity,onWorkSessionComplete,hostPersistence,connectionUnavailable,nativeTools:{call:bridge.call,...(openLink?{openLink}: {})}});
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
