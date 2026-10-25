const optionalIds=['grantId','strategyId','strategyVersionId','toolCallId','toolOperationId'].map(key=>
 `AND (NOT(actor_context?'${key}') OR (jsonb_typeof(actor_context->'${key}')='string' AND (actor_context->>'${key}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))`).join('\n');
// Separate from immutable command inputs/results: receipt reconciliation keeps
// its original exact shape. Historical records intentionally remain unknown.
export const businessAuditAttributionMigrationSql=`
ALTER TABLE business_admin_audit_v1 ADD COLUMN actor_context jsonb;
ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_actor_context_v1 CHECK(
 actor_context IS NULL OR COALESCE((jsonb_typeof(actor_context)='object' AND actor_context->'schemaVersion'='1'::jsonb
 AND actor_kind='operations-ai-service' AND operator_role IS NULL AND operator_id='ai:'||(actor_context->>'aiAccountId')
 AND actor_context ?& ARRAY['schemaVersion','aiAccountId','domain','taskId','planId','planVersion']
 AND actor_context->>'domain' IN ('overview','governance','messaging','discovery','maintenance')
 AND jsonb_typeof(actor_context->'planVersion')='number' AND (actor_context->>'planVersion')::numeric BETWEEN 1 AND 9007199254740991
 AND trunc((actor_context->>'planVersion')::numeric)=(actor_context->>'planVersion')::numeric
 AND (NOT(actor_context?'grantVersion') OR (jsonb_typeof(actor_context->'grantVersion')='number' AND (actor_context->>'grantVersion')::numeric BETWEEN 1 AND 9007199254740991 AND trunc((actor_context->>'grantVersion')::numeric)=(actor_context->>'grantVersion')::numeric))
 AND (NOT(actor_context?'judgmentKind') OR (actor_context->>'judgmentKind' IN ('ai','code') AND actor_context ?& ARRAY['toolCallId','toolOperationId']))
 ${optionalIds}
 AND (actor_context->>'aiAccountId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 AND (actor_context->>'taskId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 AND (actor_context->>'planId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 AND octet_length(actor_context::text)<=4096
 AND actor_context-ARRAY['schemaVersion','aiAccountId','domain','taskId','planId','planVersion','grantId','grantVersion','strategyId','strategyVersionId','toolCallId','toolOperationId','judgmentKind']='{}'::jsonb),false));
`;
