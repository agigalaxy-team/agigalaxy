import {createGalaxyAdapter,createGalaxyPlugin} from './galaxy.tui.ts';
import {createNativeRuntimeBridge} from './native-runtime-bridge.mjs';
import type {StableHostApi} from './adapter-types.ts';

type Options={configPath?:string;openLink?:(url:string)=>Promise<unknown>;openBrowser?:(url:string)=>Promise<unknown>};

// Ordinary install entry. Native is loaded lazily from the selected public
// configuration, with the same real tools and choices used by stdio clients.
// OpenCode continues to own its providers, conversation and unsent prompt.
export function createNativeGalaxyPlugin({configPath,openLink,openBrowser}:Options={}){
 return createGalaxyPlugin(()=>{
  const bridge=createNativeRuntimeBridge({configPath,...(openBrowser?{openBrowser}:{})});
  const adapter=createGalaxyAdapter(null,{nativeTools:{call:bridge.call,...(openLink?{openLink}: {})}});
  let unregister:(()=>void)|undefined;
  return{
   ...adapter,
   tui:async(api:StableHostApi)=>{
    const stop=()=>{bridge.close().catch(()=>console.error('Galaxy local connection could not finish closing.'));};
    unregister=api.lifecycle?.onDispose(stop);
    if(api.lifecycle?.signal.aborted){stop();unregister?.();return;}
    try{await adapter.tui(api);}catch(error){await bridge.close();unregister?.();throw error;}
   },
   close:()=>{adapter.close();unregister?.();unregister=undefined;bridge.close().catch(()=>console.error('Galaxy local connection could not finish closing.'));},
  };
 });
}

const plugin=createNativeGalaxyPlugin();
export default plugin;
