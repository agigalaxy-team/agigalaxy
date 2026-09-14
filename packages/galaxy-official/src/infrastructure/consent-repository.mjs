import { recordObjectAudit } from './object-audit.mjs';
export function consentRepository(db) {
  const one = (sql, values) => db.query(sql, values).then(result => result.rows[0]);
  return {
    list: (subjectId, after) => db.query(`SELECT c.*,b.revoked_at AS binding_revoked,b.expires_at AS binding_expires
      FROM consents c JOIN bindings b ON b.id=c.binding_id WHERE c.subject_id=$1
      AND ($2::uuid IS NULL OR c.id>$2::uuid) ORDER BY c.id LIMIT 101`, [subjectId, after]).then(result => result.rows),
    subject: id => one('SELECT public_key FROM subjects WHERE id=$1', [id]),
    insert: (values,signature={}) => db.query(`INSERT INTO consents(id,subject_id,binding_id,intent,signature_hash,expires_at,
      signature_envelope,signed_payload_text,signer_key_id,control_epoch,control_event_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING`,
      [...values,signature.envelope??null,signature.payloadText??null,signature.keyId??null,signature.epoch??null,signature.chainHead??null]),
    lock: id => one('SELECT * FROM consents WHERE id=$1 FOR UPDATE', [id]),
    lockOwned: (id, subjectId) => one('SELECT * FROM consents WHERE id=$1 AND subject_id=$2 FOR UPDATE', [id, subjectId]),
    auditCreate: (subjectId, id, httpRequestId = null, credentialScopes, callerBindingId) => recordObjectAudit(db, { subjectId, objectId: id, action: 'consent.create', httpRequestId, credentialScopes, callerBindingId }),
    revoke: (id, time) => db.query('UPDATE consents SET revoked_at=$2 WHERE id=$1', [id, time]),
    auditRevoke: (subjectId, id, httpRequestId = null, credentialScopes, callerBindingId) => recordObjectAudit(db, { subjectId, objectId: id, action: 'consent.revoke', httpRequestId, credentialScopes, callerBindingId }),
    liveGrant: (id, subjectId, time) => db.query(`SELECT c.* FROM consents c JOIN bindings b ON b.id=c.binding_id
      WHERE c.id=$1 AND c.subject_id=$2 AND c.revoked_at IS NULL AND b.revoked_at IS NULL
      AND c.expires_at>$3 AND b.expires_at>$3 FOR SHARE OF c,b`, [id, subjectId, time]),
  };
}
