import { createLocalHelpStoreV2 } from './local-help-store-v2.mjs';
import { createHelpFlowV2 } from './help-flow-v2.mjs';
import { createSearchClient } from './search-client.mjs';
import { createProjectDiscoveryClient } from './project-discovery-client.mjs';
import { createTaskClientV2 } from './task-client-v2.mjs';
import { createHelpSourcesV2 } from './help-sources-v2.mjs';

// Trusted desktop/CLI host supplies its existing process-only session memory.
// A configured endpoint is not a connection and does not cause any I/O here.
export function createHelpRuntimeV2({ dataDirectory, endpoint, subjectId, sessions, send, read, now, readIdentityWithin }) {
  const store = createLocalHelpStoreV2({ dataDirectory, endpoint, subjectId, now, readIdentityWithin });
  if (!sessions) return createHelpFlowV2({ store, now });
  const scoped = {
    async readAuthorization(origin) {
      if (origin !== endpoint) throw new Error('help_endpoint_changed');
      const authorization = await sessions.readAuthorization(origin);
      if (authorization && authorization.subjectId !== subjectId) throw new Error('help_identity_changed');
      return authorization;
    },
    matchesAuthorization: authorization => sessions.matchesAuthorization(authorization),
    isAuthorizationCurrent: authorization => sessions.isAuthorizationCurrent(authorization),
    invalidateAuthorization: (authorization, reason) => sessions.invalidateAuthorization(authorization, reason),
  };
  const config = { endpoint, sessions: scoped, ...(send ? { send } : {}), ...(read ? { read } : {}) };
  return createHelpFlowV2({ store, now, sources: { search: createSearchClient(config), discovery: createProjectDiscoveryClient(config), ...createHelpSourcesV2(config) }, actions: createTaskClientV2(config) });
}
