import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { helpActionPrepareSchema, helpActionExecuteSchema } from "../../shared/help-schema-v2.mjs";
import { taskRequestV2Schema, taskEnvelopeV2Schema, participationProposalV2Schema, participationEventV2Schema } from "../../shared/task-schema-v2.mjs";
import { contextGrantV2Schema, contextEventV2Schema } from "../../shared/context-v2-schema.mjs";
import {hasTaskMaterials} from "../../shared/task-material-v1-schema.mjs";

const hash = text => createHash('sha256').update(text).digest('hex');
const schemas = { 'publish-task': taskRequestV2Schema, 'task-event': taskEnvelopeV2Schema, 'participation-propose': participationProposalV2Schema,
  'participation-event': participationEventV2Schema, 'context-grant': contextGrantV2Schema, 'context-event': contextEventV2Schema };
const fail = code => { throw new Error(code); };
const pending = state => ['submitting', 'unknown'].includes(state);
function publicationRecipients(values, payload, subjectId) {
  if (values.kind !== 'publish-task') {
    if (values.recipientIds !== undefined) fail('help_action_scope_changed');
    return [];
  }
  if (payload.visibility === 'Public' && values.recipientIds?.length) fail('help_action_scope_changed');
  const recipients = [...new Set((values.recipientIds ?? []).filter(id => id !== subjectId))].sort((a, b) => a.localeCompare(b));
  return recipients;
}

// User-process composition only. Authorization is a trusted host capability,
// invoked after its user-facing choice or an existing precise instruction.
// Model booleans, query approval and local selection are never signed Consent.
export function createHelpActionFlowV2({ store, actions, authorize, review, now }) {
  async function describe(session, input) {
    const values = helpActionPrepareSchema.parse(input), payload = schemas[values.kind].parse(JSON.parse(values.payloadJson));
    if(values.kind==='publish-task'&&hasTaskMaterials(payload))fail('task_material_atomic_route_required');
    const initialRecipients = publicationRecipients(values, payload, session.subjectId);
    if (Buffer.byteLength(values.payloadJson) > (values.kind.startsWith('context-') ? 40000 : 24000)) fail('help_action_payload_too_large');
    const event = payload.event ?? payload, operationId = event.operationId ?? event.eventId ?? event.id;
    const taskId = payload.taskId ?? values.taskId;
    z.uuid().parse(taskId);
    if (values.taskId && values.taskId !== taskId || session.taskId && session.taskId !== taskId
      || session.caseId && payload.caseId !== undefined && session.caseId !== payload.caseId) fail('help_original_task_mismatch');
    if (session.linkedOperations.some(op => pending(op.state) || op.state === 'conflict')) fail('help_reconcile_original_operation');
    if (session.actionOperations.some(op => op.operationId !== operationId && op.kind === 'publish-task' && (pending(op.state) || op.state === 'conflict'))) fail('help_reconcile_original_operation');
    let task = null, participation = null, recipientIds = [], visibility = 'Private', scope = null, materials = [];
    const participationId = payload.participationId ?? values.participationId;
    if (values.participationId && participationId !== values.participationId) fail('help_action_target_mismatch');
    if (values.kind === 'publish-task') {
      if (session.taskId) fail('help_task_already_linked');
      recipientIds = initialRecipients;
      visibility = payload.visibility; scope = { intent: payload.intent, goal: payload.workContext.goal, expectedOutcome: payload.expectedOutcome ?? null };
    } else {
      if (session.taskId !== taskId) fail('help_acknowledged_task_required');
      task = await actions.getTask(taskId);
      if (task.schemaVersion !== 2) fail('help_legacy_task_read_only');
      if (session.caseId && task.caseId && session.caseId !== task.caseId) fail('help_original_task_mismatch');
      recipientIds = [task.requesterId];
      if (values.kind === 'task-event') {
        if (event.expectedTaskVersion !== task.version) fail('help_task_version_changed');
        if (event.kind === 'invite') recipientIds.push(event.recipientId);
        if (event.kind === 'revoke-invitation') {
          const invitation = task.contacts.responses.invitations.find(row => row.invitationId === event.invitationId);
          if (!invitation) fail('help_invitation_unavailable'); recipientIds.push(invitation.recipientId);
        }
        scope = { eventKind: event.kind, expectedTaskVersion: event.expectedTaskVersion };
      } else if (values.kind === 'participation-propose') {
        if (event.expectedTaskVersion !== task.version) fail('help_task_version_changed');
        recipientIds.push(payload.subjectId); scope = { role: payload.role, scopeVersion: 1, agreedScope: payload.agreedScope };
      } else {
        participation = task.participations.find(row => row.participationId === participationId);
        if (!participation || participation.scopeAvailable === false) fail('help_participation_unavailable');
        recipientIds.push(participation.subjectId);
        scope = { participationId, participantId: participation.subjectId, scopeVersion: participation.scopeVersion,
          scopeEventId: participation.scopeEventId, agreedScope: participation.agreedScope };
        if (values.kind === 'participation-event' && event.expectedParticipationVersion !== participation.version) fail('help_participation_version_changed');
        if (values.kind.startsWith('context-')) {
          if (payload.scopeVersion !== participation.scopeVersion || task.paused || task.state !== 'open'
            || !['active', 'delivered', 'accepted'].includes(participation.state)) {
            if (values.kind !== 'context-event' || payload.kind === 'accept') fail('help_context_scope_changed');
          }
          if (values.kind === 'context-grant') {
            if (task.requesterId !== session.subjectId || payload.participantId !== participation.subjectId
              || payload.scopeEventId !== participation.scopeEventId || payload.expiresAt <= now()) fail('help_context_scope_changed');
            recipientIds = [payload.participantId]; materials = payload.materials;
          } else {
            const context = await actions.getContext(payload.grantId), metadata = context.metadata;
            if (metadata.taskId !== taskId || metadata.participationId !== participationId || metadata.materialsHash !== payload.materialsHash
              || metadata.scopeVersion !== payload.scopeVersion) fail('help_context_material_changed');
            if (payload.kind === 'accept' && context.state !== 'pending') fail('help_context_unavailable');
            const expectedActor = payload.kind === 'revoke' ? metadata.ownerId : metadata.participantId;
            if (expectedActor !== session.subjectId) fail('help_context_actor_mismatch');
            recipientIds = [payload.kind === 'revoke' ? metadata.participantId : metadata.ownerId];
            scope = { ...scope, materialsHash: payload.materialsHash, grantId: payload.grantId, eventKind: payload.kind };
          }
        }
      }
    }
    if (values.offerId) {
      if (!session.selectedHelpIds.includes(values.offerId)) fail('help_selected_offer_required');
      const checked = await review(session.id), selected = checked.offers.find(row => row.id === values.offerId);
      if (selected?.state !== 'current') fail('help_selection_refresh_required');
      const target = event.kind === 'invite' ? event.recipientId : values.kind === 'participation-propose' ? payload.subjectId : participation?.subjectId;
      if (target && !selected.offer.participants.some(row => row.id === target)) fail('help_selected_participant_mismatch');
    }
    recipientIds = [...new Set(recipientIds.filter(id => id !== session.subjectId))];
    const grantId = values.kind === 'context-grant' ? payload.id : values.kind === 'context-event' ? payload.grantId : undefined;
    return { ...values, payload, operationId, taskId, ...(participationId ? { participationId } : {}), ...(grantId ? { grantId } : {}),
      payloadHash: hash(values.payloadJson), recipientIds, visibility, scope, materials,
      consentAction: values.kind.startsWith('context-') ? 'context.grant' : 'assistance.publish',
      expiresAt: values.kind === 'context-grant' ? payload.expiresAt : now() + 3600 };
  }
  function preview(row) {
    return { operationId: row.operationId, payloadHash: row.payloadHash, kind: row.kind, taskId: row.taskId,
      ...(row.participationId ? { participationId: row.participationId } : {}), ...(row.grantId ? { grantId: row.grantId } : {}),
      recipientIds: row.recipientIds, visibility: row.visibility, scope: row.scope,
      authorizationRequestId: row.authorizationRequestId ?? row.operationId, authorizationExpiresAt: row.expiresAt,
      materials: row.payloadJson && row.kind === 'context-grant' ? JSON.parse(row.payloadJson).materials : [],
      ...(row.payloadJson ? { payload: JSON.parse(row.payloadJson), prepareInput: Object.fromEntries(
        ['kind', 'payloadJson', 'taskId', 'participationId', 'offerId'].filter(key => row[key] !== undefined).map(key => [key, row[key]]) ) } : {}),
      ...(row.payloadJson && row.kind === 'publish-task' ? { prepareInput: { kind: row.kind, payloadJson: row.payloadJson,
        taskId: row.taskId, ...(row.offerId ? { offerId: row.offerId } : {}), recipientIds: row.recipientIds } } : {}), state: row.state,
      requiresExactAuthorization: true, selectionIsCommitment: false, paymentExecuted: false };
  }
  async function updateReference(id, row) {
    return store.update(id, session => {
      // The session lock is shared with legacy publish(). Different operation
      // files cannot independently pass a stale preflight and both submit.
      if (row.state === 'submitting') {
        if (session.linkedOperations.some(op => pending(op.state) || op.state === 'conflict')
          || session.actionOperations.some(op => op.operationId !== row.operationId
            && (op.taskId === row.taskId || op.kind === 'publish-task' || row.kind === 'publish-task')
            && (pending(op.state) || op.state === 'conflict'))) fail('help_reconcile_original_operation');
        if (row.kind === 'publish-task' && session.taskId) fail('help_task_already_linked');
      }
      const ref = { operationId: row.operationId, kind: row.kind, taskId: row.taskId, payloadHash: row.payloadHash,
        state: row.state, checkedAt: now(), ...(row.participationId ? { participationId: row.participationId } : {}), ...(row.grantId ? { grantId: row.grantId } : {}) };
      const prior = session.actionOperations.find(op => op.operationId === row.operationId);
      if (prior) Object.assign(prior, ref); else session.actionOperations.push(ref);
      if (row.state === 'acknowledged' && row.kind === 'publish-task') { session.taskId = row.taskId; session.caseId = row.caseId ?? null; }
    });
  }
  async function actionPreview(id, operationId) {
    z.uuid().parse(operationId); const row = await store.readOperation(id, operationId);
    if (!row) fail('help_action_unavailable'); return preview(row);
  }
  async function prepareAction(id, input) {
    const values = helpActionPrepareSchema.parse(input), parsed = schemas[values.kind].parse(JSON.parse(values.payloadJson)), event = parsed.event ?? parsed;
    if(values.kind==='publish-task'&&hasTaskMaterials(parsed))fail('task_material_atomic_route_required');
    const operationId = event.operationId ?? event.eventId ?? event.id;
    const original = await store.readOperation(id, operationId);
    if (original) {
      const recipients = publicationRecipients(values, parsed, original.subjectId);
      if (original.payloadHash !== hash(values.payloadJson) || original.kind !== values.kind || original.taskId !== (parsed.taskId ?? values.taskId)
        || original.participationId !== (parsed.participationId ?? values.participationId) || original.offerId !== values.offerId
        || values.kind === 'publish-task' && JSON.stringify(original.recipientIds) !== JSON.stringify(recipients)) fail('help_operation_conflict');
      const requestChanged = values.authorizationRequestId && values.authorizationRequestId !== (original.authorizationRequestId ?? operationId);
      if (requestChanged && original.state !== 'absent') fail('help_authorization_renewal_requires_absence');
      if (['prepared', 'absent'].includes(original.state) && (original.expiresAt <= now() || requestChanged)) {
        // Only a never-dispatched draft or confirmed absent operation may renew.
        // Unknown/committed actions keep their original authorization and IDs.
        const session = await store.get(id), refreshed = await describe(session, values);
        if (JSON.stringify(refreshed.recipientIds) !== JSON.stringify(original.recipientIds)
          || JSON.stringify(refreshed.scope) !== JSON.stringify(original.scope)) fail('help_action_scope_changed');
        const renewed = await store.writeOperation(id, operationId, prior => {
          if (!['prepared', 'absent'].includes(prior.state) || prior.authorizationRequestId !== original.authorizationRequestId
            || prior.expiresAt !== original.expiresAt) fail('help_reconcile_original_operation');
          return { ...prior, authorizationRequestId: requestChanged ? values.authorizationRequestId : randomUUID(),
            expiresAt: refreshed.expiresAt, checkedAt: now() };
        });
        await updateReference(id, renewed); return preview(renewed);
      }
      await updateReference(id, original); return preview(original);
    }
    const session = await store.get(id), description = await describe(session, values);
    const row = await store.writeOperation(id, description.operationId, prior => {
      if (prior) {
        if (prior.payloadHash !== description.payloadHash || prior.kind !== description.kind || prior.taskId !== description.taskId
          || prior.participationId !== description.participationId || prior.offerId !== description.offerId
          || JSON.stringify(prior.recipientIds) !== JSON.stringify(description.recipientIds)) fail('help_operation_conflict');
        return prior;
      }
      return { ...description, authorizationRequestId: values.authorizationRequestId ?? description.operationId,
        payload: undefined, materials: undefined, sessionId: id, subjectId: session.subjectId, endpoint: session.endpoint,
        ...(description.kind === 'publish-task' ? { caseId: description.payload.caseId } : {}), state: 'prepared', checkedAt: now() };
    });
    await updateReference(id, row);
    return { ...preview(row), materials: row.payloadJson && row.kind === 'context-grant' ? JSON.parse(row.payloadJson).materials : [] };
  }
  async function receiptFor(row) {
    return row.kind.startsWith('context-') ? actions.contextReceipt({ grantId: row.grantId, eventId: row.operationId, payloadHash: row.payloadHash })
      : actions.taskReceipt({ taskId: row.taskId, eventId: row.operationId, payloadHash: row.payloadHash });
  }
  async function recordState(id, operationId, state, receipt) {
    const row = await store.writeOperation(id, operationId, prior => {
      if (!prior) fail('help_action_unavailable');
      if (prior.state === 'acknowledged' && state !== 'acknowledged') return prior;
      if (state === 'acknowledged') {
        const { payloadJson: _payloadJson, materials: _materials, ...minimal } = prior; return { ...minimal, state, receipt, checkedAt: now() };
      }
      return { ...prior, state, ...(receipt ? { receipt } : {}), checkedAt: now() };
    });
    await updateReference(id, row); return row;
  }
  async function reconcileAction(id, { operationId }) {
    z.uuid().parse(operationId); const row = await store.readOperation(id, operationId);
    if (!row) fail('help_action_unavailable');
    const receipt = await receiptFor(row), current = await recordState(id, operationId, receipt.state, receipt);
    return { operation: preview(current), receipt, currentPermissionEstablished: false, automaticallyRetried: false };
  }
  async function executeAction(id, input) {
    const { operationId, payloadHash, authorizationRequestId } = helpActionExecuteSchema.parse(input), session = await store.get(id);
    let row = await store.readOperation(id, operationId);
    if (!row || row.payloadHash !== payloadHash) fail('help_action_preview_changed');
    if (row.state === 'acknowledged') return { operation: preview(row), receipt: row.receipt, currentPermissionEstablished: false };
    if ((authorizationRequestId ?? operationId) !== (row.authorizationRequestId ?? operationId)) fail('help_authorization_preview_changed');
    if (pending(row.state) || row.state === 'conflict') fail('help_reconcile_original_operation');
    if (session.actionOperations.some(op => op.operationId !== operationId && op.taskId === row.taskId && (pending(op.state) || op.state === 'conflict'))) fail('help_reconcile_original_operation');
    if (!authorize || !row.payloadJson || hash(row.payloadJson) !== payloadHash) fail('help_exact_authorization_unavailable');
    if (row.expiresAt <= now()) fail('help_authorization_refresh_required');
    const describedInput = Object.fromEntries(['kind', 'payloadJson', 'taskId', 'participationId', 'offerId'].filter(key => row[key] !== undefined).map(key => [key, row[key]]));
    if (row.kind === 'publish-task') describedInput.recipientIds = row.recipientIds;
    const description = await describe(session, describedInput);
    if (JSON.stringify(description.recipientIds) !== JSON.stringify(row.recipientIds) || JSON.stringify(description.scope) !== JSON.stringify(row.scope)) fail('help_action_scope_changed');
    row = await store.writeOperation(id, operationId, prior => {
      if (pending(prior.state) || !['prepared', 'absent'].includes(prior.state)) fail('help_reconcile_original_operation');
      if ((prior.authorizationRequestId ?? operationId) !== (row.authorizationRequestId ?? operationId)
        || prior.expiresAt !== row.expiresAt) fail('help_authorization_preview_changed');
      return { ...prior, state: 'submitting', checkedAt: now() };
    });
    await updateReference(id, row);
    try {
      const submission = await authorize({ requestId: row.authorizationRequestId ?? operationId, action: row.consentAction, objectId: operationId, payloadJson: row.payloadJson,
        visibility: row.visibility, viewers: row.recipientIds, expiresAt: row.expiresAt });
      await store.get(id); // Identity/endpoint journal may change during the user's authorization step.
      if (submission.payloadJson !== row.payloadJson || !z.uuid().safeParse(submission.consentId).success) fail('help_authorization_payload_changed');
      const signed = { consentId: submission.consentId, payloadJson: row.payloadJson };
      const dispatch = { 'publish-task': () => actions.createTask(signed), 'task-event': () => actions.submitTaskEvent(row.taskId, signed),
        'participation-propose': () => actions.proposeParticipation(row.taskId, signed),
        'participation-event': () => actions.submitParticipationEvent(row.taskId, row.participationId, signed),
        'context-grant': () => actions.createContextGrant(signed), 'context-event': () => actions.submitContextEvent(signed) };
      const receipt = await dispatch[row.kind](), current = await recordState(id, operationId, 'acknowledged', receipt);
      return { operation: preview(current), receipt, currentPermissionEstablished: false, successFactsCreated: false };
    } catch {
      const current = await recordState(id, operationId, 'unknown');
      return { operation: preview(current), state: 'unknown', next: 'reconcile-original-operation', automaticallyRetried: false };
    }
  }
  return { prepareAction, actionPreview, executeAction, reconcileAction };
}
