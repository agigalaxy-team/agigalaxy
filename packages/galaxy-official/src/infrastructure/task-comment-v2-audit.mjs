export async function recordTaskCommentAudit(
  db,
  actor,
  authorization,
  { id, governance = false, action },
) {
  const scope = governance ? 'moderation' : 'assistance',
    table = governance
      ? 'comment_governance_events_v2'
      : 'task_comment_events_v2';
  if (
    !authorization?.credentialScopes?.includes(scope) ||
    !authorization.callerBindingId
  )
    throw new Error('Comment audit authorization required');
  const rows = (
    await db.query(
      `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,
 context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,
 caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
 SELECT $1,$3,$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,$7,c.id,b.id,$4,$2::text,b.scopes,$5::jsonb,
 cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM ${table} e JOIN consents c ON c.id=e.consent_id
 JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id
 JOIN bindings cb ON cb.id=$6::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id
 WHERE e.id=$2::text::uuid AND e.subject_id=$1 AND c.subject_id=$1 AND b.subject_id=$1 RETURNING sequence`,
      [
        actor.subjectId,
        id,
        action,
        actor.httpRequestId ?? null,
        JSON.stringify(authorization.credentialScopes),
        authorization.callerBindingId,
        scope,
      ],
    )
  ).rows;
  if (rows.length !== 1) throw new Error('Comment event audit unavailable');
}
