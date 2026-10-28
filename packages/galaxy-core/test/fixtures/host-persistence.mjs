import {
  getLocalSnapshot, getGalaxyIntegrationStatus, resetGalaxyIntegration,
} from '../../src/local-store.mjs';
import {getGalaxyConnectionStatus} from '../../src/connection-profile.mjs';
import {prepareOpenCodeLocalWork} from '../../../../integrations/host-adapters/opencode-stable/local-preparation.mjs';

// The UI lifecycle tests inject the trusted host boundary explicitly. These
// reference-store closures are confined to fixtures; they do not start Native,
// claim Go persistence coverage, or restore an in-process production backend.
export function hostPersistenceFixture(directory) {
  let deferred = false;
  return {
    store: {
      getLocalSnapshot: () => getLocalSnapshot(directory),
      getGalaxyIntegrationStatus: () => getGalaxyIntegrationStatus(directory),
      resetGalaxyIntegration: () => resetGalaxyIntegration(directory),
    },
    connection: {getGalaxyConnectionStatus: () => getGalaxyConnectionStatus(directory)},
    history: {identity: async () => (await getLocalSnapshot(directory)).identity},
    initialize: input => prepareOpenCodeLocalWork(directory, input),
    preparationStatus: async () => ({deferred}),
    deferPreparation: async () => { deferred = true; },
    close: async () => {},
  };
}
