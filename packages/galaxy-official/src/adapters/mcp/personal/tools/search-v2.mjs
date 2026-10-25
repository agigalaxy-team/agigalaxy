import { searchV2QuerySchema, searchV2ReferenceSchema, searchV2Scope } from '../../../../shared/search-v2-schema.mjs';
export function searchToolDefinitions(services,actor) {
  return {
    galaxy_search_v2_query: { scope: input => searchV2Scope(input.type), inputSchema: searchV2QuerySchema,
      description: 'Read one current authorized source: actual attempts/failures/interventions/history, Capsule, v2 CI Proof, active Task, functional opportunity or declared Worker/Hub. Keep each source cursor and failure separate. Relevant history is only a basis for help, not its only form; explain current conditions with the user model. Does not contact, publish, infer expertise or run a cloud model.',
      run: input => services.search.v2.query(actor,input) },
    galaxy_search_v2_reference: { scope: input => searchV2Scope(input.search.type), inputSchema: searchV2ReferenceSchema,
      description: 'Recheck a previously visible candidate reference using its original source query and current viewer. Reports current, changed or unavailable-in-current-query; no revoked cached body is restored. A prior recommendation is not a current invitation or successful application.',
      run: input => services.search.v2.reference(actor,input) },
  };
}
