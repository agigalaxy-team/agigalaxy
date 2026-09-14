import { createGalaxyAdapter, createGalaxyPlugin } from './galaxy.tui.ts';
import { createConfiguredRuntime } from './configured-runtime.mjs';

type ConfiguredOptions = Pick<NonNullable<Parameters<typeof createGalaxyAdapter>[1]>, 'readCaseSubmission'> & {
  discoveryTransport?: Parameters<typeof createConfiguredRuntime>[1];
};

// The host owns this instance and calls close() on unload. No global install.
export function createConfiguredGalaxyAdapter(configuration: Parameters<typeof createConfiguredRuntime>[0],
  { readCaseSubmission = null, discoveryTransport }: ConfiguredOptions = {}) {
  const discovery = createConfiguredRuntime(configuration, discoveryTransport);
  const adapter = createGalaxyAdapter(null, { discovery, dataDirectory: configuration.dataDirectory, readCaseSubmission });
  return adapter;
}

type HostConfiguration = Parameters<typeof createConfiguredRuntime>[0];
export function createConfiguredGalaxyPlugin(configuration: HostConfiguration | (() => HostConfiguration | Promise<HostConfiguration>),
  options: Parameters<typeof createConfiguredGalaxyAdapter>[1] = {}) {
  // The host deactivates the previous plugin before selecting new configuration.
  // Resolving on each activation avoids retaining a stale identity or endpoint.
  return createGalaxyPlugin(async () => createConfiguredGalaxyAdapter(
    typeof configuration === 'function' ? await configuration() : configuration, options));
}
