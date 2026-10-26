import { postPublicJson, validatePublicUrl } from "../infrastructure/public-fetch.mjs";
import { discoveryQuerySchema, discoverySaveSchema, discoveryPageSchema, discoveryPreferencesViewSchema } from "../shared/discovery-schema.mjs";
export { projectDescriptionSchema, discoveryPreferencesSchema } from "../shared/discovery-schema.mjs";

// The existing discovery client finds service Manifests. This client queries
// project opportunities after an explicitly established Galaxy session.
export function createProjectDiscoveryClient({ endpoint, sessions, send = postPublicJson, validateEndpoint = validatePublicUrl }) {
  if (validateEndpoint(endpoint).origin !== endpoint || !sessions) throw new Error('Invalid project discovery configuration.');
  async function invoke(path, input, scope, schema, signal) {
    signal?.throwIfAborted(); const actor = await sessions.readAuthorization(endpoint);
    if (!actor?.scopes.includes(scope)) throw new Error('Project discovery authorization required.');
    const check = async () => {
      signal?.throwIfAborted();
      if (!sessions.matchesAuthorization(actor) || !await sessions.isAuthorizationCurrent(actor)) throw new Error('Project discovery authorization changed.');
      signal?.throwIfAborted();
    };
    try {
      await check(); const result = await send(endpoint + path, { bodyJson: JSON.stringify(input), credential: actor.credential, signal, maxBytes: 1048576 });
      await check(); return schema.parse(result);
    } catch (error) { if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(actor, 'remote-rejected'); throw error; }
  }
  return Object.freeze({
    async query(input, { signal } = {}) {
      const query = discoveryQuerySchema.parse(input);
      const result = await invoke('/v1/discovery/query', query, 'history', discoveryPageSchema, signal);
      if (result.items.length > query.limit || result.items.some(item => item.sources[0].projectId !== query.projectId
        || item.sources[1].subjectId !== item.subjectId || item.sources[1].projectId !== item.project.id)) throw new Error('Discovery source mismatch.');
      return result;
    },
    preferences(_input = {}, { signal } = {}) { return invoke('/v1/discovery/preferences/read', {}, 'notifications', discoveryPreferencesViewSchema, signal); },
    save(input, { signal } = {}) { return invoke('/v1/discovery/preferences/save', discoverySaveSchema.parse(input), 'notifications', discoveryPreferencesViewSchema, signal); },
  });
}
