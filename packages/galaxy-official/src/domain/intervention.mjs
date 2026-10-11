// Only already-authorized event rows enter a viewer projection. Persisted events
// remain immutable; current objects can always be rebuilt from their versions.
export function projectCaseFacts(rows, parent) {
  const facts = { attempts: [], interventions: [], results: [], resolutions: [], responses: [], scopes: [],
    synthetic: null, resolution: { status: 'unrecorded' }, version: parent.version, caseId: parent.id };
  const find = (kind, ref) => factAt(facts, kind, ref);
  for (const row of rows) {
    const e = row.payload ?? row, eventId = e.eventId ?? e.id;
    const base = { id: eventId, version: 1, caseId: parent.id, actorId: e.actorId ?? 'unknown',
      reportedBy: row.subject_id ?? null, participationId: e.participationId ?? null, taskId: e.taskId ?? null,
      scopeVersion: e.scopeVersion ?? e.taskScopeVersion ?? 1, eventId, caseVersion: row.version,
      participationScopeVersion:e.participationScopeVersion ?? (e.participationId?1:null),
      recordEventIds: [eventId], provenance: e.eventId ? 'native-v2' : 'legacy-v1',
      claimAuthority: e.eventId ? 'participant-reported' : 'owner-reported', synthetic: facts.synthetic };
    if (e.kind === 'case-created') { facts.synthetic = e.synthetic; facts.scopes.push({version:e.taskScopeVersion ?? 1,summary:e.summary,eventId}); }
    if (e.kind === 'case') facts.scopes.push({version:1,summary:e.summary,eventId});
    if (e.kind === 'case-scope-revised') facts.scopes.push({version:e.taskScopeVersion,summary:e.summary,eventId});
    if (e.kind === 'attempt' || e.kind === 'attempt-start') {
      facts.attempts.push({ ...base, strategy: e.strategy ?? e.approach, role: e.role ?? 'unknown',
        configurationRef: e.configurationRef ?? null, environment: e.environment ?? e.configuration ?? 'unknown',
        inputScopeSummary: e.inputScopeSummary ?? 'unknown', permissionScope: e.permissionScope ?? ['unknown'],
        status: e.kind === 'attempt-start' ? 'running' : 'unknown', reportedOutcome: 'unrecorded',
        startedAt: e.startedAt ?? row.created_at ?? null, endedAt: null, resultRefs: [] });
    }
    if (e.kind === 'attempt-end' || e.kind === 'attempt-correct') {
      const prior = find('attempt', e.attemptRef);
      if (prior) facts.attempts.push({ ...prior, version: prior.version + 1, eventId, caseVersion: row.version,
        recordEventIds: [...prior.recordEventIds, eventId], status:e.status, reportedOutcome:e.reportedOutcome ?? 'unrecorded',
        summary:e.summary,failureReason:e.failureReason,endedAt:e.endedAt ?? row.created_at ?? null,
        correction: e.kind === 'attempt-correct' ? {reason:e.reason,supersedes:e.attemptRef} : null });
    }
    if (e.kind === 'intervention') {
      const prior = e.supersedes ? find('intervention', e.supersedes) : null;
      if (e.supersedes && !prior) continue;
      // ID-only v2 associations resolve to the actual Attempt version present
      // when this event was accepted, never a later (possibly private) rewrite.
      const affected = e.affectsAttemptIds.map(id => latestFact(facts, 'attempt', id));
      if (affected.some(attempt => !attempt)) continue;
      facts.interventions.push({ ...base, id:prior?.id ?? eventId, version:(prior?.version ?? 0)+1,
        recordEventIds:[...(prior?.recordEventIds ?? []),...affected.flatMap(a=>a.recordEventIds),eventId], types:e.types,description:e.description,
        affectsAttemptIds:e.affectsAttemptIds,affectsAttemptRefs:affected.map(a=>({id:a.id,version:a.version})),sourceRefs:e.sourceRefs,observedEffect:e.observedEffect,
        claimState:'self-declared',confirmation:'unconfirmed',responses:[],capabilityVerified:false });
    }
    if (e.kind === 'intervention-response') {
      const intervention = find('intervention',e.interventionRef);
      if (!intervention) continue;
      const response = { id:eventId,actorId:e.actorId,state:e.state,summary:e.summary,interventionRef:e.interventionRef,
        relationship:e.actorId===intervention.actorId?'self':e.actorId===parent.subject_id?'requester':'participant',
        recordEventIds:[...intervention.recordEventIds,eventId] };
      facts.responses.push(response);
      intervention.responses = [...intervention.responses.filter(r=>r.actorId!==response.actorId),response];
      const others = intervention.responses.filter(r=>r.relationship!=='self');
      intervention.confirmation = others.some(r=>r.state==='disputed')?'disputed':others.some(r=>r.state==='partial')?
        'partially-confirmed':others.some(r=>r.state==='accepted')?'confirmed':'unconfirmed';
    }
    if (e.kind === 'result' || e.kind === 'result-recorded') {
      const prior = e.supersedes ? find('result',e.supersedes) : null;
      if (e.supersedes && !prior) continue;
      const origin = e.origin ?? {kind:'attempt',id:e.attemptId,version:1};
      const source = find(origin.kind,origin);
      if (!source) continue;
      facts.results.push({ ...base, id:prior?.id ?? eventId, version:(prior?.version ?? 0)+1, origin,
        recordEventIds:[...source.recordEventIds,...(prior?.recordEventIds ?? []),eventId],
        deliverableRefs:e.deliverableRefs ?? [],reportedOutcome:e.reportedOutcome ?? e.outcome,
        summary:e.summary,limitations:e.limitations,acceptance:'not-provided',verification:'not-provided',
        supersedes:e.supersedes ?? null });
      source.resultRefs?.push({id:prior?.id ?? eventId,version:(prior?.version ?? 0)+1});
    }
    if (e.kind === 'resolution-recorded') {
      const resolution={...base,status:e.status,summary:e.summary,satisfiedGoals:e.satisfiedGoals,
        remainingGoals:e.remainingGoals,resultRefs:e.resultRefs,verificationRefs:e.verificationRefs,
        supersedesResolutionId:e.supersedesResolutionId,decisionActor:e.actorId};
      facts.resolutions.push(resolution); facts.resolution=resolution;
    }
  }
  facts.scopeVersion = facts.scopes.at(-1)?.version ?? 1;
  facts.resolution = currentResolutionView(facts);
  return facts;
}

// Keep the original decision in resolutions. A corrected supporting Result
// needs a fresh decision; it never changes the old decision into a failure.
// currentFacts may contain newer versions that this viewer cannot read. Only
// the support boundary is returned, never the private version or correction.
export function currentResolutionView(facts, currentFacts = facts) {
  const decision = facts.resolutions.at(-1);
  if (!decision) return { status: 'unrecorded' };
  if (decision.scopeVersion !== facts.scopeVersion)
    return { status: 'unrecorded', scopeVersion: facts.scopeVersion, priorResolutionId: decision.id };
  if (decision.resultRefs.some(ref => latestFact(currentFacts, 'result', ref.id)?.version !== ref.version))
    return { status: 'unrecorded', scopeVersion: facts.scopeVersion, priorResolutionId: decision.id,
      currentSupport: 'referenced-result-superseded', currentDecisionAvailable: false, reconfirmationRequired: true,
      summary: '引用的结果已更正，当前解决程度需要重新确认。' };
  return decision;
}

export function factAt(facts, kind, reference) {
  return facts[`${kind}s`]?.find(item => item.id === reference.id && item.version === reference.version);
}
export function latestFact(facts, kind, id) {
  return facts[`${kind}s`]?.filter(item=>item.id===id).at(-1);
}
export function publicFactView(facts) {
  const clean = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(clean) : value && typeof value==='object'
    ? Object.fromEntries(Object.entries(value).filter(([key])=>key!=='recordEventIds').map(([key,item])=>[key,clean(item)])) : value;
  return clean(facts);
}
