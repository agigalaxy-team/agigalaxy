import { QueryClient } from '@tanstack/react-query';

export type GalaxyQueryScope = Readonly<{ endpoint: string; identity: string; surface: 'web' | 'admin' | 'native' }>;
export const galaxyQueryKey = (scope: GalaxyQueryScope, module: string, ...parts: readonly unknown[]) =>
  ['galaxy', scope.endpoint.replace(/\/$/, ''), scope.surface, scope.identity, module, ...parts] as const;

export function createGalaxyQueryClient() {
  return new QueryClient({ defaultOptions: {
    queries: { staleTime: Infinity, gcTime: 5 * 60_000, refetchOnMount: query => query.state.isInvalidated,
      refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false },
    mutations: { retry: false },
  } });
}
