import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { digest } from '../src/shared/digest.mjs';
import {
  getFactClient,
  latestFacts,
} from '../../galaxy-web/src/fact-client.mjs';

// Actual HTTP, signatures, Consent and persistent services. Synthetic identities
// and work only; the browser KV bridge is a test double, not IndexedDB evidence.
test('client links actual work without failed attempts, keeps multiple authors and exact Evidence delivery separate from resolution', async () => {
  const now = Math.floor(Date.now() / 1000),
    scopes = [
      'binding',
      'consent',
      'case-teaser',
      'assistance',
      'evidence',
      'history',
    ];
  const f = await serviceFixture(scopes, null, { now }),
    p = await serviceFixture(scopes, f.db, { now, migrateDatabase: false }),
    q = await serviceFixture(scopes, f.db, { now, migrateDatabase: false });
  const api = createApi({
    ...f,
    rateLimit: 500,
    failureAudit: async () => 'stored',
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + api.address().port;
  const all = [f, p, q].map((who) => who.actor.subjectId);
  let loseLink = true,
    loseConsent = false;
  const request = async (who, path, input, method = 'POST') => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + who.credential,
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(input) }),
    });
    const body = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(body.error ?? JSON.stringify(body)), {
        status: response.status,
        code: body.error,
        outcome: 'rejected',
      });
    return body;
  };
  const runtimes = new Map();
  for (const who of [f, p, q]) {
    const local = new Map();
    runtimes.set(who, {
      api: {
        endpoint: who.access.endpoint,
        snapshot: () => ({ subjectId: who.actor.subjectId, bindingId: who.actor.bindingId, endpoint: who.access.endpoint }),
        prepareAuthorization: async (payloadJson, options) => {
          const intent = {
            version: 1,
            id: randomUUID(),
            subjectId: who.actor.subjectId,
            bindingId: who.actor.bindingId,
            endpoint: who.access.endpoint,
            objectId: options.objectId,
            action: options.action,
            purpose: 'operational',
            recipient: who.access.endpoint,
            fields: Object.keys(JSON.parse(payloadJson)),
            visibility: options.visibility,
            viewers: options.viewers,
            payloadHash: digest(payloadJson),
            policyVersion: '0.1',
            issuedAt: now,
            expiresAt: now + 3600,
          };
          return {
            payloadJson,
            intent,
            signedIntent: await who.signForTest(
              JSON.stringify(intent),
              'galaxy-consent+jws',
            ),
          };
        },
        submitAuthorization: async (prepared) => {
          const receipt = await request(who, '/v1/consents', {
            signedIntent: prepared.signedIntent,
          });
          if (loseConsent) {
            loseConsent = false;
            throw new Error('synthetic Consent response lost after commit');
          }
          return {
            consentId: receipt.consentId,
            payloadJson: prepared.payloadJson,
          };
        },
        call: async (path, input) => {
          const result = await request(who, path, input);
          if (path.endsWith('/case') && loseLink) {
            loseLink = false;
            throw new Error(
              'synthetic lost response after actual atomic commit',
            );
          }
          return result;
        },
      },
      getLocal: async (key) => structuredClone(local.get(key)),
      putLocal: async (key, value) => local.set(key, structuredClone(value)),
    });
  }
  const clients = new Map(
      [f, p, q].map((who) => [
        who,
        getFactClient(runtimes.get(who), who.actor.subjectId),
      ]),
    ),
    client = (who) => clients.get(who),
    viewers = (who) => all.filter((id) => id !== who.actor.subjectId),
    options = (who) => ({ confirmed: true, viewers: viewers(who) });
  const taskId = randomUUID(),
    getTask = (who) => request(who, '/v2/tasks/' + taskId, null, 'GET');
  const taskWrite = async (who, path, payload, recipients = viewers(who)) =>
    request(
      who,
      path,
      await who.authorize(payload, 'assistance.publish', {
        objectId: payload.operationId ?? payload.eventId,
        viewers: recipients.filter((id) => id !== who.actor.subjectId),
      }),
    );
  try {
    await taskWrite(f, '/v2/tasks', {
      operationId: randomUUID(),
      taskId,
      caseId: null,
      intent: 'proactive-review',
      title: 'Synthetic proactive review',
      summary: 'No past failure required',
      workContext: {
        goal: 'Review current assumptions',
        currentSituation: 'Starting review',
        attemptRefs: [],
      },
      visibility: 'Private',
      collaboration: 'open-assistance',
      enrollmentExpiresAt: now + 3600,
    });
    let task = await getTask(f);
    assert.equal(task.caseId, null);
    assert.equal(
      (await f.db.query('SELECT count(*)::int n FROM cases')).rows[0].n,
      0,
    );
    const initial = {
      kind: 'intervention',
      types: ['scope-clarification'],
      affectsAttemptIds: [],
      description: 'Requester clarified the actual review scope',
      sourceRefs: [],
      observedEffect: 'Scope clarified, no fix attempted',
    };
    await assert.rejects(
      client(f).submitFact(task, null, null, initial, {
        ...options(f),
        caseSummary: 'Actual scope clarification for the synthetic task',
        synthetic: true,
      }),
      (error) => error.resultUnknown === true,
    );
    const pending = await client(f).pending(taskId);
    assert.ok(pending);
    const reconciled = await client(f).reconcile(taskId);
    assert.equal(reconciled.state, 'acknowledged');
    assert.equal(await client(f).pending(taskId), null);
    assert.equal(
      (await f.db.query('SELECT count(*)::int n FROM case_events')).rows[0].n,
      2,
    );
    task = await getTask(f);
    assert.ok(task.caseId);
    const participate = async (who, role) => {
      const current = await getTask(f),
        participationId = randomUUID();
      await taskWrite(
        f,
        `/v2/tasks/${taskId}/participations`,
        {
          kind: 'propose',
          eventId: randomUUID(),
          expectedTaskVersion: current.version,
          participationId,
          subjectId: who.actor.subjectId,
          role,
          scopeVersion: 1,
          agreedScope: role + ' only',
        },
        [who.actor.subjectId],
      );
      await taskWrite(
        who,
        `/v2/participations/${participationId}/events`,
        {
          kind: 'confirm',
          eventId: randomUUID(),
          expectedParticipationVersion: 1,
          scopeVersion: 1,
        },
        [f.actor.subjectId],
      );
      return (await getTask(who)).participations.find(
        (row) => row.participationId === participationId,
      );
    };
    const pp = await participate(p, 'diagnosis'),
      qp = await participate(q, 'review');
    task = await getTask(f);
    const work = async (who, part, fields) =>
      client(who).submitFact(
        task,
        await client(who).readCase(task),
        part,
        fields,
        options(who),
      );
    const pd = await work(p, pp, {
      ...initial,
      types: ['diagnosis'],
      description: 'Provider isolated a boundary mismatch',
      observedEffect: 'Diagnostic finding, no claimed fix',
    });
    const qWork = {
      ...initial,
      types: ['review'],
      description: 'Second provider independently reviewed the assumption',
      observedEffect: 'Review covered a different boundary',
    };
    const consentCount = (
      await f.db.query('SELECT count(*)::int n FROM consents')
    ).rows[0].n;
    loseConsent = true;
    await assert.rejects(
      work(q, qp, qWork),
      (error) => error.resultUnknown === true,
    );
    assert.equal((await client(q).reconcile(taskId)).state, 'absent');
    const qd = await client(q).reconcile(taskId, {
      retry: true,
      confirmed: true,
    });
    assert.equal(
      (await f.db.query('SELECT count(*)::int n FROM consents')).rows[0].n,
      consentCount + 1,
      'original prepared Consent reused after lost response',
    );
    assert.throws(
      () => client(p).submitFact(task, {}, qp, initial, options(p)),
      /他人/,
    );
    let facts = await client(f).readCase(task);
    assert.equal(facts.attempts.length, 0);
    assert.equal(facts.interventions.length, 3);
    assert.deepEqual(
      new Set(facts.interventions.map((x) => x.actorId)),
      new Set(all),
    );
    const attempt = await work(q, qp, {
      kind: 'attempt-start',
      role: 'review',
      strategy: 'Inspect selected public boundary examples',
      inputScopeSummary: 'Only the examples supplied for this synthetic review',
      permissionScope: ['read-selected-examples'],
      environment: { name: 'synthetic-fixture', version: '1' },
    });
    const ended = await work(q, qp, {
      kind: 'attempt-end',
      attemptRef: attempt.objectRef,
      status: 'completed',
      summary: 'Reviewed two selected examples',
      reportedOutcome: 'partial',
      failureReason: 'Other environments were not available',
    });
    const reviewed = await work(q, qp, {
      kind: 'result-recorded',
      origin: { kind: 'attempt', ...ended.objectRef },
      scopeVersion: 1,
      deliverableRefs: [],
      reportedOutcome: 'partial',
      summary: 'Independent selected-example review',
      limitations: 'Only two synthetic examples',
      supersedes: null,
    });
    const stamp = new Date((now - 60) * 1000).toISOString();
    const evidenceFields = {
      kind: 'evidence',
      expectedVersion: 0,
      evidenceType: 'self-assertion',
      synthetic: true,
      source: {
        originSystem: 'synthetic-review',
        externalStableId: 'finding-' + randomUUID(),
        contentVersion: '1',
        originalAt: stamp,
        issuer: 'Synthetic diagnostic author',
      },
      observedAt: stamp,
      reportedSourceState: 'available',
      summary: 'Initial observed finding; no external success claim',
    };
    const evidence = await client(p).submitRecord(
      task,
      facts,
      pp,
      evidenceFields,
      options(p),
    );
    const corrected = await client(p).submitRecord(
      task,
      facts,
      pp,
      {
        ...evidenceFields,
        id: evidence.id,
        expectedVersion: 1,
        reason: 'Clarify observation boundary',
        source: { ...evidenceFields.source, contentVersion: '2' },
        summary: 'Corrected boundary description',
      },
      options(p),
    );
    assert.equal(corrected.version, 2);
    const er = await client(p).readRecord({
      type: 'evidence',
      id: evidence.id,
    });
    assert.equal(er.currentVersion, 2);
    const result = await work(p, pp, {
      kind: 'result-recorded',
      origin: { kind: 'intervention', id: pd.objectRef.id, version: 1 },
      scopeVersion: 1,
      deliverableRefs: [{ kind: 'evidence', id: evidence.id, version: 2 }],
      reportedOutcome: 'partial',
      summary: 'Diagnostic report delivered',
      limitations: 'No implementation or production verification',
      supersedes: null,
    });
    const deliver = {
      kind: 'deliver',
      eventId: randomUUID(),
      expectedParticipationVersion: pp.version,
      resultRef: result.objectRef,
      interventionRefs: [
        { id: pd.objectRef.id, version: 1 },
        { id: qd.objectRef.id, version: 1 },
      ],
      evidenceRefs: [{ id: evidence.id, version: 2 }],
      summary: 'Two diagnostic contributions, one scope delivery',
    };
    await assert.rejects(
      taskWrite(
        p,
        `/v2/participations/${pp.participationId}/events`,
        { ...deliver, eventId: randomUUID(), evidenceRefs: [evidence.id] },
        [f.actor.subjectId],
      ),
      (error) => error.status === 409 || error.status === 403,
    );
    await taskWrite(
      p,
      `/v2/participations/${pp.participationId}/events`,
      deliver,
      [f.actor.subjectId],
    );
    let participation = (await getTask(f)).participations.find(
      (x) => x.participationId === pp.participationId,
    );
    await taskWrite(
      f,
      `/v2/participations/${pp.participationId}/events`,
      {
        kind: 'accept',
        eventId: randomUUID(),
        expectedParticipationVersion: participation.version,
        deliveryId: deliver.eventId,
        summary: 'Accepted the diagnostic scope, not a complete fix',
      },
      [p.actor.subjectId],
    );
    participation = (await getTask(f)).participations.find(
      (x) => x.participationId === pp.participationId,
    );
    assert.equal(
      participation.deliveries[0].acceptance.actorId,
      f.actor.subjectId,
    );
    assert.equal(participation.deliveries[0].interventionRefs.length, 2);
    assert.deepEqual(participation.deliveries[0].evidenceRefs, [
      { id: evidence.id, version: 2 },
    ]);
    facts = await client(f).readCase(task);
    assert.equal(facts.resolution.status, 'unrecorded');
    const verification = await client(f).submitRecord(
      task,
      facts,
      null,
      {
        kind: 'verification',
        expectedVersion: 0,
        target: { type: 'result', ...result.objectRef },
        scopeVersion: 1,
        method: 'requester-acceptance',
        scope: 'Diagnostic scope only',
        conditions: { remaining: 'Implementation still missing' },
        observation: 'accepted',
        summary: 'Requester accepted the bounded diagnosis',
        evidenceRefs: [{ id: evidence.id, version: 2 }],
        relationship: 'counterparty',
        observedAt: stamp,
        synthetic: true,
      },
      options(f),
    );
    await work(f, null, {
      kind: 'resolution-recorded',
      taskScopeVersion: 1,
      status: 'partially-resolved',
      summary: 'Diagnosis is useful; implementation remains',
      satisfiedGoals: ['Clarify boundary'],
      remainingGoals: ['Implement and run real validation'],
      resultRefs: [result.objectRef],
      verificationRefs: [{ id: verification.id, version: 1 }],
      supersedesResolutionId: null,
    });
    facts = await client(f).readCase(task);
    assert.equal(facts.resolution.status, 'partially-resolved');
    assert.equal(latestFacts(facts.attempts).length, 1);
    assert.equal(latestFacts(facts.attempts)[0].actorId, q.actor.subjectId);
    assert.equal(
      latestFacts(facts.results).find((x) => x.id === result.objectRef.id)
        .reportedOutcome,
      'partial',
    );
    const grant = (
      await p.db.query('SELECT consent_id FROM case_events WHERE id=$1', [
        pd.eventId,
      ])
    ).rows[0];
    await p.consents.revoke(p.actor, grant.consent_id);
    facts = await client(f).readCase(task);
    assert.equal(facts.results.length, 1);
    assert.equal(facts.results[0].id, reviewed.objectRef.id);
    assert.equal(facts.coverage.complete, false);
    assert.ok(
      facts.interventions.some((x) => x.id === qd.objectRef.id),
      'independently authorized contributor survives',
    );
    assert.equal(
      JSON.stringify(facts).includes('Diagnostic report delivered'),
      false,
    );
  } finally {
    await new Promise((resolve) => api.close(resolve));
    await f.db.close();
  }
});
