import * as z from 'zod/v4';
import { helpSessionCreateSchema, helpQuerySchema, helpOfferDraftSchema,helpActionPrepareSchema,helpActionExecuteSchema } from '../../galaxy-official/src/shared/help-schema-v2.mjs';

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
  help_action_preview_changed: 'reread-exact-action-preview-before-authorization',
  help_authorization_preview_changed: 'reread-original-preview-and-use-its-current-authorization-request-id',
  help_authorization_refresh_required: 'prepare-same-business-operation-and-unchanged-bytes-for-a-fresh-exact-authorization',
  help_authorization_renewal_requires_absence: 'reconcile-original-receipt-before-renewing-authorization',
  help_context_expired: 'prepare-new-context-scope-after-current-source-and-participation-review',
  help_exact_authorization_unavailable: 'use-a-connected-current-device-with-a-user-choice-surface',
  help_action_unavailable: 'locate-original-session-and-operation-do-not-create-another-id',
  help_action_scope_changed: 'refresh-task-recipient-and-material-scope-before-new-preview',
  help_task_version_changed: 'refresh-current-task-before-preparing-new-bytes',
  help_participation_version_changed: 'refresh-current-participation-before-preparing-new-bytes',
  help_context_scope_changed: 'refresh-current-participation-and-material-permission',
  help_context_material_changed: 'reread-original-grant-material-hash',
  help_selected_participant_mismatch: 'use-the-participant-in-the-actual-selected-source',
  help_participation_unavailable: 'refresh-original-task-and-current-participation',
  help_action_target_mismatch: 'use-the-original-task-and-participation-reference',
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
export function registerHelpTools(server, { flow,review }) {
  if (!flow?.start) throw new Error('Local HelpFlow required.');
  const id = { sessionId: z.uuid() }, revision = { expectedRevision: z.number().int().positive() };
  const networkTools = new Set(['galaxy_help_query', 'galaxy_help_publish', 'galaxy_help_reconcile', 'galaxy_help_refresh', 'galaxy_help_return','galaxy_help_review','galaxy_help_prepare_action','galaxy_help_reconcile_action']);
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
  if(typeof flow.review==='function')add('galaxy_help_review',z.strictObject(id),
    'Reread selected help sources and current Task responses separately. Withholds unavailable source bodies; recommendations are not applications or commitments.',input=>flow.review(input.sessionId));
  if(typeof flow.prepareAction==='function')add('galaxy_help_prepare_action',z.strictObject({...id,...helpActionPrepareSchema.shape}),
    'Prepare one exact original Task/Participation/Context action. Returns actual bytes, recipients, scope, materials, hash and authorizationRequestId for review, including without MCP Apps. Renew only an expired prepared or confirmed absent operation using the same business ID and bytes; never renew unknown/ACK. Does not authorize or submit.',
    ({sessionId,...input})=>flow.prepareAction(sessionId,input),true);
  if(typeof flow.actionPreview==='function')add('galaxy_help_action_preview',z.strictObject({...id,operationId:z.uuid()}),
    'Read the stored exact action preview before user authorization. An acknowledged action keeps receipt references and no longer retains draft bodies.',
    ({sessionId,operationId})=>flow.actionPreview(sessionId,operationId));
  if(typeof flow.executeAction==='function')server.registerTool('galaxy_help_execute_action',{
    inputSchema:z.strictObject({...id,...helpActionExecuteSchema.shape}),annotations:{readOnlyHint:false,openWorldHint:true},
    description:'Execute the unchanged prepared action after actual user review of its exact content, recipients, scope and current authorizationRequestId. Use the nonce in the original preview; expired scope requires same-business-ID prepare and a fresh exact review. ACK returns its original receipt; unknown requires original reconciliation, never blind resubmission.',
  },async({sessionId,...input},ctx)=>{
    try{
      const preview=await flow.actionPreview(sessionId,input.operationId);
      if(preview.payloadHash!==input.payloadHash)throw Error('help_action_preview_changed');
      const operation=()=>flow.executeAction(sessionId,input);
      if(!['prepared','absent'].includes(preview.state))return{content:[{type:'text',text:JSON.stringify(await operation())}]};
      if(preview.authorizationRequestId&&(input.authorizationRequestId??input.operationId)!==preview.authorizationRequestId)throw Error('help_authorization_preview_changed');
      if(typeof review!=='function')throw Error('help_exact_authorization_unavailable');
      return await review('galaxy_help_execute_action',{sessionId,...input,preview},ctx,operation);
    }catch(error){const result=failure(error);return{isError:true,structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};}
  });
  if(typeof flow.reconcileAction==='function')add('galaxy_help_reconcile_action',z.strictObject({...id,operationId:z.uuid()}),
    'Read the receipt for this original prepared action and hash. Does not create a new Consent, retry the business write or claim current permission.',
    ({sessionId,...input})=>flow.reconcileAction(sessionId,input),true);
}
