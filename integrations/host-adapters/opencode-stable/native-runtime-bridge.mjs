import {createGoRuntimeBridge} from './bridge/go-runtime.mjs';

// Source and packaged hosts use the same Go runtime.
export function createNativeRuntimeBridge(options={}){
 const backend=options.backend??process.env.GALAXY_NATIVE_BACKEND??'go';
 if(backend!=='go')throw Error('native_bridge_backend_invalid');
 return createGoRuntimeBridge(options);
}
