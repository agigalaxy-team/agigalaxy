import { ServiceError } from '../shared/service-error.mjs';
// Called after an actual preferences/read-state change in the same transaction.
export async function recordNotificationAudit(db,actor,authorization,{action,objectId,idempotencyKey}){
  if(!['notification.preferences','notification.read','notification.archive'].includes(action)||!authorization?.credentialScopes?.includes('notifications'))
    throw new Error('Notification audit authorization unavailable');
  const row=await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,
    context_version,client_id,audience,scope,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,
    caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
    SELECT $1,$2,$3::text,$4::text,'accepted',1,ch.payload->>'installationId',b.audience,'notifications',
      b.id,$5::uuid,$4::text,b.scopes,$6::jsonb,b.id,ch.payload->>'installationId',b.audience,b.scopes
    FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id
    WHERE b.id=$7::uuid AND b.subject_id=$1 AND b.scopes ? 'notifications' RETURNING sequence`,
  [actor.subjectId,action,objectId,idempotencyKey,actor.httpRequestId??null,JSON.stringify(authorization.credentialScopes),authorization.callerBindingId]);
  if(row.rows.length!==1)throw new ServiceError('notification_audit_unavailable',503);
}
