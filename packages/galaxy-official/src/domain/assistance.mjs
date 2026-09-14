import * as z from 'zod/v4';
export { createTaskV2, applyTaskV2, proposeParticipationV2, applyParticipationV2, legacyAssistanceTaskV2 } from './task-v2.mjs';
import { ServiceError } from '../shared/service-error.mjs';

import { assistanceRequestSchema, assistanceEventSchema } from '../shared/assistance-schema.mjs';
export { assistanceRequestSchema, assistanceEventSchema } from '../shared/assistance-schema.mjs';
const subject = z.string().regex(/^GUID[0-9A-Z]{28}$/);
function requireRule(value, code = 'assistance_transition_denied') { if (!value) throw new ServiceError(code, 409); }

// Domain only: caller identity/time must come from trusted service composition.
// Persistence must additionally verify Case/Attempt/Evidence and each Consent.
export function createAssistance(requesterId, input, now) {
  subject.parse(requesterId); const request = assistanceRequestSchema.parse(input);
  requireRule(Number.isSafeInteger(now) && request.enrollmentExpiresAt > now, 'assistance_expired');
  return { version: 1, request, requesterId, state: 'open', invitations: [], offers: [], shortlist: [], selected: null,
    agreedScope: null, pendingScope: null, delivery: null, resolution: null, events: [],
    createdAt: now, lastEventAt: now, contextAccessGranted: false, paymentExecuted: false, capabilityVerified: false };
}
export function applyAssistance(state, actorId, input, now) {
  subject.parse(actorId); const event = assistanceEventSchema.parse(input);
  const prior = state.events.find(row => row.event.id === event.id);
  if (prior) { requireRule(prior.actorId === actorId && JSON.stringify(prior.event) === JSON.stringify(event), 'assistance_event_conflict'); return state; }
  requireRule(state.version === event.expectedVersion, 'assistance_version_conflict');
  requireRule(Number.isSafeInteger(now) && now >= state.lastEventAt, 'assistance_time_conflict');
  requireRule(state.events.length < 1000, 'assistance_event_limit');
  const next = structuredClone(state), requester = actorId === state.requesterId;
  const provider = actorId === state.selected?.providerId;
  const enrollment = ['open', 'awaiting-confirmation'].includes(state.state);
  if (enrollment && now >= state.request.enrollmentExpiresAt)
    requireRule(['expire', 'cancel'].includes(event.kind), 'assistance_expired');
  const offered = id => next.offers.find(offer => offer.id === id && !offer.withdrawn);
  switch (event.kind) {
    case 'requester-feedback':
      requireRule(provider && ['accepted','canceled','resolved'].includes(state.state)
        && state.events.some(item => item.actorId === actorId && item.event.kind === 'confirm')
        && !state.events.some(item => item.event.kind === 'requester-feedback'));
      break;
    case 'invite':
      requireRule(requester && state.state === 'open' && event.participantId !== actorId);
      next.invitations ??= [];
      requireRule(next.invitations.length < 16 && !next.invitations.some(item => item.participantId === event.participantId), 'assistance_invitation_limit');
      next.invitations.push({ eventId: event.id, participantId: event.participantId }); break;
    case 'offer':
      requireRule(state.state === 'open' && !requester && !state.offers.some(offer => offer.providerId === actorId && !offer.withdrawn));
      requireRule(!event.quote || state.request.collaboration === 'basic-bounty');
      next.offers.push({ id: event.id, providerId: actorId, proposal: event.proposal, scope: event.scope, quote: event.quote ?? null, qualificationEvidence: event.qualificationEvidence ?? { proofIds: [], assistanceIds: [] }, withdrawn: false }); break;
    case 'withdraw-offer': {
      const offer = offered(event.offerId); requireRule(enrollment && offer?.providerId === actorId);
      offer.withdrawn = true; next.shortlist = next.shortlist.filter(id => id !== offer.id);
      if (state.selected?.offerId === offer.id) { next.selected = null; next.state = 'open'; }
      break;
    }
    case 'shortlist':
      requireRule(requester && state.state === 'open' && new Set(event.offerIds).size === event.offerIds.length && event.offerIds.every(id => offered(id)));
      next.shortlist = event.offerIds; break;
    case 'select': {
      const offer = offered(event.offerId); requireRule(requester && state.state === 'open' && !!offer);
      next.selected = { offerId: offer.id, providerId: offer.providerId }; next.state = 'awaiting-confirmation'; break;
    }
    case 'confirm':
      requireRule(provider && state.state === 'awaiting-confirmation'); next.state = 'active';
      next.agreedScope = offered(state.selected.offerId).scope; break;
    case 'change-scope':
      requireRule(requester && state.state === 'active'); next.pendingScope = event.scope; next.state = 'awaiting-scope-confirmation'; break;
    case 'confirm-scope':
      requireRule(provider && state.state === 'awaiting-scope-confirmation'); next.agreedScope = state.pendingScope;
      next.pendingScope = null; next.state = 'active'; break;
    case 'deliver':
      requireRule(provider && ['active','delivered'].includes(state.state)); next.delivery = { id: event.id, attemptId: event.attemptId,
        summary: event.summary, evidenceIds: event.evidenceIds,...(event.caseReviewVersion!==undefined?{caseReviewVersion:event.caseReviewVersion}:{}) }; next.state = 'delivered'; break;
    case 'accept':
      requireRule(requester && state.state === 'delivered' && event.deliveryId === state.delivery.id); next.state = 'accepted'; break;
    case 'cancel':
      requireRule((requester || provider) && ['open', 'awaiting-confirmation', 'active', 'awaiting-scope-confirmation', 'delivered'].includes(state.state));
      next.state = 'canceled'; break;
    case 'expire':
      requireRule(requester && enrollment && now >= state.request.enrollmentExpiresAt); next.state = 'expired'; break;
    case 'dispute':
      requireRule((requester || provider) && ['active', 'awaiting-scope-confirmation', 'delivered', 'accepted', 'resolved'].includes(state.state));
      next.state = 'disputed'; next.resolution = null; break;
    case 'propose-resolution':
      requireRule((requester || provider) && ['disputed', 'awaiting-resolution-confirmation'].includes(state.state));
      next.resolution = { id: event.id, proposerId: actorId, summary: event.summary,...(event.outcome?{outcome:event.outcome}:{}) }; next.state = 'awaiting-resolution-confirmation'; break;
    case 'confirm-resolution':
      requireRule((requester || provider) && state.state === 'awaiting-resolution-confirmation'
        && actorId !== state.resolution.proposerId && event.proposalId === state.resolution.id);
      next.state = state.resolution.outcome==='resume-work'?'active':'resolved';
      if(next.state==='active'){next.delivery=null;next.pendingScope=null;}
      break;
  }
  next.version++; next.lastEventAt = now;
  next.events.push({ actorId, at: now, event });
  return next;
}
