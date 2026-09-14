import { recordObjectAudit } from './object-audit.mjs';
// Named SQL operations. Uses only the supplied connection; no pool or transaction ownership.
export function proofRepository(db) {
  return {
    evidence: values => db.query('SELECT * FROM evidence_submissions WHERE id=$1 AND subject_id=$2', values),
    lockEvidence: values => db.query('SELECT state FROM evidence_submissions WHERE id=$1 FOR SHARE', values),
    latestObservation: values => db.query('SELECT id,job_id,observation FROM verification_attempts WHERE evidence_id=$1 ORDER BY ordinal DESC LIMIT 1', values),
    lock: values => db.query('SELECT * FROM proofs WHERE id=$1 FOR UPDATE', values),
    insert: values => db.query(`INSERT INTO proofs(id,subject_id,evidence_id,observation_id,consent_id,payload_text,payload_hash,signed)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING RETURNING id`, values),
    get: values => db.query('SELECT * FROM proofs WHERE id=$1', values),
    auditPublish: ([subjectId, objectId, httpRequestId = null, credentialScopes, callerBindingId]) => recordObjectAudit(db, { subjectId, objectId, action: 'proof.publish', httpRequestId, credentialScopes, callerBindingId }),
    lockStatus: values => db.query('SELECT revoked_at FROM proofs WHERE id=$1 FOR SHARE', values),
    lockOwned: values => db.query('SELECT * FROM proofs WHERE id=$1 AND subject_id=$2 FOR UPDATE', values),
    revoke: values => db.query('UPDATE proofs SET revoked_at=$2 WHERE id=$1', values),
    auditRevoke: ([subjectId, objectId, httpRequestId = null, credentialScopes, callerBindingId]) => recordObjectAudit(db, { subjectId, objectId, action: 'proof.revoke', httpRequestId, credentialScopes, callerBindingId }),
  };
}
