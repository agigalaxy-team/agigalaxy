export const requesterFactKinds = Object.freeze(['select','confirm','change-scope','confirm-scope','deliver','accept','cancel','dispute','propose-resolution','confirm-resolution','requester-feedback']);

// Only currently visible signed events enter the projection or its counts.
export function projectRequesterHistory(state, visible) {
  const events = state.events.filter(item => visible(item.event.id));
  const facts = events.filter(item => requesterFactKinds.includes(item.event.kind)).map(item => ({
    eventId: item.event.id, actorId: item.actorId, at: item.at, kind: item.event.kind,
    summary: item.event.summary ?? item.event.reason ?? item.event.note ?? null,
    ...(item.event.kind === 'requester-feedback' ? { descriptionClarity: item.event.descriptionClarity,
      scopeMatched: item.event.scopeMatched, authority: 'provider-reported' } : { authority: 'signed-participant-event' })
  }));
  const offer = events.find(item => item.event.kind === 'offer');
  const response = offer && events.find(item => item.actorId === state.requesterId && item.at >= offer.at && ['select','cancel','change-scope'].includes(item.event.kind));
  return { assistanceId: state.request.id, requesterId: state.requesterId, title: state.request.title, createdAt: state.createdAt,
    description: { problem: state.request.problem, scope: state.request.scope, attemptedApproaches: state.request.attemptedApproaches },
    facts, visibleFactCount: facts.length,
    counts: { acceptances: facts.filter(item => item.kind === 'accept').length,
      cancellations: facts.filter(item => item.kind === 'cancel').length, disputes: facts.filter(item => item.kind === 'dispute').length },
    countBasis: 'visible-events; repeated-acceptance-is-not-another-request',
    responseSeconds: response ? response.at - offer.at : null, responseBasis: 'first visible offer and requester response',
    responseSources: response ? { offerEventId: offer.event.id, responseEventId: response.event.id } : null,
    capabilityVerified: false, independentQualityRating: false };
}

export function requesterHistoryPreview(projection) {
  const page = projection.facts.slice(0, 8);
  return { ...projection, facts: page.map(fact => ({ ...fact, summary: fact.summary?.slice(0, 300) ?? null,
    summaryTruncated: (fact.summary?.length ?? 0) > 300 })),
    nextFactsAfter: projection.facts.length > page.length ? page.at(-1).eventId : null, factsSupported: 1 };
}
