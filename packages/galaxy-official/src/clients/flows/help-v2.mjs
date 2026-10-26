import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { helpQuerySchema, helpOfferDraftSchema, helpBasisSchema, helpPaths } from "../../shared/help-schema-v2.mjs";
import { taskRequestV2Schema } from "../../shared/task-schema-v2.mjs";
import {hasTaskMaterials} from "../../shared/task-material-v1-schema.mjs";
import { createHelpActionFlowV2 } from "./help-action-v2.mjs";

const digest = value => createHash('sha256').update(value).digest('hex');
const unique = values => [...new Set(values)];
const subject = value => typeof value === 'string' && /^GUID[0-9A-Z]{28}$/.test(value);
const currentKeys = row => new Set(row.queries.filter(q => ['ready', 'empty'].includes(q.state)).flatMap(q => q.basisKeys));
const errorCode = error => ['not_found', 'binding_revoked', 'insufficient_scope', 'consent_revoked'].includes(error?.code) ? error.code : 'source_failed';

function sourceRefs(kind, page, endpoint, now) {
  if (!page || page.endpoint && page.endpoint !== endpoint || !Array.isArray(page.items) || page.items.length > 40) throw new Error('help_source_invalid');
  if (kind === 'search-v2' || kind === 'discovery-v2') return page.items.map(item => {
    const discovery = kind === 'discovery-v2', record = discovery ? item : item.record;
    const source = discovery ? item.opportunityRef : item.source;
    const locator = Object.fromEntries(['sourceKind', 'id', 'versionId', 'version', 'schemaVersion', 'key', 'projectionRule',
      'subjectId', 'projectId', 'statementId', 'documentEventId', 'policyEventId', 'recruitmentId', 'eventId',
      'taskId', 'operationId', 'declarationId', 'declarationHash', 'revision'].filter(key => source[key] !== undefined).map(key => [key, source[key]]));
    locator.apiVersion = 2;
    const sourceRevision = discovery ? digest(JSON.stringify({ source, help: record.help, willingness: record.willingness, match: record.match })) : item.ref.version;
    locator.contentVersion = sourceRevision;
    // Only explicit actors in the authorized page qualify as observed participants.
    // Do not infer an executor from unrelated IDs or count only the last solver.
    const participants = unique([record.subjectId, record.requesterId, record.authorId, record.ownerId,
      record.participant?.subjectId, record.reportedBy,
      ...['attempts', 'interventions', 'results', 'verificationRecords', 'participation', 'participations'].flatMap(field =>
        (record[field] ?? []).flatMap(row => [row.actorId, row.subjectId, row.reportedBy])),
      ...(record.contributors ?? []).filter(value => typeof value === 'string'),
    ].filter(subject));
    return helpBasisSchema.parse({ key: digest(JSON.stringify([endpoint, kind, item.id, sourceRevision])),
      kind: discovery ? 'project-match' : item.type, id: item.id, sourceRevision, locator,
      checkedAt: now, classification: discovery || ['opportunity', 'worker', 'hub'].includes(item.type) ? 'self-declared' : 'source-record',
      participantIds: participants.slice(0, 16), participantIdsTruncated: participants.length > 16,
      capabilityVerified: false, availability: 'unknown' });
  });
  return page.items.map(item => {
    const source = kind === 'search' ? item.source : item.sources;
    if (!source || typeof item.id !== 'string') throw new Error('help_source_invalid');
    const locator = kind === 'search' ? Object.fromEntries(['kind', 'id', 'versionId', 'version', 'sourceVersion', 'projectionRule',
      'declarationId', 'declarationHash', 'revision', 'evidenceId', 'observationId'].filter(key => source[key] !== undefined).map(key => [key, source[key]]))
      : { projectIds: source.map(s => s.projectId), statementIds: source.map(s => s.statementId) };
    const revision = JSON.stringify(locator);
    // Exact source descriptor digest covers immutable Proof / statement IDs as
    // well as sources that expose numeric versions. It is not a capability mark.
    const sourceRevision = digest(revision);
    const participantIds = kind === 'discovery' ? [item.subjectId]
      : [source.ownerId, item.record?.ownerId, item.record?.authorId, item.record?.subjectId].filter(subject);
    return helpBasisSchema.parse({ key: digest(JSON.stringify([endpoint, kind, item.id, sourceRevision])),
      kind: kind === 'search' ? item.type : 'project-match', id: item.id, sourceRevision, locator,
      checkedAt: now, classification: kind === 'discovery' || ['worker', 'hub'].includes(item.type) ? 'self-declared' : 'source-record',
      participantIds: unique(participantIds), capabilityVerified: false, availability: 'unknown' });
  });
}

// Runs in the user's process. sources.*.query and actions are already-authorized
// clients; they must not be constructed from model-supplied raw source records.
// Query permission never implies permission for createTask or other mutations.
export function createHelpFlowV2({ store, sources = {}, actions = {}, authorize, now = () => Math.floor(Date.now() / 1000) }) {
  if (!store?.update || !store?.get) throw new Error('help_store_required');
  function view(row) {
    const keys = currentKeys(row);
    return { ...row, localOnly: true, dataServiceProvidesModel: false,
      activeEntries: ['match', 'publish-task', 'participate-in-task'],
      requestDefaults: { visibility: 'Public', disclosure: 'reviewed-selected-summary', automaticPublication: false },
      paths: helpPaths.map(path => ({ path, supported: true,
        offerIds: row.offers.filter(o => o.path === path).map(o => o.id),
        state: row.offers.some(o => o.path === path) ? 'options-described' : 'no-concrete-option-known' })),
      offers: row.offers.map(o => ({ ...o, sourceStatus: o.basisKeys.every(key => keys.has(key)) ? 'last-query-reference' : 'refresh-required',
        semanticAccuracy: 'user-agent-explanation-not-machine-certified', sourceRefreshRequiredBeforeAction: true })),
      warnings: ['No result describes this visible query scope only.', 'A source, selection or Capsule read is not successful reuse.',
        'Participant history does not establish willingness; paid eligibility is checked by Task operations.'],
    };
  }
  const start = async input => view(await store.create(input));
  const get = async id => view(await store.get(id));
  async function query(id, input, { signal } = {}) {
    const parsed = helpQuerySchema.parse(input); await store.get(id); signal?.throwIfAborted();
    const results = await Promise.all(parsed.requests.map(async request => {
      const at = now();
      if (!sources[request.kind]?.query) return { requestId: request.requestId, kind: request.kind, state: 'unavailable', checkedAt: at, basis: [], data: null, error: 'source_not_configured' };
      try {
        const data = await sources[request.kind].query(request.input, { signal }); signal?.throwIfAborted();
        const basis = sourceRefs(request.kind, data, store.endpoint, at);
        return { requestId: request.requestId, kind: request.kind, state: data.items.length ? 'ready' : 'empty', checkedAt: at, basis, data };
      } catch (error) {
        signal?.throwIfAborted();
        return { requestId: request.requestId, kind: request.kind, state: 'failed', checkedAt: at, basis: [], data: null, error: errorCode(error) };
      }
    }));
    const row = await store.update(id, draft => {
      const queries = new Map(draft.queries.map(q => [q.requestId, q]));
      const refs = new Map(draft.basis.map(ref => [ref.key, ref]));
      for (const result of results) {
        queries.set(result.requestId, { requestId: result.requestId, kind: result.kind, state: result.state, checkedAt: result.checkedAt,
          basisKeys: result.basis.map(b => b.key), request: parsed.requests.find(request => request.requestId === result.requestId) });
        for (const ref of result.basis) refs.set(ref.key, ref);
      }
      draft.queries = [...queries.values()].slice(-32);
      const needed = new Set([...draft.queries.flatMap(q => q.basisKeys), ...draft.offers.flatMap(o => o.basisKeys)]);
      draft.basis = [...refs.values()].filter(ref => needed.has(ref.key));
    });
    // Raw pages are returned transiently for the user's model to interpret;
    // they are deliberately excluded from the persistent local choice record.
    return { session: view(row), results, queryDoesNotPublish: true, coverage: 'requested-visible-pages-only' };
  }
  async function compose(id, { expectedRevision, offers }) {
    const parsed = z.array(helpOfferDraftSchema).max(32).refine(rows => new Set(rows.map(row => row.id)).size === rows.length).parse(offers);
    return view(await store.update(id, draft => {
      const keys = currentKeys(draft), known = new Map(draft.basis.map(b => [b.key, b]));
      const next = parsed.map(offer => {
        if (offer.basisKeys.some(key => !keys.has(key) || !known.has(key))) throw new Error('help_basis_not_observed');
        if (offer.path === 'capsule-or-history' && !offer.basisKeys.some(key => ['capsule', 'case', 'history'].includes(known.get(key).kind))) throw new Error('help_reuse_source_required');
        for (const participant of offer.participants) {
          const ref = known.get(participant.basisKey);
          if (!offer.basisKeys.includes(participant.basisKey) || !ref
            || !(ref.participantIds.includes(participant.id) || ['worker', 'hub'].includes(ref.kind) && ref.id === participant.id)) throw new Error('help_participant_not_observed');
        }
        return { ...offer, generatedBy: 'user-agent', evidenceMeaning: 'references-not-capability-verification', availability: 'unknown',
          kind: offer.basisKeys.length ? 'source-backed-option' : 'guidance', basisRefs: offer.basisKeys.map(key => known.get(key)), checkedAt: now() };
      });
      // A new query/view cannot erase an already selected snapshot. The caller
      // explicitly deselects it first; no remote cancellation is implied.
      const oldSelected = draft.offers.filter(o => draft.selectedHelpIds.includes(o.id) && !next.some(n => n.id === o.id));
      for (const previous of draft.offers.filter(o => draft.selectedHelpIds.includes(o.id))) {
        const changed = parsed.find(o => o.id === previous.id);
        const previousDraft = Object.fromEntries(Object.keys(helpOfferDraftSchema.shape).map(key => [key, previous[key]]));
        if (changed && JSON.stringify(changed) !== JSON.stringify(previousDraft)) throw new Error('help_selected_offer_immutable');
      }
      draft.offers = [...oldSelected, ...next];
    }, expectedRevision));
  }
  async function select(id, { expectedRevision, offerIds }) {
    const ids = z.array(z.uuid()).max(32).refine(values => new Set(values).size === values.length).parse(offerIds);
    return view(await store.update(id, draft => {
      const known = new Map(draft.offers.map(o => [o.id, o])), keys = currentKeys(draft);
      if (ids.some(key => !known.has(key) || known.get(key).basisKeys.some(ref => !keys.has(ref)))) throw new Error('help_selection_refresh_required');
      draft.selectedHelpIds = ids;
    }, expectedRevision));
  }
  const pause = async (id, { expectedRevision, state }) => view(await store.update(id, row => {
    row.pauseState = z.enum(['active', 'paused']).parse(state);
  }, expectedRevision));

  async function review(id, { signal } = {}) {
    const row = await store.get(id), needed = new Set(row.offers.flatMap(offer => offer.basisKeys)), statuses = new Map();
    const queries = row.queries.filter(query => query.basisKeys.some(key => needed.has(key)));
    await Promise.all(queries.map(async query => {
      let references = null;
      if (query.request && sources[query.kind]?.query) {
        try {
          signal?.throwIfAborted();
          references = sourceRefs(query.kind, await sources[query.kind].query(query.request.input, { signal }), store.endpoint, now());
        } catch { signal?.throwIfAborted(); }
      }
      for (const key of query.basisKeys.filter(key => needed.has(key))) {
        const old = row.basis.find(ref => ref.key === key), current = references?.find(ref => ref.id === old?.id && ref.kind === old.kind);
        const state = !current ? 'unavailable' : current.key === key ? 'current' : 'changed';
        const prior = statuses.get(key);
        // A failure of any independently requested source cannot be erased by
        // a successful duplicate page in the same review.
        if (!prior || prior.state === 'current') statuses.set(key, { key, state, checkedAt: now() });
      }
    }));
    const latest = await store.get(id);
    if (latest.revision !== row.revision) throw new Error('help_session_changed');
    const offers = row.offers.map(offer => {
      const basisStatuses = offer.basisKeys.map(key => statuses.get(key) ?? { key, state: 'unavailable', checkedAt: now() });
      const state = basisStatuses.some(ref => ref.state === 'unavailable') ? 'unavailable' : basisStatuses.some(ref => ref.state === 'changed') ? 'changed' : 'current';
      return { id: offer.id, state, basisStatuses, ...(state === 'current' ? { offer: { ...offer, sourceStatus: 'current-readable', checkedAt: now() } } : {}) };
    });
    // session metadata deliberately excludes old explanatory bodies. The
    // model's old reason is useful only after its exact sources reread current.
    const { offers: _offers, basis: _basis, queries: _queries, ...session } = view(row);
    return { session, offers, checkedAt: now(), sourceBodiesPersisted: false, dataServiceProvidesModel: false };
  }

  async function publish(id, submission) {
    z.strictObject({ consentId: z.uuid(), payloadJson: z.string().min(1).max(24000) }).parse(submission);
    const request = taskRequestV2Schema.parse(JSON.parse(submission.payloadJson));
    if(hasTaskMaterials(request))throw Error('task_material_atomic_route_required');
    if (!actions.createTask) throw new Error('help_task_client_unavailable');
    const payloadHash = digest(submission.payloadJson);
    await store.update(id, row => {
      if (row.actionOperations.some(op => ['submitting', 'unknown', 'conflict'].includes(op.state))) throw new Error('help_reconcile_original_operation');
      if (row.caseId && row.caseId !== request.caseId || row.taskId && row.taskId !== request.taskId) throw new Error('help_original_task_mismatch');
      const prior = row.linkedOperations.find(op => op.operationId === request.operationId);
      if (prior && (prior.payloadHash !== payloadHash || prior.taskId !== request.taskId)) throw new Error('help_operation_conflict');
      if (prior && prior.state !== 'absent') throw new Error('help_reconcile_original_operation');
      if (row.linkedOperations.some(op => ['submitting', 'unknown', 'conflict'].includes(op.state))) throw new Error('help_reconcile_original_operation');
      const op = { operationId: request.operationId, taskId: request.taskId, payloadHash, state: 'submitting', checkedAt: now() };
      if (prior) Object.assign(prior, op); else row.linkedOperations.push(op);
    });
    try {
      const receipt = await actions.createTask(submission);
      if (receipt?.taskId !== request.taskId || receipt?.eventId !== request.operationId || receipt?.version !== 1) throw new Error('help_receipt_mismatch');
      const row = await store.update(id, draft => {
        const op = draft.linkedOperations.find(o => o.operationId === request.operationId);
        Object.assign(op, { state: 'acknowledged', version: receipt.version, checkedAt: now() });
        draft.taskId = request.taskId; draft.caseId = request.caseId;
      });
      return { session: view(row), publication: { state: 'acknowledged', receipt }, invitationsSent: false, candidateQueryIndependent: true };
    } catch {
      const row = await store.update(id, draft => {
        const op = draft.linkedOperations.find(o => o.operationId === request.operationId);
        if (op.state !== 'acknowledged') Object.assign(op, { state: 'unknown', checkedAt: now() });
      });
      return { session: view(row), publication: { state: 'unknown', taskId: request.taskId, operationId: request.operationId, next: 'reconcile-original-operation' }, invitationsSent: false };
    }
  }
  async function reconcile(id, operationId) {
    z.uuid().parse(operationId);
    const row = await store.get(id), op = row.linkedOperations.find(o => o.operationId === operationId);
    if (!op || !actions.taskReceipt) throw new Error('help_receipt_unavailable');
    const query = { taskId: op.taskId, eventId: op.operationId, payloadHash: op.payloadHash };
    const receipt = await actions.taskReceipt(query);
    if (!receipt || Object.entries(query).some(([key, value]) => receipt[key] !== value) || !['absent', 'acknowledged', 'conflict'].includes(receipt.state)
      || receipt.state === 'acknowledged' && (!Number.isInteger(receipt.version) || receipt.version < 1)) throw new Error('help_receipt_mismatch');
    const next = await store.update(id, draft => {
      const operation = draft.linkedOperations.find(o => o.operationId === operationId);
      // A receipt read may finish after the original publication ACK. A late
      // absence/conflict observation must not erase that historical write.
      if (operation.state === 'acknowledged' && receipt.state !== 'acknowledged') return;
      Object.assign(operation, { state: receipt.state, checkedAt: now(), ...(receipt.version ? { version: receipt.version } : {}) });
      if (receipt.state === 'acknowledged') draft.taskId = receipt.taskId;
    });
    return { session: view(next), receipt, currentPermissionEstablished: false, invitationsSent: false };
  }
  async function recoverForRefresh(id) {
    const initial = await store.get(id), operations = [];
    const pending = state => ['submitting', 'unknown', 'conflict'].includes(state);
    const references = [...initial.linkedOperations.filter(op => pending(op.state)).map(op => ({ ...op, kind: 'publish-task', legacy: true })),
      ...initial.actionOperations.filter(op => pending(op.state)).map(op => ({ ...op, legacy: false }))];
    for (const reference of references) {
      let receiptState, error;
      try {
        // Only the already recorded event and exact payload digest are read.
        // No submission, automatic retry or new business ID is created here.
        const result = reference.legacy ? await reconcile(id, reference.operationId)
          : await actionFlow.reconcileAction(id, { operationId: reference.operationId });
        receiptState = result.receipt.state;
      } catch (failure) { receiptState = 'unavailable'; error = errorCode(failure); }
      // Local identity/endpoint guards still apply, even when the remote read
      // fails. A failed receipt must not discard another operation's result.
      const latest = await store.get(id), current = (reference.legacy ? latest.linkedOperations : latest.actionOperations)
        .find(op => op.operationId === reference.operationId);
      if (!current) throw new Error('help_session_changed');
      operations.push({ operationId: current.operationId, kind: reference.kind, taskId: current.taskId, state: current.state, receiptState,
        ...(current.participationId ? { participationId: current.participationId } : {}), ...(current.grantId ? { grantId: current.grantId } : {}),
        ...(error ? { error, next: 'reconcile-original-operation' } : {}) });
    }
    return { row: await store.get(id), reconciliation: { operations, automaticallyRetried: false, currentPermissionEstablished: false } };
  }
  async function refresh(id) {
    const { row, reconciliation } = await recoverForRefresh(id);
    if (!row.taskId) return { session: view(row), remote: null, state: 'no-acknowledged-task', reconciliation };
    if (!actions.getTask) return { session: view(row), remote: null, state: 'task-client-unavailable', reconciliation };
    try {
      const remote = await actions.getTask(row.taskId);
      if (remote?.taskId !== row.taskId || !Number.isInteger(remote.version) || remote.version < 1) throw new Error('help_task_mismatch');
      if (row.caseId && remote.caseId && row.caseId !== remote.caseId) throw new Error('help_case_mismatch');
      // A late page cannot overwrite a newer local choice/pause or attach its
      // Case to a session that changed while the current Task was being read.
      if ((await store.get(id)).revision !== row.revision) throw new Error('help_session_changed');
      const next = remote.caseId && !row.caseId ? await store.update(id, draft => { draft.caseId = remote.caseId; }, row.revision) : row;
      return { session: view(next), remote, state: 'refreshed', reconciliation, remoteDataStoredLocally: false,
        suggestionsAreResponses: false, roomAccess: 'requires-separate-room-grant' };
    } catch (error) {
      if (error.message === 'help_session_changed' || error.message === 'help_identity_changed') throw error;
      return { session: view(row), remote: null, state: 'unavailable', reconciliation, error: errorCode(error), previousReceiptsDoNotProveCurrentAccess: true };
    }
  }
  async function returnToTask(id, { expectedRevision }) {
    const initial = await store.get(id);
    if (expectedRevision !== undefined && initial.revision !== expectedRevision) throw new Error('help_session_changed');
    const result = await refresh(id);
    const row = await store.update(id, draft => { draft.pauseState = 'returned'; }, result.session.revision);
    return { ...result, session: view(row), handoff: { localTaskRef: row.localTaskRef, caseId: row.caseId, taskId: row.taskId,
      operationRefs: row.linkedOperations.map(({ operationId, taskId, state }) => ({ operationId, taskId, state })),
      actionOperationRefs: row.actionOperations,
      method: 'original-conversation-and-mcp-refresh', hostCallbackVerified: false },
      remoteOperationsCanceled: false, successFactsCreated: false, userMustDecideExistingCommitments: true };
  }
  const actionFlow = createHelpActionFlowV2({ store, actions, authorize, review, now });
  return { start, get, query, compose, select, pause, publish, reconcile, refresh, review, returnToTask, forget: store.forget, ...actionFlow };
}
