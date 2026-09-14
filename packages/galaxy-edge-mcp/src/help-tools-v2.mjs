import * as z from 'zod/v4';
import { helpSessionCreateSchema, helpQuerySchema, helpOfferDraftSchema } from '../../galaxy-official/src/shared/help-schema-v2.mjs';

const recoveryByCode = Object.freeze({
  help_session_changed: 'reread-session-and-use-current-revision',
  help_session_not_found: 'locate-original-local-session-do-not-republish',
  help_identity_changed: 'restore-original-identity-before-reading-session',
  help_endpoint_changed: 'restore-original-service-before-retrying',
  help_scope_mismatch: 'use-original-identity-and-service',
  help_basis_not_observed: 'query-current-source-before-composing',
  help_reuse_source_required: 'query-current-capsule-or-history-source',
  help_participant_not_observed: 'query-actual-participant-source',
  help_selection_refresh_required: 'refresh-source-and-review-selection',
  help_selected_offer_immutable: 'retain-selected-snapshot-or-explicitly-deselect-before-editing',
  help_reconcile_original_operation: 'reconcile-original-operation-do-not-resubmit',
  help_operation_conflict: 'retain-original-operation-id-and-bytes',
  help_original_task_mismatch: 'use-original-task-reference',
  help_receipt_mismatch: 'reconcile-original-operation-do-not-resubmit',
  help_receipt_unavailable: 'restore-task-client-and-reconcile-original-operation',
  help_task_client_unavailable: 'restore-task-client-before-publication',
  help_local_storage_full: 'retain-pending-receipts-and-review-local-storage',
});

function failure(error) {
  // Only fixed local codes leave this boundary. Arbitrary exception text can
  // contain response bodies, paths or credentials and must never be echoed.
  const candidate = error?.code ?? error?.message;
  const code = Object.hasOwn(recoveryByCode, candidate) ? candidate : 'help_operation_failed';
  return { error: code, recovery: recoveryByCode[code] ?? 'reread-local-session-and-original-receipt-before-retrying-writes',
    automaticRetryAuthorized: false, remoteOperationsCanceled: false };
}

// The host injects a local HelpFlow with authorized clients. This module never
// creates a login or stores help choices on a server. No background model loop.
export function registerHelpTools(server, { flow }) {
  if (!flow?.start) throw new Error('Local HelpFlow required.');
  const id = { sessionId: z.uuid() }, revision = { expectedRevision: z.number().int().positive() };
  const networkTools = new Set(['galaxy_help_query', 'galaxy_help_publish', 'galaxy_help_reconcile', 'galaxy_help_refresh', 'galaxy_help_return']);
  const add = (name, inputSchema, description, run, write = false) => server.registerTool(name,
    { inputSchema, description, annotations: { readOnlyHint: !write, destructiveHint: name === 'galaxy_help_forget', openWorldHint: networkTools.has(name) } },
    async input => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await run(input)) }] }; }
      catch (error) { const result = failure(error); return { isError: true, structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }; }
    });
  add('galaxy_help_start', helpSessionCreateSchema, 'Create a local HelpSession linked to the original conversation. Does not query, publish or invite.', input => flow.start(input), true);
  add('galaxy_help_get', z.strictObject(id), 'Read local help choices, original-task reference and separate query/publication states.', input => flow.get(input.sessionId));
  add('galaxy_help_query', z.strictObject({ ...id, ...helpQuerySchema.shape }),
    'After user query consent, use search-v2 for current history/Case, Capsule, Proof, Task, opportunity, Worker/Hub pages, or discovery-v2 for current functional project opportunities. search/discovery remain explicit legacy sources for old data. Returns actual pages, exact source versions and separate failure states; paginate each source independently. Does not publish; the user model explains concrete help and conditions.',
    ({ sessionId, ...input }) => flow.query(sessionId, input), true);
  add('galaxy_help_compose', z.strictObject({ ...id, ...revision, offers: z.array(helpOfferDraftSchema).max(32) }),
    'Save user-agent explanations using observed source keys. Separate paths, participants, intervention kinds and basis. No private chain-of-thought. Empty paths remain available.',
    ({ sessionId, ...input }) => flow.compose(sessionId, input), true);
  add('galaxy_help_select', z.strictObject({ ...id, ...revision, offerIds: z.array(z.uuid()).max(32) }),
    'Record the user choice locally. Multiple choices are allowed. Selecting a Capsule is not successful reuse and never publishes or contacts anyone.',
    ({ sessionId, ...input }) => flow.select(sessionId, input), true);
  add('galaxy_help_pause', z.strictObject({ ...id, ...revision, state: z.enum(['active', 'paused']) }),
    'Pause/resume this local help view. Does not cancel actual collaboration or messages.', ({ sessionId, ...input }) => flow.pause(sessionId, input), true);
  add('galaxy_help_publish', z.strictObject({ ...id, consentId: z.uuid(), payloadJson: z.string().min(1).max(24000) }),
    'Publish already-reviewed exact Task bytes with existing signed Consent via the authorized Task client. Query approval alone is insufficient. Candidate query results are independent.',
    ({ sessionId, ...input }) => flow.publish(sessionId, input), true);
  add('galaxy_help_reconcile', z.strictObject({ ...id, operationId: z.uuid() }),
    'Recover the original publish receipt by stable operation ID and hash. Does not resend or invite.', input => flow.reconcile(input.sessionId, input.operationId), true);
  add('galaxy_help_refresh', z.strictObject(id), 'Read current Task responses/participations through current permissions and update local linked Case metadata for the original conversation.', input => flow.refresh(input.sessionId), true);
  add('galaxy_help_return', z.strictObject({ ...id, ...revision }),
    'Return stable IDs, actual authorized Task data and existing commitments to the original conversation. Does not mark success or cancel collaboration.',
    ({ sessionId, ...input }) => flow.returnToTask(sessionId, input), true);
  add('galaxy_help_forget', z.strictObject(id), 'Delete the local help selection record only. Existing remote operations remain and are not canceled.', input => flow.forget(input.sessionId), true);
}
