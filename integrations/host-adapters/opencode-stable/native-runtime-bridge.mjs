import {createGoRuntimeBridge} from './bridge/go-runtime.mjs';

// Normal source and packaged hosts use the same Go runtime. Historical JS
// protocol fixtures import bridge/legacy-runtime.mjs explicitly.
export function createNativeRuntimeBridge(options={}){
 const backend=options.backend??process.env.GALAXY_NATIVE_BACKEND??'go';
 if(backend!=='go')throw Error('native_bridge_backend_invalid');
 return createGoRuntimeBridge(options);
}
