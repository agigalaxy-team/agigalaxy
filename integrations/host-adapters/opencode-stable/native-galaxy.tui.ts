import {createGalaxyAdapter,createGalaxyPlugin} from './galaxy.tui.ts';
import {createNativeRuntimeBridge} from './native-runtime-bridge.mjs';
import {readNativeConfiguration} from '../../../packages/galaxy-edge-mcp/src/native-v2/configuration.mjs';
import {createNativeStore} from '../../../packages/galaxy-edge-mcp/src/native-v2/store.mjs';
import {readJson,localPaths,resolveDataDir} from '../../../packages/galaxy-core/src/storage/files.mjs';
import type {StableHostApi} from './adapter-types.ts';
import {nativeDiagnostics} from '../../../packages/galaxy-edge-mcp/src/native-v2/diagnostics.mjs';
export {prepareOpenCodeLocalWork} from './local-preparation.mjs';

type Options={configPath?:string;dataDirectory?:string;endpoint?:string;openLink?:(url:string)=>Promise<unknown>;openBrowser?:(url:string)=>Promise<unknown>};

// Ordinary install entry. Native is loaded lazily from the selected public
// configuration, with the same real tools and choices used by stdio clients.
// OpenCode continues to own its providers, conversation and unsent prompt.
export function createNativeGalaxyPlugin({configPath,dataDirectory:installedDirectory,endpoint:installedEndpoint,openLink,openBrowser}:Options={}){
  const diagnostics=nativeDiagnostics('host-client');
  return createGalaxyPlugin(async()=>{
  // The public service configuration locates the same user-owned local store.
  // Reading it does not start Native, authenticate or run a model.
  let dataDirectory = resolveDataDir(installedDirectory??process.env.GALAXY_DATA_DIR);
  let identityEndpoint=installedEndpoint,connectionUnavailable=false;
  let readLocalIdentity:((directory:string)=>Promise<{id:string}|null>)|undefined;
  let onWorkSessionComplete:((input:{host:string;sessionId:string})=>Promise<unknown>)|undefined;
  const selected = configPath ?? process.env.GALAXY_NATIVE_CONFIG;
  if (selected) {
    try {
      const config=await readNativeConfiguration(selected);
      if(!config)throw new Error('Galaxy selected configuration unavailable.');
      dataDirectory=config.dataDirectory;
      identityEndpoint=config.endpoint;
      onWorkSessionComplete=async({host,sessionId})=>{
        const {syncSelectedArchivesForSession}=await import('../../../packages/galaxy-edge-mcp/src/native-v2/archive-sync-bridge.mjs');
        return syncSelectedArchivesForSession({dataDirectory:config.dataDirectory,nativeConfiguration:{endpoint:config.endpoint,website:config.website,trustedKeys:config.trustedKeys},host,sessionId});
      };
    }catch(error){diagnostics.emit({event:'host_bridge',stage:'configuration',outcome:'failed',host:'opencode',error});connectionUnavailable=true;}
  }
  if(identityEndpoint){
      const local=createNativeStore(dataDirectory),endpoint=identityEndpoint;
      readLocalIdentity=async directory=>{
        const current=await local.readWithin(directory,'native-active:'+endpoint);
        const genesis=await readJson(localPaths(directory).identity,null)??await readJson(localPaths(directory).legacyIdentity,null);
        if(current?.subjectId)return current.subjectId===genesis?.id?genesis:{id:current.subjectId};
        return genesis;
      };
  }
  const bridge=createNativeRuntimeBridge({configPath,...(openBrowser?{openBrowser}:{})});
  const adapter=createGalaxyAdapter(null,{dataDirectory,readLocalIdentity,onWorkSessionComplete,connectionUnavailable,nativeTools:{call:bridge.call,...(openLink?{openLink}: {})}});
  let unregister:(()=>void)|undefined;
  return{
   ...adapter,
   tui:async(api:StableHostApi)=>{
    const stop=()=>{bridge.close().catch((error:unknown)=>diagnostics.emit({event:'host_bridge',stage:'shutdown',outcome:'failed',host:'opencode',error}));};
    unregister=api.lifecycle?.onDispose(stop);
    if(api.lifecycle?.signal.aborted){stop();unregister?.();return;}
    try{await adapter.tui(api);}catch(error){await bridge.close();unregister?.();throw error;}
   },
   close:async()=>{await adapter.close();unregister?.();unregister=undefined;await bridge.close();},
  };
 });
}

const plugin=createNativeGalaxyPlugin();
export default plugin;
