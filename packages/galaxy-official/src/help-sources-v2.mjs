import { searchV2QuerySchema, searchV2Scope } from './shared/search-v2-schema.mjs';
import { discoveryQueryV2Schema, opportunityRefV2Schema } from './shared/discovery-schema-v2.mjs';
import { postPublicJson, validatePublicUrl } from './public-fetch.mjs';

// These clients run in the user's process and reuse current public services.
// Legacy source adapters remain separate so existing queries are not reinterpreted.
export function createHelpSourcesV2({ endpoint, sessions, send = postPublicJson, validateEndpoint = validatePublicUrl }) {
  if (validateEndpoint(endpoint).origin !== endpoint || !sessions) throw new Error('help_source_config_invalid');
  function client(kind, schema, path, scope) {
    return { async query(input, { signal } = {}) {
      const request = schema.parse(input); signal?.throwIfAborted();
      const auth = await sessions.readAuthorization(endpoint);
      if (!auth?.scopes.includes(scope(request))) throw new Error('help_source_authorization_required');
      const check = async () => {
        signal?.throwIfAborted();
        if (!sessions.matchesAuthorization(auth) || !await sessions.isAuthorizationCurrent(auth)) throw new Error('help_source_authorization_changed');
        signal?.throwIfAborted();
      };
      try {
        await check();
        const page = await send(endpoint + path, { bodyJson: JSON.stringify(request), credential: auth.credential, signal, maxBytes: 1048576 });
        await check();
        const limit = kind === 'search-v2' ? request.query.limit : request.limit;
        if (page?.schemaVersion !== 2 || page.capabilityVerified !== false || !Array.isArray(page.items) || page.items.length > limit
          || page.endpoint && page.endpoint !== endpoint) throw new Error('help_source_response_invalid');
        if (kind === 'search-v2') {
          if (page.type !== request.type || !Number.isInteger(page.checkedAt) || page.checkedAt < 0
            || !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length <= 4096)
            || page.items.some(item => item.type !== request.type || item.ref?.id !== item.id
              || !/^[a-f0-9]{64}$/.test(item.ref?.version) || item.sourceVersion !== item.ref.version
              || item.capabilityVerified !== false || !item.source || !item.record)) throw new Error('help_source_response_invalid');
        } else if (!Number.isInteger(page.computedAt) || page.computedAt < 0
          || !(page.nextAfter === null || typeof page.nextAfter === 'string' && page.nextAfter.length <= 4096)
          || page.items.some(item => !/^[a-f0-9]{64}$/.test(item.id) || item.capabilityVerified !== false
            || !opportunityRefV2Schema.safeParse(item.opportunityRef).success || item.subjectId !== item.opportunityRef.subjectId)) {
          throw new Error('help_source_response_invalid');
        }
        return { ...page, endpoint, source: 'endpoint-reported' };
      } catch (error) {
        if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(auth, 'remote-rejected');
        throw error;
      }
    } };
  }
  return {
    'search-v2': client('search-v2', searchV2QuerySchema, '/v2/search/query', request => searchV2Scope(request.type)),
    'discovery-v2': client('discovery-v2', discoveryQueryV2Schema, '/v2/discovery/query', () => 'history'),
  };
}
