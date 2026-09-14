// Named v2 event receipt only. Never duplicate selected material in audit rows.
export async function recordContextV2Audit(db, {subjectId,objectId,action,httpRequestId,credentialScopes,callerBindingId}) {
  if (!['context.create','context.accept','context.decline','context.revoke'].includes(action)
    || !credentialScopes?.includes('context') || typeof callerBindingId !== 'string') throw new Error('Context audit authorization unavailable');
  const grant = action === 'context.create';
  const rows = (await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,
    context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,
    caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
    SELECT $1,$3,$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'context',c.id,b.id,$4,$2::text,b.scopes,$5::jsonb,
      cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
    FROM ${grant?'context_grants_v2':'context_events_v2'} e JOIN consents c ON c.id=e.consent_id
      JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id
      JOIN bindings cb ON cb.id=$6::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id
    WHERE e.id=$2::text::uuid AND e.subject_id=$1 AND c.subject_id=$1 AND b.subject_id=$1 RETURNING sequence`,
  [subjectId,objectId,action,httpRequestId??null,JSON.stringify(credentialScopes),callerBindingId])).rows;
  if (rows.length !== 1) throw new Error('Context event audit unavailable');
}
