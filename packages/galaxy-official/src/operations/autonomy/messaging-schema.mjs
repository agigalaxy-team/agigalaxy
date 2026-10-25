export const operationsAutonomyMessagingMigrationSql=`
ALTER TABLE operations_messaging_plans_v1 ADD COLUMN approved_ai jsonb;
ALTER TABLE operations_messaging_plans_v1 ADD CONSTRAINT operations_messaging_plan_approved_ai_check CHECK (
 approved_ai IS NULL OR (jsonb_typeof(approved_ai)='object' AND approved_ai ? 'aiAccountId' AND jsonb_typeof(approved_ai->'aiAccountId')='string' AND approved_by IS NOT NULL AND approved_role IS NULL AND approved_by='ai:'||(approved_ai->>'aiAccountId')));
ALTER TABLE operations_messaging_runs_v1 ADD COLUMN approved_ai jsonb;
ALTER TABLE operations_messaging_runs_v1 ALTER COLUMN approved_role DROP NOT NULL;
ALTER TABLE operations_messaging_runs_v1 ADD CONSTRAINT operations_messaging_run_approval_source_check CHECK (
 (approved_ai IS NULL AND approved_role IS NOT NULL AND approved_role IN ('reader','administrator')) OR
 (approved_ai IS NOT NULL AND jsonb_typeof(approved_ai)='object' AND approved_ai ? 'aiAccountId' AND jsonb_typeof(approved_ai->'aiAccountId')='string' AND approved_role IS NULL AND approved_by='ai:'||(approved_ai->>'aiAccountId')));
ALTER TABLE operations_messaging_events_v1 ADD COLUMN actor_kind text NOT NULL DEFAULT 'business-operator';
ALTER TABLE operations_messaging_events_v1 ADD COLUMN ai_context jsonb;
ALTER TABLE operations_messaging_events_v1 ALTER COLUMN operator_role DROP NOT NULL;
ALTER TABLE operations_messaging_events_v1 ADD CONSTRAINT operations_messaging_event_actor_check CHECK (
 (actor_kind='business-operator' AND ai_context IS NULL AND operator_role IS NOT NULL AND operator_role IN ('reader','administrator')) OR
 (actor_kind='operations-ai-service' AND ai_context IS NOT NULL AND jsonb_typeof(ai_context)='object' AND ai_context ? 'aiAccountId' AND jsonb_typeof(ai_context->'aiAccountId')='string' AND operator_role IS NULL AND operator_id='ai:'||(ai_context->>'aiAccountId')));
`;
