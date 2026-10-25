import {proposalTargetTypeSql} from '../../infrastructure/autonomy-target-type-v1.mjs';
export const operationsAutonomyMigrationSql=`
CREATE TABLE operations_autonomy_runtime_v1(endpoint text PRIMARY KEY,revision integer NOT NULL,configuration jsonb NOT NULL,updated_by text,updated_at timestamptz NOT NULL);
CREATE TABLE operations_autonomy_runtime_versions_v1(endpoint text NOT NULL,revision integer NOT NULL,configuration jsonb NOT NULL,operator_id text,created_at timestamptz NOT NULL,PRIMARY KEY(endpoint,revision));
CREATE TABLE operations_autonomy_configs_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,domain text NOT NULL CHECK(domain IN ('overview','governance','messaging','discovery','maintenance')),
 revision integer NOT NULL CHECK(revision>0),enabled boolean NOT NULL DEFAULT false,configuration jsonb NOT NULL,
 prompt_version integer NOT NULL,plan_version integer NOT NULL,delegation_version integer,
 next_due_at timestamptz,last_valid_at timestamptz,enabled_at timestamptz,updated_by text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(endpoint,domain));
CREATE TABLE operations_autonomy_versions_v1(
 config_id uuid NOT NULL REFERENCES operations_autonomy_configs_v1(id),revision integer NOT NULL,configuration jsonb NOT NULL,prompt_version integer NOT NULL,plan_version integer NOT NULL,
 delegation_version integer,operator_id text,created_at timestamptz NOT NULL,PRIMARY KEY(config_id,revision));
CREATE TABLE operations_autonomy_tasks_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,config_id uuid REFERENCES operations_autonomy_configs_v1(id),config_revision integer,
 ai_account_id uuid,domain text NOT NULL,source text NOT NULL CHECK(source IN ('workbench','routine','event','recovery')),
 source_key text NOT NULL,title text NOT NULL,mode text NOT NULL CHECK(mode IN ('code','ai','ai-human','human-ai')),
 state text NOT NULL CHECK(state IN ('queued','running','waiting-human','paused','completed','failed','stopped','blocked','unknown')),
 model_state text NOT NULL,business_state text NOT NULL,revision integer NOT NULL DEFAULT 1,configuration jsonb NOT NULL,
 prompt_version integer NOT NULL,plan_version integer NOT NULL,delegation_version integer,session_id uuid NOT NULL,native_run_id text,native_continuable boolean NOT NULL DEFAULT false,
 target_type text,target_id text,event_ids uuid[] NOT NULL DEFAULT '{}',effective_check boolean NOT NULL DEFAULT false,
 human_decision jsonb,model_usage jsonb,primary_model_usage jsonb,code text,summary text,dispatch_started_at timestamptz,lease_owner uuid,lease_until timestamptz,
 due_at timestamptz NOT NULL,started_at timestamptz,completed_at timestamptz,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 UNIQUE(endpoint,source_key),CHECK((target_type IS NULL)=(target_id IS NULL)));
CREATE INDEX operations_autonomy_tasks_page_v1 ON operations_autonomy_tasks_v1(endpoint,created_at DESC,id DESC);
CREATE INDEX operations_autonomy_tasks_due_v1 ON operations_autonomy_tasks_v1(endpoint,state,due_at);
CREATE INDEX operations_autonomy_tasks_target_v1 ON operations_autonomy_tasks_v1(endpoint,target_type,target_id);
CREATE TABLE operations_autonomy_events_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,domain text NOT NULL,event_key text NOT NULL,event_type text NOT NULL,
 target_type text,target_id text,source_version text,created_at timestamptz NOT NULL,available_at timestamptz NOT NULL,task_id uuid REFERENCES operations_autonomy_tasks_v1(id),processed_at timestamptz,UNIQUE(endpoint,event_key));
CREATE INDEX operations_autonomy_events_due_v1 ON operations_autonomy_events_v1(endpoint,available_at) WHERE processed_at IS NULL;
CREATE TABLE operations_autonomy_receipts_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,task_id uuid NOT NULL REFERENCES operations_autonomy_tasks_v1(id),operation_id uuid NOT NULL,
 action text NOT NULL,target_type text,target_id text,state text NOT NULL CHECK(state IN ('completed','failed','unknown','no-action')),
 basis text NOT NULL,details jsonb,created_at timestamptz NOT NULL,UNIQUE(endpoint,task_id,operation_id));
CREATE TABLE operations_autonomy_tool_calls_v1(
 endpoint text NOT NULL,task_id uuid NOT NULL REFERENCES operations_autonomy_tasks_v1(id),call_id uuid NOT NULL,tool text NOT NULL,arguments jsonb NOT NULL,
 operation_id uuid NOT NULL,state text NOT NULL,code text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,PRIMARY KEY(endpoint,task_id,call_id));
CREATE TABLE operations_autonomy_commands_v1(
 endpoint text NOT NULL,operation_id uuid NOT NULL,operator_id text NOT NULL,kind text NOT NULL,input jsonb NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL,PRIMARY KEY(endpoint,operation_id));
CREATE TABLE operations_autonomy_decisions_v1(
 endpoint text NOT NULL,task_id uuid NOT NULL REFERENCES operations_autonomy_tasks_v1(id),call_id uuid NOT NULL,
 operation_id uuid NOT NULL,decision_operation_id uuid NOT NULL,operator_id text NOT NULL,
 decision text NOT NULL CHECK(decision IN ('rejected','cancelled','no-action')),created_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,task_id,call_id),UNIQUE(endpoint,decision_operation_id),
 FOREIGN KEY(endpoint,task_id,call_id) REFERENCES operations_autonomy_tool_calls_v1(endpoint,task_id,call_id));
CREATE TABLE operations_autonomy_workbench_runs_v1(
 endpoint text NOT NULL,task_id uuid NOT NULL REFERENCES operations_autonomy_tasks_v1(id),turn_operation_id uuid NOT NULL,
 native_run_id text,model_state text NOT NULL,state text NOT NULL,usage jsonb,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,task_id,turn_operation_id),UNIQUE(endpoint,native_run_id));
ALTER TABLE operations_p13_strategy_versions_v1 ADD COLUMN ordinary_task_id uuid REFERENCES operations_autonomy_tasks_v1(id),
 ADD COLUMN ordinary_ai_account_id uuid REFERENCES operations_ai_work_accounts_v1(id);
CREATE TABLE operations_autonomy_health_v1(endpoint text PRIMARY KEY,started_at timestamptz NOT NULL,checked_at timestamptz NOT NULL,last_tick_at timestamptz NOT NULL);
CREATE TABLE operations_autonomy_strategy_schedules_v1(endpoint text NOT NULL,strategy_id uuid NOT NULL,version_id uuid NOT NULL REFERENCES operations_p13_strategy_versions_v1(id),next_due_at timestamptz NOT NULL,PRIMARY KEY(endpoint,strategy_id));
CREATE TABLE operations_autonomy_event_consumers_v1(endpoint text NOT NULL,event_id uuid NOT NULL REFERENCES operations_autonomy_events_v1(id),strategy_id uuid NOT NULL,task_id uuid NOT NULL REFERENCES operations_autonomy_tasks_v1(id),PRIMARY KEY(endpoint,event_id,strategy_id));
CREATE FUNCTION public.galaxy_autonomy_workbench_receipts_v1(wanted_endpoint text,wanted_task uuid)
 RETURNS TABLE(operation_id uuid,action text,target_type text,target_id text,state text,details jsonb) LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $receipts$
 SELECT c.operation_id,COALESCE(c.proposal->>'kind','workbench-action'),
 ${proposalTargetTypeSql('c.proposal')},
 CASE WHEN c.proposal->>'kind'='public-content-batch' THEN NULL ELSE c.proposal->'target'->>'id' END,
 CASE WHEN c.state='completed' AND c.result->'receipt' IS NOT NULL AND c.result->'receipt'<>'null'::jsonb THEN 'completed' ELSE 'unknown' END,
 CASE WHEN c.proposal->>'kind'='public-content-batch' AND jsonb_typeof(c.result#>'{receipt,counts}')='object' AND jsonb_typeof(c.result#>'{receipt,items}')='array'
 THEN jsonb_build_object('counts',jsonb_build_object('applied',c.result#>'{receipt,counts,applied}','rejected',c.result#>'{receipt,counts,rejected}'),
  'items',(SELECT jsonb_agg(jsonb_build_object('kind',i->>'kind','id',i->>'id','status',i->>'status','code',i->'code','revision',i->'revision')) FROM jsonb_array_elements(c.result#>'{receipt,items}') i)) ELSE NULL END
 FROM operations_agentos_conversation_cards_v1 c JOIN operations_autonomy_tasks_v1 t ON t.endpoint=c.endpoint
 AND (t.id=c.turn_id OR EXISTS(SELECT 1 FROM operations_autonomy_workbench_runs_v1 r WHERE r.endpoint=t.endpoint AND r.task_id=t.id AND r.turn_operation_id=c.turn_id))
 WHERE t.endpoint=wanted_endpoint AND t.id=wanted_task AND c.state IN ('completed','unknown')
 $receipts$;
REVOKE ALL ON FUNCTION public.galaxy_autonomy_workbench_receipts_v1(text,uuid) FROM PUBLIC;
CREATE FUNCTION public.galaxy_autonomy_workbench_pending_v1(wanted_endpoint text,wanted_task uuid)
 RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $pending$
 SELECT EXISTS(SELECT 1 FROM operations_agentos_conversation_cards_v1 c JOIN operations_autonomy_tasks_v1 t ON t.endpoint=c.endpoint
 AND (t.id=c.turn_id OR EXISTS(SELECT 1 FROM operations_autonomy_workbench_runs_v1 r WHERE r.endpoint=t.endpoint AND r.task_id=t.id AND r.turn_operation_id=c.turn_id))
 WHERE t.endpoint=wanted_endpoint AND t.id=wanted_task AND c.state IN ('prepared','unknown'))
 $pending$;
REVOKE ALL ON FUNCTION public.galaxy_autonomy_workbench_pending_v1(text,uuid) FROM PUBLIC;
CREATE FUNCTION public.galaxy_autonomy_lock_persisted_authority_v1(wanted_endpoint text,wanted_task uuid)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $locks$
 DECLARE plan jsonb;
 BEGIN
 SELECT configuration INTO plan FROM operations_autonomy_tasks_v1 WHERE endpoint=wanted_endpoint AND id=wanted_task;
 IF plan IS NULL THEN RETURN false; END IF;
 PERFORM id FROM operations_automation_grants_v1 WHERE endpoint=wanted_endpoint AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(plan->'plan'->'grantIds')) FOR SHARE;
 PERFORM endpoint FROM operations_p13_strategy_heads_v1 WHERE endpoint=wanted_endpoint FOR SHARE;
 RETURN true;
 END $locks$;
REVOKE ALL ON FUNCTION public.galaxy_autonomy_lock_persisted_authority_v1(text,uuid) FROM PUBLIC;
SELECT galaxy_jobs.create_queue('autonomy-task','{"policy":"exclusive","retryLimit":0,"expireInSeconds":660,"heartbeatSeconds":30,"retentionSeconds":604800,"deleteAfterSeconds":604800}'::jsonb);
SELECT galaxy_jobs.create_queue('autonomy-tick','{"policy":"exclusive","retryLimit":3,"retryDelay":30,"expireInSeconds":120,"heartbeatSeconds":30,"retentionSeconds":604800,"deleteAfterSeconds":604800}'::jsonb);
`;
