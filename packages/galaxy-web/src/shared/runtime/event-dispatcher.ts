import type { QueryClient } from '@tanstack/react-query';
import { galaxyQueryKey, type GalaxyQueryScope } from './query-client';

export type GalaxyWebEvent = { type: 'change' | 'reset' | 'snapshot'; cursor: string;
  modules?: string[]; module?: string; operationId?: string | null; objectId?: string; parentId?: string; turnId?: string; entity?: 'conversation-operation'|'conversation-card'|'conversation-context'|'conversation-tool'|'configuration'; version?: string | number; reason?: 'replay-gap' | 'access-changed' };
export type GalaxyEventCallbacks={onChange?:(event:GalaxyWebEvent)=>void;onResync?:(modules:string[])=>void};

export function createGalaxyEventDispatcher(queryClient: QueryClient, scope: GalaxyQueryScope,
  onReset?: (modules: string[]) => void, initialCursor = '0', callbacks:GalaxyEventCallbacks = {}) {
  let cursor = /^\d+$/.test(initialCursor) ? initialCursor : '0';
  const resets = new Set<string>();
  const invalidate = (module: string) => queryClient.invalidateQueries({ queryKey: galaxyQueryKey(scope, module), refetchType: 'active' });
  return {
    get cursor() { return cursor; },
    async dispatch(event: GalaxyWebEvent) {
      if (!/^\d+$/.test(event.cursor)) return;
      if (event.type === 'change' && BigInt(event.cursor) <= BigInt(cursor)) return;
      if (BigInt(event.cursor) > BigInt(cursor)) cursor = event.cursor;
      if (event.type === 'snapshot') return;
      if (event.type === 'reset') {
        const modules = [...new Set(event.modules ?? [])];
        const resetKey = JSON.stringify([event.cursor, [...modules].sort(),event.reason]);
        if (resets.has(resetKey)) return;
        resets.add(resetKey);
        if (resets.size > 256) resets.delete(resets.values().next().value!);
        // A missing replay window means fetch a current snapshot; it does not
        // revoke the material already on screen. Explicit authority resets and
        // older servers without a reason retain the conservative clear path.
        if(event.reason==='replay-gap'){
          callbacks.onResync?.(modules);
          for(const module of modules)void invalidate(module).catch(()=>{});
          return;
        }
        // Remove revoked/stale projections before any recovery read can fail.
        for (const module of modules) {
          await queryClient.resetQueries({ queryKey: galaxyQueryKey(scope, module), type: 'inactive' });
          await queryClient.resetQueries({ queryKey: galaxyQueryKey(scope, module), type: 'active' });
        }
        onReset?.(modules); return;
      }
      if (event.module) {callbacks.onChange?.(event);void invalidate(event.module).catch(()=>{});}
    },
  };
}
