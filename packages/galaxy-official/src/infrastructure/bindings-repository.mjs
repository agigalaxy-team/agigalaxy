import { recordAuthAudit } from './auth-audit.mjs';
// Named SQL operations. Uses only the supplied connection; no pool or transaction ownership.
export function bindingRepository(db) {
  return {
    insertChallenge: values => db.query(`INSERT INTO binding_challenges(id,subject_id,payload,token_hash,expires_at)
      VALUES ($1,$2,$3,$4,$5)`, values),
    lockChallenge: values => db.query('SELECT * FROM binding_challenges WHERE id=$1 FOR UPDATE', values),
    forChallenge: values => db.query('SELECT * FROM bindings WHERE challenge_id=$1', values),
    declareSubject: values => db.query(`INSERT INTO subjects(id,public_key,genesis_proof) VALUES ($1,$2,$3)
        ON CONFLICT (id) DO NOTHING`, values),
    lockSubject: values => db.query('SELECT public_key FROM public.galaxy_api_lock_subject_control($1,true)', values),
    insertBinding: (values,control={}) => db.query(`INSERT INTO bindings(id,subject_id,challenge_id,request_hash,audience,scopes,receipt,expires_at,device_id,key_id,control_epoch)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [...values,control.deviceId??null,control.epoch?control.keyId:null,control.epoch||null]),
    consumeChallenge: values => db.query('UPDATE binding_challenges SET consumed_at=$2 WHERE id=$1', values),
    auditCreate: ([subjectId, bindingId, requestId, httpRequestId = null]) => recordAuthAudit(db, { subjectId, bindingId, requestId, action: 'binding.create', httpRequestId }),
    getOwned: values => db.query('SELECT id,subject_id,scopes,expires_at,revoked_at FROM bindings WHERE id=$1 AND subject_id=$2', values),
    queryOwned: (subjectId,endpoint,{after,limit,bindingId,installationId}) => db.query(`SELECT b.id,b.scopes,b.created_at,b.expires_at,b.revoked_at,
      ch.payload->>'installationId' AS installation_id FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id
      WHERE b.subject_id=$1 AND b.audience=$2 AND ($3::uuid IS NULL OR b.id>$3) AND ($4::uuid IS NULL OR b.id=$4)
      AND ($5::text IS NULL OR ch.payload->>'installationId'=$5) ORDER BY b.id LIMIT $6`,
      [subjectId,endpoint,after??null,bindingId??null,installationId??null,limit+1]),
    lockOwned: values => db.query('SELECT * FROM bindings WHERE id=$1 AND subject_id=$2 FOR UPDATE', values),
    lockRevokeBindings: ids => db.query('SELECT * FROM bindings WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]),
    lockRevokeCredential: (hash, bindingId, time) => db.query(`SELECT scopes FROM access_credentials
      WHERE token_hash=$1 AND binding_id=$2 AND revoked_at IS NULL AND expires_at>$3 FOR SHARE`, [hash, bindingId, time]),
    revoke: values => db.query("UPDATE bindings SET revoked_at=COALESCE(revoked_at,$2),revocation_kind='explicit-binding',revocation_control_event_id=NULL,revocation_request_id=$3 WHERE id=$1", values),
    revokeCredentials: values => db.query('UPDATE access_credentials SET revoked_at=$2 WHERE binding_id=$1 AND revoked_at IS NULL', values),
    auditRevoke: ([subjectId, bindingId, requestId, httpRequestId = null, credentialScopes = null, callerBindingId = null]) => recordAuthAudit(db, { subjectId, bindingId, requestId, action: 'binding.revoke', httpRequestId, credentialScopes, callerBindingId }),
  };
}
