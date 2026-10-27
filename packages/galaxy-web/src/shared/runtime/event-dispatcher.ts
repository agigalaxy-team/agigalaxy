import type { QueryClient } from '@tanstack/react-query';
import { galaxyQueryKey, type GalaxyQueryScope } from './query-client';

export type GalaxyWebEvent = { type: 'change' | 'reset' | 'snapshot'; cursor: string;
  modules?: string[]; module?: string; operationId?: string | null; objectId?: string; parentId?: string; version?: string | number };

export function createGalaxyEventDispatcher(queryClient: QueryClient, scope: GalaxyQueryScope,
  onReset?: (modules: string[]) => void, initialCursor = '0') {
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
        const resetKey = JSON.stringify([event.cursor, [...modules].sort()]);
        if (resets.has(resetKey)) return;
        resets.add(resetKey);
        if (resets.size > 256) resets.delete(resets.values().next().value!);
        // Remove revoked/stale projections before any recovery read can fail.
        for (const module of modules) {
          await queryClient.resetQueries({ queryKey: galaxyQueryKey(scope, module), type: 'inactive' });
          await queryClient.resetQueries({ queryKey: galaxyQueryKey(scope, module), type: 'active' });
        }
        onReset?.(modules); return;
      }
      if (event.module) await invalidate(event.module);
    },
  };
}
