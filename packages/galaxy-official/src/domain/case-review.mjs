import { ServiceError } from '../shared/service-error.mjs';

const transitions = { opened: ['in-review', 'resolved', 'rejected'],
  'in-review': ['resolved', 'rejected'], resolved: ['reopened'], rejected: ['reopened'],
  reopened: ['in-review', 'resolved', 'rejected'] };
export const nextCaseReviewStates=state=>Object.hasOwn(transitions,state)?[...transitions[state]]:[];

export function assertCaseReview(event, events) {
  if (!event.review) return;
  const history = events.filter(item => item.kind === 'revision' && item.review?.threadId === event.review.threadId);
  if (!history.length) {
    if (event.review.threadId !== event.id || event.review.state !== 'opened')
      throw new ServiceError('review_open_required', 409);
    return;
  }
  const first = history[0], last = history.at(-1);
  if (event.review.type !== first.review.type || event.correctsEventId !== first.correctsEventId)
    throw new ServiceError('review_target_conflict', 409);
  if (!transitions[last.review.state]?.includes(event.review.state))
    throw new ServiceError('review_transition_conflict', 409);
}

export function projectCaseReviews(events) {
  const threads = new Map();
  for (const event of events) {
    if (event.kind !== 'revision' || !event.review) continue;
    const { threadId, type, state } = event.review;
    const thread = threads.get(threadId) ?? { threadId, type, targetEventId: event.correctsEventId,
      authority: 'case-owner-reported', independentDecision: false, changes: [] };
    thread.state = state;
    thread.changes.push({ eventId: event.id, state, reason: event.reason, summary: event.summary });
    threads.set(threadId, thread);
  }
  return [...threads.values()];
}
