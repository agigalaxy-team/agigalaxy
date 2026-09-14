import { recordAuthAudit } from './auth-audit.mjs';
import { bindingControl,lockSubjectControl } from './identity-control-repository.mjs';
// The caller supplies either a pool for standalone operations or the pinned
// transaction client for activation/authorization. Never creates a connection.
export function accessRepository(db) {
  const one = (sql, values) => db.query(sql, values).then(result => result.rows[0]);
  return {
    binding: id => one('SELECT * FROM bindings WHERE id=$1', [id]),
    insertChallenge: values => db.query(`INSERT INTO session_challenges(id,binding_id,challenge_hash,credential_hash,expires_at)
      VALUES ($1,$2,$3,$4,$5)`, values),
    lockBinding: async id => {
      const initial=await one('SELECT * FROM bindings WHERE id=$1',[id]);
      if(!initial)return null;
      await lockSubjectControl(db,initial.subject_id);
      return bindingControl(db,await one('SELECT * FROM bindings WHERE id=$1 FOR UPDATE',[id]));
    },
    lockChallenge: id => one('SELECT * FROM session_challenges WHERE id=$1 FOR UPDATE', [id]),
    insertCredential: values => db.query(`INSERT INTO access_credentials(token_hash,binding_id,scopes,expires_at,device_id,key_id,control_epoch)
      SELECT $1,id,$3,$4,device_id,key_id,control_epoch FROM bindings WHERE id=$2`, values),
    consumeChallenge: (id, time) => db.query('UPDATE session_challenges SET consumed_at=$2 WHERE id=$1', [id, time]),
    auditSession: (subjectId, bindingId, requestId, httpRequestId = null) => recordAuthAudit(db, { subjectId, bindingId, requestId, action: 'session.create', httpRequestId }),
    authenticate: async (hash, time) => bindingControl(db,await one(`SELECT b.subject_id,b.id,b.audience,b.device_id,b.key_id,b.control_epoch,c.scopes,b.scopes AS binding_scopes,ch.payload->>'installationId' AS client_id FROM access_credentials c
      JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id WHERE c.token_hash=$1
      AND c.revoked_at IS NULL AND b.revoked_at IS NULL AND c.expires_at>$2 AND b.expires_at>$2
      AND c.control_epoch IS NOT DISTINCT FROM b.control_epoch AND c.device_id IS NOT DISTINCT FROM b.device_id`, [hash, time])),
    lockAuthorization: async (actor, endpoint, time) => {
      await lockSubjectControl(db,actor.subjectId);
      const row=await one(`SELECT b.subject_id,b.id,b.device_id,b.key_id,b.control_epoch,c.scopes FROM bindings b
      JOIN access_credentials c ON c.binding_id=b.id WHERE b.id=$1 AND b.subject_id=$2 AND c.token_hash=$3
      AND b.audience=$4 AND b.revoked_at IS NULL AND c.revoked_at IS NULL
      AND b.expires_at>$5 AND c.expires_at>$5 AND c.control_epoch IS NOT DISTINCT FROM b.control_epoch
      AND c.device_id IS NOT DISTINCT FROM b.device_id FOR SHARE OF b,c`,
        [actor.bindingId, actor.subjectId, actor.credentialHash, endpoint, time]);
      return bindingControl(db,row);
    },
  };
}
