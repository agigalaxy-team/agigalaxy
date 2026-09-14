import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { historyQuerySchema } from '../../galaxy-official/src/shared/history-schema.mjs';
import { searchQuerySchema } from '../../galaxy-official/src/shared/search-schema.mjs';

// Opt-in in-process host composition. No endpoint discovery, key loading or session creation.
export function registerRemoteTools(server, { controller, authorizePublication, now = () => Date.now() }) {
  if (!controller || typeof authorizePublication !== 'function') throw new Error('Trusted remote-tool host required.');
  let pending = null, preparing = false, closed = false;
  const result = payload => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
  const localId = z.string().regex(/^case_[a-f0-9]{32}$/);
  const add = (name, title, description, schema, readOnly, openWorld, run) => server.registerTool(name, {
    title, description, inputSchema: schema,
    annotations: { readOnlyHint: readOnly, openWorldHint: openWorld, destructiveHint: false }
  }, async input => {
    try { if (closed) throw new Error('Remote tools closed.'); return result(await run(input)); }
    catch { return { isError: true, ...result({ state: 'operation-failed', message: 'Operation incomplete. Check the host session or reconcile the original event before retrying.' }) }; }
  });
  const empty = z.strictObject({});
  if(controller.querySearch)add('galaxy_remote_search','Search a selected source type',
    'Explicit Case, History, Proof, Capsule, Worker or Hub query using that source scope. Worker/Hub search returns public registry metadata; registration does not establish reachability or certify ability.',
    searchQuerySchema,true,true,input=>controller.querySearch(input));
  add('galaxy_remote_history_query', 'Query authorized remote history',
    'Explicit request to the configured endpoint; sends search terms with the current session. Results are endpoint-reported, not capability certification.',
    historyQuerySchema, true, true, input => controller.queryHistory(input));
  add('galaxy_remote_case_read', 'Read a remote Case',
    'Read a Case using the current configured session; does not publish or initialize identity.',
    z.strictObject({ caseId: z.uuid() }), true, true, ({ caseId }) => controller.getCase(caseId));
  add('galaxy_publication_drafts_list', 'List local publication drafts',
    'Read local drafts and endpoint-specific mapping status. Does not send draft content.',
    empty, true, false, () => controller.listPublicationDrafts());
  add('galaxy_publication_prepare', 'Prepare local Case publication',
    'Persists a frozen local draft and Consent intent, returning their exact content. Does not sign or send. Host approval is required by the execute tool.',
    z.strictObject({ localCaseId: localId, visibility: z.enum(['Private', 'Public']).default('Private') }), false, false,
    async ({ localCaseId, visibility }) => {
      if (pending || preparing) throw new Error('Publication already pending.');
      preparing = true;
      try {
        const preview = await controller.preparePublication(localCaseId, { visibility });
        if (closed) { controller.cancelPublication(preview); throw new Error('Remote tools closed.'); }
        pending = { handle: randomUUID(), preview, expiresAt: now() + 300000, state: 'prepared' };
        return { handle: pending.handle, expiresAt: pending.expiresAt, endpoint: preview.endpoint,
          eventId: preview.eventId, intentJson: preview.intentJson, payloadJson: preview.payloadJson,
          state: 'awaiting-host-approval' };
      } finally { preparing = false; }
    });
  add('galaxy_publication_execute', 'Publish the prepared Case with host approval',
    'Requests trusted host approval of the exact preview, then creates Consent and submits Case once. No automatic retries. Caller cannot supply approval or credentials.',
    z.strictObject({ handle: z.uuid() }), false, true,
    async ({ handle }) => {
      const operation = pending;
      if (!operation || operation.handle !== handle || operation.state !== 'prepared') throw new Error('Unknown pending publication.');
      operation.state = 'approving';
      try {
        if (now() >= operation.expiresAt || await authorizePublication(operation.preview) !== true)
          throw new Error('Host approval required.');
        if (pending !== operation || now() >= operation.expiresAt) throw new Error('Publication canceled or expired.');
        operation.state = 'executing';
        return await controller.executePublication(operation.preview, operation.preview.confirmation);
      } finally {
        if (pending === operation) { pending = null; controller.cancelPublication(operation.preview); }
      }
    });
  add('galaxy_publication_cancel', 'Cancel pending publication',
    'Cancel the selected local operation. Does not undo a request already received by the endpoint.',
    z.strictObject({ handle: z.uuid() }), false, false, ({ handle }) => {
      if (!pending || pending.handle !== handle) throw new Error('Unknown pending publication.');
      const operation = pending; pending = null; controller.cancelPublication(operation.preview); return { state: 'canceled' };
    });
  add('galaxy_publication_reconcile', 'Reconcile an uncertain publication',
    'Read the original remote Case and restore the local receipt only when content matches. Does not repeat remote writes; local acknowledgement may change.',
    z.strictObject({ localCaseId: localId }), false, true,
    ({ localCaseId }) => controller.reconcilePublication(localCaseId));
  return Object.freeze({ close() {
    closed = true;
    if (pending) { const operation = pending; pending = null; controller.cancelPublication(operation.preview); }
  } });
}
