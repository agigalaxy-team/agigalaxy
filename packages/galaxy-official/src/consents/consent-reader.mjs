import { consentRepository } from "../infrastructure/consent-repository.mjs";
import { ServiceError } from "../shared/service-error.mjs";
import { digest } from "../shared/digest.mjs";

export class ConsentReader {
  constructor({ now, readGrant }) { this.now = now; this.readGrant = readGrant; }

  // Must be called within the same transaction as the protected data mutation or
  // job commit. Revocation waits for this lock; queued work must recheck afresh.
  async require(db, { id, subjectId, action, objectId, recipient, payloadJson }) {
    const row = (await (this.readGrant ? this.readGrant(db, id, subjectId, this.now()) : consentRepository(db).liveGrant(id, subjectId, new Date(this.now() * 1000).toISOString()))).rows[0];
    if (!row || row.intent.action !== action || row.intent.objectId !== objectId || row.intent.recipient !== recipient
      || typeof payloadJson !== 'string' || digest(payloadJson) !== row.intent.payloadHash)
      throw new ServiceError('consent_required', 403);
    let payload;
    try { payload = JSON.parse(payloadJson); } catch { throw new ServiceError('invalid_payload'); }
    if (!payload || Object.getPrototypeOf(payload) !== Object.prototype
      || Object.keys(payload).some(key => !row.intent.fields.includes(key))) throw new ServiceError('disclosure_mismatch', 403);
    // This is current read visibility, not part of the signed intent and not a
    // permanent revocation. Canceling an unexecuted request restores visibility
    // only if the original grant and binding are still otherwise live.
    const pending = (await db.query("SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased') LIMIT 1", [subjectId])).rows.length > 0;
    return pending ? { ...row.intent, currentVisibility: { deletionPending: true } } : row.intent;
  }
}
