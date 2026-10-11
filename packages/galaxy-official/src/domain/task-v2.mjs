import { ServiceError } from '../shared/service-error.mjs';
import { taskRequestV2Schema, taskEventV2Schema, participationProposalV2Schema, participationEventV2Schema } from '../shared/task-schema-v2.mjs';

function rule(value, code = 'task_transition_denied') { if (!value) throw new ServiceError(code, 409); }
function enrollment(state, now) { return state.state === 'open' && state.request.enrollmentExpiresAt > now; }
function nextTask(state, actorId, event, now) {
  rule(Number.isSafeInteger(now) && now >= state.lastEventAt, 'task_time_conflict');
  rule(state.events.length < 10000, 'task_event_limit');
  const next = structuredClone(state);
  next.version++; next.lastEventAt = now; next.events.push({ actorId, at: now, event });
  return next;
}
export function createTaskV2(requesterId, input, now) {
  const request = taskRequestV2Schema.parse(input);
  rule(request.enrollmentExpiresAt > now, 'task_enrollment_expired');
  rule(!request.parentTaskId || request.parentTaskId !== request.taskId, 'task_parent_cycle');
  return { schemaVersion: 2, requesterId, request, version: 1, scopeVersion: 1, state: 'open',
    suggestions: { state: 'not-requested', items: [], eventId: null }, invitations: [], applications: [],
    participationIds: [], selected: null, events: [], createdAt: now, lastEventAt: now,
    paymentExecuted: false, contextAccessGranted: false, roomMembershipGranted: false };
}
export function applyTaskV2(state, actorId, input, now) {
  const event = taskEventV2Schema.parse(input);
  rule(event.expectedTaskVersion === state.version, 'task_version_conflict');
  const next = nextTask(state, actorId, event, now), requester = actorId === state.requesterId;
  const invitation = next.invitations.find(item => item.invitationId === event.invitationId);
  switch (event.kind) {
    case 'suggest-contacts':
      rule(requester);
      rule((event.state === 'ready') === (event.items.length > 0), 'task_suggestions_state_mismatch');
      rule(new Set(event.items.map(i => i.subjectId)).size === event.items.length, 'task_duplicate_suggestion');
      next.suggestions = { state: event.state, items: event.items, eventId: event.eventId,
        ...(event.error ? { error: event.error } : {}), updatedAt: now, authority: 'user-side-suggestion-not-response' }; break;
    case 'invite':
      rule(requester && enrollment(state, now) && event.recipientId !== actorId);
      rule(event.expiresAt > now && event.expiresAt <= Math.min(now + 7 * 86400, state.request.enrollmentExpiresAt), 'task_invitation_expiry');
      rule(!state.invitations.some(i => i.recipientId === event.recipientId && i.state === 'declined'), 'task_invitation_declined');
      rule(!state.invitations.some(i => i.recipientId === event.recipientId && i.state === 'pending' && i.expiresAt > now), 'task_invitation_pending');
      next.invitations.push({ invitationId: event.eventId, recipientId: event.recipientId, note: event.note,
        expiresAt: event.expiresAt, sentAt: now, state: 'pending', replies: [] }); break;
    case 'invitation-reply':
      rule(invitation?.recipientId === actorId && !['revoked', 'declined'].includes(invitation.state)
        && invitation.expiresAt > now && !['canceled', 'closed'].includes(state.state));
      invitation.state = event.response;
      invitation.replies.push({ eventId: event.eventId, at: now, response: event.response, message: event.message }); break;
    case 'revoke-invitation':
      rule(requester && invitation && !['revoked', 'declined'].includes(invitation.state));
      invitation.state = 'revoked'; invitation.revocationEventId = event.eventId; break;
    case 'apply':
      rule(!requester && enrollment(state, now));
      rule(!state.applications.some(a => a.subjectId === actorId && a.state === 'pending'), 'task_application_pending');
      rule(!event.quote || state.request.collaboration === 'basic-bounty');
      next.applications.push({ applicationId: event.eventId, subjectId: actorId, proposal: event.proposal,
        ...(event.scope === undefined ? {} : {scope: event.scope}), quote: event.quote ?? null, qualificationEvidence: event.qualificationEvidence ?? { proofIds: [], assistanceIds: [] },
        state: 'pending', at: now }); break;
    case 'withdraw-application': {
      const application = next.applications.find(a => a.applicationId === event.applicationId);
      rule(application?.subjectId === actorId && application.state === 'pending');
      application.state = 'withdrawn'; application.withdrawalEventId = event.eventId; break;
    }
    case 'cancel':
      rule(requester && !['canceled', 'closed'].includes(state.state)); next.state = 'canceled'; break;
    case 'close':
      rule(requester && !['canceled', 'closed'].includes(state.state)); next.state = 'closed'; break;
    case 'extend-enrollment':
      rule(requester && state.state === 'open' && event.enrollmentExpiresAt > now
        && event.enrollmentExpiresAt > state.request.enrollmentExpiresAt);
      next.request.enrollmentExpiresAt = event.enrollmentExpiresAt; break;
  }
  return next;
}
export function proposeParticipationV2(state, actorId, input, now) {
  const event = participationProposalV2Schema.parse(input);
  rule(actorId === state.requesterId && event.subjectId !== actorId && enrollment(state, now));
  rule(event.expectedTaskVersion === state.version, 'task_version_conflict');
  rule(!state.participationIds.includes(event.participationId), 'participation_conflict');
  if (event.applicationId) rule(state.applications.some(a => a.applicationId === event.applicationId
    && a.subjectId === event.subjectId && a.state === 'pending'), 'task_application_unavailable');
  const next = nextTask(state, actorId, { ...event, kind: 'participation-proposed' }, now);
  next.participationIds.push(event.participationId);
  if (event.applicationId) next.applications.find(a => a.applicationId === event.applicationId).state = 'selected';
  const participation = { schemaVersion: 2, taskId: state.request.taskId, participationId: event.participationId,
    subjectId: event.subjectId, requesterId: state.requesterId, role: event.role,
    scopeVersion: 1, agreedScope: event.agreedScope, scopeEventId: event.eventId,
    state: 'awaiting-counterparty', version: 1, proposalEventId: event.eventId,
    applicationId: event.applicationId ?? null, confirmedAt: null, pendingScope: null,
    deliveries: [], dispute: null, disputeResolution: null, events: [{ actorId, at: now, event }],
    createdAt: now, lastEventAt: now, contextAccessGranted: false, roomMembershipGranted: false,
    paymentExecuted: false, verification: 'not-provided', resolution: 'unresolved' };
  return { task: next, participation };
}
export function applyParticipationV2(task, state, actorId, input, now) {
  const event = participationEventV2Schema.parse(input);
  rule(event.expectedParticipationVersion === state.version, 'participation_version_conflict');
  const requester = actorId === state.requesterId, provider = actorId === state.subjectId;
  rule(requester || provider, 'participation_actor_denied');
  rule(Number.isSafeInteger(now) && now >= state.lastEventAt, 'participation_time_conflict');
  rule(!['canceled', 'closed'].includes(task.state) || ['withdraw', 'dispute', 'propose-resolution', 'confirm-resolution','requester-feedback'].includes(event.kind), 'task_closed');
  const next = structuredClone(state);
  switch (event.kind) {
    case 'requester-feedback':
      rule(provider&&state.confirmedAt!==null&&(['accepted','withdrawn','closed'].includes(state.state)||['canceled','closed'].includes(task.state)),'requester_feedback_not_available');
      if(state.feedback)rule(event.supersedes===state.feedback.eventId&&!!event.reason,'requester_feedback_revision_required');
      else rule(!event.supersedes,'requester_feedback_source_unavailable');
      next.feedback={eventId:event.eventId,descriptionClarity:event.descriptionClarity,scopeMatched:event.scopeMatched,note:event.note,
        authority:'provider-reported',independentQualityRating:false};break;
    case 'confirm':
      rule(provider && state.state === 'awaiting-counterparty' && event.scopeVersion === state.scopeVersion);
      next.state = 'active'; next.confirmedAt = now; break;
    case 'decline':
      rule(provider && state.state === 'awaiting-counterparty'); next.state = 'declined'; break;
    case 'withdraw':
      rule(provider && ['awaiting-counterparty', 'active', 'delivered', 'accepted', 'disputed'].includes(state.state));
      next.state = 'withdrawn'; next.withdrawnAt = now; break;
    case 'propose-scope':
      rule(requester && ['active', 'delivered', 'accepted'].includes(state.state) && !state.pendingScope);
      rule(event.scopeVersion === state.scopeVersion + 1, 'participation_scope_conflict');
      next.pendingScope = { eventId: event.eventId, scopeVersion: event.scopeVersion, agreedScope: event.agreedScope, reason: event.reason }; break;
    case 'confirm-scope':
      rule(provider && state.pendingScope?.eventId === event.proposalId);
      next.agreedScope = state.pendingScope.agreedScope; next.scopeVersion = state.pendingScope.scopeVersion;
      next.scopeEventId = state.pendingScope.eventId; next.pendingScope = null; next.state = 'active'; break;
    case 'decline-scope':
      rule(provider && state.pendingScope?.eventId === event.proposalId); next.pendingScope = null; break;
    case 'deliver':
      rule(provider && ['active', 'delivered', 'accepted'].includes(state.state));
      rule(task.request.caseId, 'task_case_required_for_facts');
      next.deliveries.push({ deliveryId: event.eventId, resultRef: event.resultRef, interventionRefs: event.interventionRefs,
        evidenceRefs: event.evidenceRefs, summary: event.summary, scopeVersion: state.scopeVersion,
        authorId: actorId, at: now, acceptance: null, verification: 'not-provided', resolution: 'unresolved' });
      next.state = 'delivered'; break;
    case 'accept': {
      const delivery = next.deliveries.find(d => d.deliveryId === event.deliveryId);
      rule(requester && ['delivered', 'accepted', 'withdrawn'].includes(state.state) && delivery && !delivery.acceptance);
      delivery.acceptance = { eventId: event.eventId, actorId, at: now, summary: event.summary };
      if (state.state !== 'withdrawn' && delivery === next.deliveries.at(-1)) next.state = 'accepted'; break;
    }
    case 'dispute':
      rule(state.confirmedAt !== null && !['declined', 'awaiting-counterparty'].includes(state.state));
      next.dispute = { eventId: event.eventId, actorId, reason: event.reason, previousState: state.state };
      next.disputeResolution = null; next.state = 'disputed'; break;
    case 'propose-resolution':
      rule(state.state === 'disputed');
      next.disputeResolution = { eventId: event.eventId, actorId, summary: event.summary, outcome: event.outcome, confirmation: null }; break;
    case 'confirm-resolution':
      rule(state.state === 'disputed' && state.disputeResolution?.eventId === event.proposalId && state.disputeResolution.actorId !== actorId);
      next.disputeResolution.confirmation = { eventId: event.eventId, actorId, at: now };
      next.state = state.disputeResolution.outcome === 'resume-work' ? 'active' : 'closed'; break;
  }
  next.version++; next.lastEventAt = now; next.events.push({ actorId, at: now, event });
  return { task: nextTask(task, actorId, { ...event, participationId: state.participationId }, now), participation: next };
}

export function legacyAssistanceTaskV2(state) {
  const provider = state.selected?.providerId;
  return { schemaVersion: 1, taskId: state.request.id, caseId: state.request.caseId, requesterId: state.requesterId,
    request: state.request, state: state.state, version: state.version, selected: state.selected,
    participations: provider ? [{ participationId: `legacy-v1:${state.request.id}`, subjectId: provider,
      role: 'main-responsible', state: state.state, agreedScope: state.agreedScope, provenance: 'legacy-v1' }] : [],
    compatibility: { source: 'legacy-v1', writableApiVersion: 1, v2Writes: false },
    paymentExecuted: false, contextAccessGranted: false };
}
