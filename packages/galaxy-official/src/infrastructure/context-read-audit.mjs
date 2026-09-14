import { randomUUID } from 'node:crypto';
import { ServiceError } from '../shared/service-error.mjs';

// Each authorized material read is a distinct event. Never copy selected text or labels.
export async function recordContextRead(db, actor, authorization, {objectId,action,consentId=null}) {
  if(!['context.read','context.metadata.read','context.query','context.export.read','context.export.inspect'].includes(action)
    ||!authorization?.credentialScopes?.includes('context'))throw new Error('Context read authorization unavailable.');
  const requestId=randomUUID();
  const result=await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,
    context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,
    caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
    SELECT $1,$2,$3::text,$4::text,'accepted',1,ch.payload->>'installationId',b.audience,'context',$5::uuid,b.id,$6::uuid,$4::text,
      b.scopes,$7::jsonb,b.id,ch.payload->>'installationId',b.audience,b.scopes
    FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id
    WHERE b.id=$8::uuid AND b.subject_id=$1 AND b.scopes ? 'context' RETURNING sequence`,
    [actor.subjectId,action,objectId,requestId,consentId,actor.httpRequestId??null,JSON.stringify(authorization.credentialScopes),authorization.callerBindingId]);
  if(result.rows.length!==1)throw new ServiceError('context_read_audit_unavailable',503);
}

