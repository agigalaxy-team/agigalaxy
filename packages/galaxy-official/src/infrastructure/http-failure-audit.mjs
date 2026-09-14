import { boundedFailureAudit } from '../adapters/http/failure-audit.mjs';
import { transaction } from '../database.mjs';
import { failureActor } from '../shared/http-failure-context.mjs';

export function createHttpFailureAudit(db, endpoint, bounds) {
  return boundedFailureAudit(httpFailureWriter(db, endpoint), bounds);
}

export function httpFailureWriter(database, endpoint, {now=()=>Math.floor(Date.now()/1000)}={}) {
  return async ({ requestId, status, route, actor, observedAt = new Date().toISOString() }) => {
    // All event fields are selected by the HTTP adapter; no code/message/body,
    // headers, IP, token, credential hash or raw URL reaches this repository.
    if (!Number.isInteger(status) || status < 400 || status > 599) throw new Error('Invalid failure status');
    actor=failureActor(actor);
    if(actor?.authentication&&(actor.authentication.version===2?actor.authentication.endpoint!==endpoint:actor.authentication.audience!==endpoint))throw new Error('Failure audit audience mismatch');
    return transaction(database,async db=>{
    await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    // Match maintenance lock order. A delivery either precedes deletion or sees
    // its tombstone; an old statement snapshot cannot reinsert after erasure.
    await db.query('LOCK TABLE audit_events,deletion_requests IN ROW EXCLUSIVE MODE');
    if(actor&&(await db.query(`SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('partial','primary-erased')
      AND (execution_result->'audit'->>'until')::bigint<=$2`,[actor.subjectId,now()])).rows.length)
      return {state:'suppressed-by-deletion'};
    const result = await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,
      context_version,client_id,audience,http_request_id,idempotency_key,
      caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes,created_at,scope,credential_scopes)
      SELECT COALESCE($7::text,'http-request'),$1,$2,$3::text,$4,0,'galaxy-http-api',$5,$3::text::uuid,$3::text,
        CASE WHEN $9::jsonb IS NULL THEN b.id ELSE $6::uuid END,
        CASE WHEN $9::jsonb IS NULL THEN ch.payload->>'installationId' ELSE $9::jsonb->>'clientId' END,
        CASE WHEN $9::jsonb IS NULL THEN b.audience ELSE $9::jsonb->>'audience' END,
        CASE WHEN $9::jsonb IS NULL THEN b.scopes ELSE $9::jsonb->'bindingScopes' END,
        $8::timestamptz,$9::jsonb->>'scope',$9::jsonb->'credentialScopes'
      FROM (SELECT 1) seed LEFT JOIN bindings b ON b.id=$6::uuid AND b.subject_id=$7
      LEFT JOIN binding_challenges ch ON ch.id=b.challenge_id
      ON CONFLICT (http_request_id,action) WHERE action IN ('http.rejected','http.failed') DO NOTHING RETURNING sequence`,
      [status < 500 ? 'http.rejected' : 'http.failed', route, requestId, String(status), endpoint,
        actor?.bindingId ?? null, actor?.subjectId ?? null, observedAt,actor?.authentication?JSON.stringify(actor.authentication):null]);
    // A lost acknowledgement may replay the same event after process restart.
    // The partial unique index confirms at most one insert, including races.
    if (result.rows.length > 1) throw new Error('Failure audit unavailable');
    return {state:'recorded'};
    });
  };
}
