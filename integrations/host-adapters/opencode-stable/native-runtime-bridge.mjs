import {createGoRuntimeBridge} from './bridge/go-runtime.mjs';

// Explicit candidate only; the installed default retains its covered backend.
export function createNativeRuntimeBridge(options={}){
 const backend=options.backend??process.env.GALAXY_NATIVE_BACKEND??'javascript';
 if(backend==='go')return createGoRuntimeBridge(options);
 if(backend!=='javascript')throw Error('native_bridge_backend_invalid');
 let legacy,closed=false,closing;
 const load=()=>legacy??=import('./bridge/legacy-runtime.mjs').then(module=>module.createNativeRuntimeBridge(options));
 return Object.freeze({
  async call(...args){if(closed)throw Error('native_bridge_closed');return(await load()).call(...args);},
  async sessionComplete(_input={}){throw Error('native_bridge_host_notification_unavailable');},
  close(){closed=true;return closing??=(legacy?legacy.then(bridge=>bridge.close()):Promise.resolve());},
 });
}
