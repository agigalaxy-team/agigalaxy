import {Plugin} from '@opencode/plugin/tui';
import {createNativeGalaxyPlugin} from './native-galaxy.tui.ts';
import {createV2Host} from './v2-host-adapter.mjs';

export function createNativeGalaxyPluginV2(options: Parameters<typeof createNativeGalaxyPlugin>[0] = {}) {
 return Plugin.define({id:'galaxy.opencode.stable.tui',async setup(context) {
  let shutdown: (()=>Promise<void>) | undefined;
  const host=createV2Host(context), plugin=createNativeGalaxyPlugin({...options,registerShutdown: fn=>{shutdown=fn;}});
  try {await plugin.tui(host.api as any);} catch(error) {host.close();throw error;}
  return async ()=>{host.close();await shutdown?.();};
 }});
}
export default createNativeGalaxyPluginV2();
