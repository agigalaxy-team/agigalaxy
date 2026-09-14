import { projectCaseReviews } from './case-review.mjs';
import { canReadProjection } from './consent-policy.mjs';
import { ServiceError } from '../shared/service-error.mjs';

// Companion read-time context; never changes the signed CI execution assertion.
export async function readProofCaseContext(db, { evidenceId, subjectId, viewerId, consents, endpoint, now }) {
  const source = (await db.query('SELECT case_id FROM evidence_submissions WHERE id=$1 AND subject_id=$2', [evidenceId, subjectId])).rows[0];
  if (!source) return null;
  const rows = (await db.query('SELECT * FROM case_events WHERE case_id=$1 ORDER BY version LIMIT 1001', [source.case_id])).rows;
  if (rows.length > 1000 || !rows.some(row => row.kind === 'revision')) return null;
  for (const row of rows) {
    try {
      const grant = await consents.require(db, { id: row.consent_id, subjectId, action: 'case.teaser.publish',
        objectId: row.id, recipient: endpoint, payloadJson: row.payload_text });
      if (!canReadProjection(grant, { viewerId, projection: 'history', now })) return null;
    } catch (error) { if (error instanceof ServiceError) return null; throw error; }
  }
  const events = rows.map(row => row.payload);
  const reviews = projectCaseReviews(events);
  const corrections = events.filter(event => event.kind === 'revision' && !event.review)
    .map(event => ({ eventId: event.id, targetEventId: event.correctsEventId, reason: event.reason, summary: event.summary }));
  const activeDispute = reviews.some(review => review.type === 'dispute' && ['opened', 'in-review', 'reopened'].includes(review.state));
  return { caseId: source.case_id, sourceVersion: rows.at(-1).version, checkedAt: now,
    status: activeDispute ? 'active-dispute' : corrections.length ? 'has-corrections' : 'review-recorded',
    scope: 'visible-case-context-only', authority: 'case-owner-reported', independentDecision: false,
    affectsSignedCiFact: false, reviews, corrections };
}
