export async function recordAuthAudit(db, { subjectId, bindingId, requestId, action, httpRequestId = null, credentialScopes = null, callerBindingId = null }) {
  if (!['binding.create', 'binding.revoke', 'session.create'].includes(action)) throw new Error('Unsupported audit action');
  const idempotencyKey = action === 'binding.revoke' ? bindingId : requestId;
  const result = await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,
    context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
    SELECT $1,$4,$2::text,$3,'accepted',1,ch.payload->>'installationId',b.audience,'binding',NULL,b.id,$5,$6,b.scopes,
      CASE WHEN $4='session.create' THEN
        (SELECT ac.scopes FROM session_challenges sc JOIN access_credentials ac ON ac.token_hash=sc.credential_hash
         WHERE sc.id=$3::text::uuid AND sc.binding_id=b.id AND ac.binding_id=b.id) ELSE $7::jsonb END,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
    FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id
    LEFT JOIN bindings cb ON cb.id=CASE WHEN $4='binding.revoke' THEN $8::uuid ELSE b.id END AND cb.subject_id=$1
    LEFT JOIN binding_challenges cch ON cch.id=cb.challenge_id
    WHERE ($8::uuid IS NULL OR cb.id IS NOT NULL) AND b.id=$2::text::uuid AND b.subject_id=$1 RETURNING sequence`,
    [subjectId, bindingId, requestId, action, httpRequestId, idempotencyKey, credentialScopes === null ? null : JSON.stringify(credentialScopes), callerBindingId]);
  if (result.rows.length !== 1) throw new Error('Audit context unavailable');
}
