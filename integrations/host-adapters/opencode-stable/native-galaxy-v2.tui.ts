import {Plugin} from '@opencode/plugin/tui';
import {createNativeGalaxyPlugin} from './native-galaxy.tui.ts';
import {createV2Host} from './v2-host-adapter.mjs';
import {repairManagedOpenCodeIfNeeded} from './bridge/managed-repair.mjs';
import {createNativeDiagnostics,hostDiagnostics} from './bridge/native-diagnostics.mjs';
import {join} from 'node:path';

export function createNativeGalaxyPluginV2(options: Parameters<typeof createNativeGalaxyPlugin>[0] = {}) {
 return Plugin.define({id:'galaxy.opencode.stable.tui',async setup(context) {
  let shutdown: (()=>Promise<void>) | undefined;
  const dataDirectory=options.dataDirectory ?? process.env.GALAXY_DATA_DIR ?? process.env.GALAXY_NATIVE_DATA_DIR;
  void repairManagedOpenCodeIfNeeded({executable:options.executable ?? process.env.GALAXY_NATIVE_EXECUTABLE,configPath:options.configPath ?? process.env.GALAXY_NATIVE_CONFIG,dataDirectory}).catch(()=>{});
  const directory=process.env.GALAXY_RUNTIME_LOG_DIRECTORY ?? (dataDirectory ? join(dataDirectory,'logs') : undefined);
  const diagnostics=directory ? await createNativeDiagnostics({component:'host-client',quietFallback:true,env:{...process.env,GALAXY_RUNTIME_LOG_DIRECTORY:directory,GALAXY_RUNTIME_LOG_INSTANCE:'tui'}}) : hostDiagnostics({});
  const host=createV2Host(context,diagnostics);
  const plugin=createNativeGalaxyPlugin({...options,registerShutdown: fn=>{shutdown=fn;}});
  try {await plugin.tui(host.api as any);} catch(error) {host.close();await diagnostics.close();throw error;}
  return async ()=>{host.close();await shutdown?.();await diagnostics.close();};
 }});
}
export default createNativeGalaxyPluginV2();
