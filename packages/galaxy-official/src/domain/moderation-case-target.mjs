import { canReadProjection } from './consent-policy.mjs';
import { ServiceError } from '../shared/service-error.mjs';

// Case participants are owner assertions. Only the owner becomes a party here;
// a visible-source reader participates by signing their own report.
export async function readModerationCaseTarget(db, { caseId, viewerId, consents, endpoint, now, write = false }) {
  const parent = (await db.query(`SELECT * FROM cases WHERE id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`, [caseId])).rows[0];
  if (!parent || parent.state === 'withdrawn') throw new ServiceError('not_found', 404);
  const rows = (await db.query('SELECT * FROM case_events WHERE case_id=$1 ORDER BY version LIMIT 1001', [caseId])).rows;
  if (!rows.length || rows.length > 1000 || rows.length !== parent.version) throw new ServiceError('not_found', 404);
  for (const row of rows) {
    try {
      const grant = await consents.require(db, { id: row.consent_id, subjectId: parent.subject_id,
        action: 'case.teaser.publish', objectId: row.id, recipient: endpoint, payloadJson: row.payload_text });
      if (!canReadProjection(grant, { viewerId, projection: 'history', now })) throw new ServiceError('not_found', 404);
    } catch (error) { if (error instanceof ServiceError) throw new ServiceError('not_found', 404); throw error; }
  }
  return { parent, rows };
}
