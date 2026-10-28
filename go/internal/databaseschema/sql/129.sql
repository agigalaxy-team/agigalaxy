
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
 CASE c.proposal->'target'->>'kind'
 WHEN 'post' THEN 'content-post' WHEN 'reply' THEN 'content-reply' WHEN 'section' THEN 'content-section' WHEN 'account' THEN 'account'
 WHEN 'case' THEN 'community-report' WHEN 'public-case' THEN 'community-report' WHEN 'chat-report' THEN 'chat-report'
 WHEN 'chat-file' THEN 'file-chat' WHEN 'forum-file' THEN 'file-forum' WHEN 'message-plan' THEN 'messaging-plan'
 WHEN 'projects' THEN 'project' WHEN 'methods' THEN 'method' WHEN 'rule' THEN 'rule-key'
 WHEN 'file' THEN CASE c.proposal->'request'->>'targetKind' WHEN 'chat' THEN 'file-chat' WHEN 'forum' THEN 'file-forum' END
 WHEN 'search-configuration' THEN 'search-quality' WHEN 'recommendation-theme' THEN 'recommendation-policy'
 WHEN 'public-content-batch' THEN NULL ELSE c.proposal->'target'->>'kind' END,
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


ALTER TABLE operations_business_roles_v1 ADD COLUMN subject_scope text NOT NULL DEFAULT 'shared' CHECK(subject_scope IN ('shared','ai-only'));
ALTER TABLE operations_business_roles_v1 ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE operations_business_roles_v1 ALTER COLUMN updated_by DROP NOT NULL;
ALTER TABLE operations_business_roles_v1 ADD COLUMN created_by_ai_account_id uuid REFERENCES operations_ai_work_accounts_v1(id);
ALTER TABLE operations_business_roles_v1 ADD COLUMN updated_by_ai_account_id uuid REFERENCES operations_ai_work_accounts_v1(id);
ALTER TABLE operations_business_roles_v1 ADD COLUMN managed_ai_account_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE operations_business_roles_v1 ADD CONSTRAINT operations_ai_role_creator_v1 CHECK((created_by IS NOT NULL)<>(created_by_ai_account_id IS NOT NULL));
ALTER TABLE operations_business_roles_v1 ADD CONSTRAINT operations_ai_role_updater_v1 CHECK((updated_by IS NOT NULL)<>(updated_by_ai_account_id IS NOT NULL));
CREATE TABLE operations_ai_role_delegations_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,source_ai_account_id uuid NOT NULL REFERENCES operations_ai_work_accounts_v1(id),
 version integer NOT NULL CHECK(version>0),enabled boolean NOT NULL,target_ai_account_ids uuid[] NOT NULL,
 grantable_permissions text[] NOT NULL CHECK(grantable_permissions<@ARRAY['workbench.read','accounts.read','accounts.identity.read','accounts.type.change','accounts.restriction.apply','accounts.restriction.release','accounts.registered.read','accounts.password.reset','accounts.login.disable','accounts.login.restore','accounts.sessions.revoke','accounts.profile.correct','management.accounts.read','management.accounts.create','management.accounts.profile.write','management.accounts.login.disable','management.accounts.login.restore','management.accounts.password.reset','management.accounts.sessions.revoke','management.accounts.delete','ai.use.overview','ai.use.governance','ai.use.messaging','ai.use.discovery','ai.use.maintenance','ai.accounts.read','ai.accounts.profile.write','ai.accounts.state.write','ai.accounts.roles.write','ai.roles.read','ai.roles.create','ai.roles.update','ai.roles.assign','ai.roles.revoke','ai.delegation.read','ai.delegation.configure','analytics.read','autonomy.read','autonomy.configure','autonomy.control','sections.read','sections.classify','sections.hide','sections.restore','content.read','content.hide','content.restore','content.curate','content.batch.hide','content.batch.restore','content.tags.read','content.tags.manage','recommendations.read','recommendations.configure','cases.read','cases.resolve','chat-reports.read','chat-reports.materials.read','chat-reports.attachments.read','chat-reports.moderate','chat-messages.hide','chat-messages.restore','chat-messages.keep','resources.read','resources.hide','resources.restore','files.read','files.scan.retry','files.access.stop','files.access.restore','files.cleanup.plan','files.cleanup.approve','feedback.read','feedback.attachments.read','feedback.update','notices.read','notices.create','notices.update','notices.publish','notices.withdraw','smtp.read','smtp.configure','smtp.test.connection','smtp.test.delivery','rules.read','rules.write','strategies.read','strategies.configure','strategies.publish','strategies.run','strategies.control','strategies.ordinary.configure','strategies.ordinary.publish','audit.read','jobs.read','jobs.cancel','jobs.retry','search.read','search.retry','search-quality.read','search-quality.configure','search-quality.publish','search-quality.restore','maintenance.read','maintenance.logs.read','maintenance.backups.create','maintenance.backups.verify','maintenance.restore.plan','maintenance.restore.approve','maintenance.restore.execute','system.settings.read','system.settings.configure','system.settings.test','system.settings.apply','system.settings.credentials.write','models.read','models.configure','models.apply','retention.read','retention.request','cms.read','cms.edit','cms.publish','permissions.read','permissions.roles.write','permissions.assignments.write','permissions.automation.write']::text[]),allowed_management_actions text[] NOT NULL CHECK(allowed_management_actions<@ARRAY['read','create','update','assign','revoke']::text[]),
 created_by text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),updated_by text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(endpoint,source_ai_account_id)
);
CREATE TABLE operations_ai_role_delegation_events_v1(
 sequence bigserial PRIMARY KEY,endpoint text NOT NULL,operation_id uuid NOT NULL,delegation_id uuid NOT NULL REFERENCES operations_ai_role_delegations_v1(id),
 version integer NOT NULL,actor_kind text NOT NULL CHECK(actor_kind IN ('business-operator','operations-ai-service')),actor_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('config-save','role-create','role-update','assignment-save')),selection jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL,UNIQUE(endpoint,operation_id)
);
CREATE INDEX operations_ai_role_delegation_events_history_v1 ON operations_ai_role_delegation_events_v1(endpoint,delegation_id,sequence DESC);
CREATE TABLE operations_ai_duty_operations_v1(
 operation_id uuid NOT NULL,endpoint text NOT NULL,task_id uuid NOT NULL,ai_account_id uuid NOT NULL REFERENCES operations_ai_work_accounts_v1(id),
 kind text NOT NULL,request jsonb NOT NULL,proposal jsonb NOT NULL,binding jsonb NOT NULL,state text NOT NULL CHECK(state IN ('prepared','dispatching','completed','failed','unknown')),
 result jsonb,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,PRIMARY KEY(endpoint,operation_id)
);
ALTER TABLE forum_section_events_v2 DROP CONSTRAINT forum_section_events_v2_actor_kind_check;
ALTER TABLE forum_section_events_v2 ADD CONSTRAINT forum_section_events_v2_actor_kind_check CHECK(actor_kind IN ('identity','official-account','business-operator','operations-ai-service'));
ALTER TABLE forum_operations_events_v1 ADD COLUMN actor_kind text NOT NULL DEFAULT 'business-operator' CHECK(actor_kind IN ('business-operator','operations-ai-service'));
DO $ai_case_actor$ DECLARE item record; BEGIN
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='account_chat_governance_events_v1'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%actor_kind%' LOOP
  EXECUTE format('ALTER TABLE account_chat_governance_events_v1 DROP CONSTRAINT %I',item.conname);
 END LOOP;
END $ai_case_actor$;
ALTER TABLE account_chat_governance_events_v1 ADD CONSTRAINT account_chat_event_actor_kind_v2 CHECK(actor_kind IN ('official-account','business-operator','operations-ai-service'));
ALTER TABLE account_chat_governance_events_v1 ADD CONSTRAINT account_chat_event_actor_identity_v2 CHECK(
 (actor_kind='official-account' AND account_id IS NOT NULL AND operator_id IS NULL) OR
 (actor_kind IN ('business-operator','operations-ai-service') AND account_id IS NULL AND operator_id IS NOT NULL));
ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_actor_kind_check;
ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_actor_kind_check CHECK(actor_kind IN ('business-operator','operations-executor','operations-ai-service'));
ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_executor_source_v1;
ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_executor_source_v1 CHECK(
 (actor_kind='business-operator' AND operator_role IS NOT NULL AND operator_role IN ('reader','administrator') AND execution_id IS NULL AND grant_id IS NULL) OR
 (actor_kind='operations-executor' AND operator_role IS NULL AND execution_id IS NOT NULL AND grant_id IS NOT NULL) OR
 (actor_kind='operations-ai-service' AND operator_role IS NULL AND execution_id IS NULL AND operator_id LIKE 'ai:%')
);
ALTER TABLE operations_business_roles_v1 DROP CONSTRAINT operations_business_roles_v1_permissions_check;
ALTER TABLE operations_business_roles_v1 ADD CONSTRAINT operations_business_roles_v1_permissions_check CHECK(permissions<@ARRAY['workbench.read','accounts.read','accounts.identity.read','accounts.type.change','accounts.restriction.apply','accounts.restriction.release','accounts.registered.read','accounts.password.reset','accounts.login.disable','accounts.login.restore','accounts.sessions.revoke','accounts.profile.correct','management.accounts.read','management.accounts.create','management.accounts.profile.write','management.accounts.login.disable','management.accounts.login.restore','management.accounts.password.reset','management.accounts.sessions.revoke','management.accounts.delete','ai.use.overview','ai.use.governance','ai.use.messaging','ai.use.discovery','ai.use.maintenance','ai.accounts.read','ai.accounts.profile.write','ai.accounts.state.write','ai.accounts.roles.write','ai.roles.read','ai.roles.create','ai.roles.update','ai.roles.assign','ai.roles.revoke','ai.delegation.read','ai.delegation.configure','analytics.read','autonomy.read','autonomy.configure','autonomy.control','sections.read','sections.classify','sections.hide','sections.restore','content.read','content.hide','content.restore','content.curate','content.batch.hide','content.batch.restore','content.tags.read','content.tags.manage','recommendations.read','recommendations.configure','cases.read','cases.resolve','chat-reports.read','chat-reports.materials.read','chat-reports.attachments.read','chat-reports.moderate','chat-messages.hide','chat-messages.restore','chat-messages.keep','resources.read','resources.hide','resources.restore','files.read','files.scan.retry','files.access.stop','files.access.restore','files.cleanup.plan','files.cleanup.approve','feedback.read','feedback.attachments.read','feedback.update','notices.read','notices.create','notices.update','notices.publish','notices.withdraw','smtp.read','smtp.configure','smtp.test.connection','smtp.test.delivery','rules.read','rules.write','strategies.read','strategies.configure','strategies.publish','strategies.run','strategies.control','strategies.ordinary.configure','strategies.ordinary.publish','audit.read','jobs.read','jobs.cancel','jobs.retry','search.read','search.retry','search-quality.read','search-quality.configure','search-quality.publish','search-quality.restore','maintenance.read','maintenance.logs.read','maintenance.backups.create','maintenance.backups.verify','maintenance.restore.plan','maintenance.restore.approve','maintenance.restore.execute','system.settings.read','system.settings.configure','system.settings.test','system.settings.apply','system.settings.credentials.write','models.read','models.configure','models.apply','retention.read','retention.request','cms.read','cms.edit','cms.publish','permissions.read','permissions.roles.write','permissions.assignments.write','permissions.automation.write']::text[]);
ALTER TABLE operations_automation_grants_v1 DROP CONSTRAINT operations_automation_grants_v1_permissions_check;
ALTER TABLE operations_automation_grants_v1 ADD CONSTRAINT operations_automation_grants_v1_permissions_check CHECK(permissions<@ARRAY['workbench.read','accounts.read','accounts.identity.read','accounts.type.change','accounts.restriction.apply','accounts.restriction.release','accounts.registered.read','accounts.password.reset','accounts.login.disable','accounts.login.restore','accounts.sessions.revoke','accounts.profile.correct','management.accounts.read','management.accounts.create','management.accounts.profile.write','management.accounts.login.disable','management.accounts.login.restore','management.accounts.password.reset','management.accounts.sessions.revoke','management.accounts.delete','ai.use.overview','ai.use.governance','ai.use.messaging','ai.use.discovery','ai.use.maintenance','ai.accounts.read','ai.accounts.profile.write','ai.accounts.state.write','ai.accounts.roles.write','ai.roles.read','ai.roles.create','ai.roles.update','ai.roles.assign','ai.roles.revoke','ai.delegation.read','ai.delegation.configure','analytics.read','autonomy.read','autonomy.configure','autonomy.control','sections.read','sections.classify','sections.hide','sections.restore','content.read','content.hide','content.restore','content.curate','content.batch.hide','content.batch.restore','content.tags.read','content.tags.manage','recommendations.read','recommendations.configure','cases.read','cases.resolve','chat-reports.read','chat-reports.materials.read','chat-reports.attachments.read','chat-reports.moderate','chat-messages.hide','chat-messages.restore','chat-messages.keep','resources.read','resources.hide','resources.restore','files.read','files.scan.retry','files.access.stop','files.access.restore','files.cleanup.plan','files.cleanup.approve','feedback.read','feedback.attachments.read','feedback.update','notices.read','notices.create','notices.update','notices.publish','notices.withdraw','smtp.read','smtp.configure','smtp.test.connection','smtp.test.delivery','rules.read','rules.write','strategies.read','strategies.configure','strategies.publish','strategies.run','strategies.control','strategies.ordinary.configure','strategies.ordinary.publish','audit.read','jobs.read','jobs.cancel','jobs.retry','search.read','search.retry','search-quality.read','search-quality.configure','search-quality.publish','search-quality.restore','maintenance.read','maintenance.logs.read','maintenance.backups.create','maintenance.backups.verify','maintenance.restore.plan','maintenance.restore.approve','maintenance.restore.execute','system.settings.read','system.settings.configure','system.settings.test','system.settings.apply','system.settings.credentials.write','models.read','models.configure','models.apply','retention.read','retention.request','cms.read','cms.edit','cms.publish','permissions.read','permissions.roles.write','permissions.assignments.write','permissions.automation.write']::text[]);


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


CREATE FUNCTION public.galaxy_autonomy_business_event_v1() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $event$
DECLARE data jsonb; target_endpoint text; event_domain text; event_type text; target_kind text; target_id text; version_key text; v_event_key text;
BEGIN
 data=to_jsonb(NEW);target_endpoint=data->>'endpoint';event_domain=TG_ARGV[0];event_type=TG_ARGV[1];target_kind=NULLIF(TG_ARGV[2],'');target_id=data->>'id';
 IF TG_TABLE_NAME='forum_reports_v1' THEN SELECT endpoint INTO target_endpoint FROM community_accounts WHERE id=NEW.account_id;END IF;
 IF TG_TABLE_NAME='business_admin_audit_v1' THEN
  IF NEW.operation_id IS NULL OR NEW.action LIKE 'autonomy-%' OR NEW.action LIKE 'permission-%' OR NEW.action LIKE 'ai-work-%' THEN RETURN NEW;END IF;
  event_domain=CASE WHEN NEW.action LIKE 'messaging-%' OR NEW.action LIKE 'notice-%' THEN 'messaging' WHEN NEW.action LIKE 'search-%' OR NEW.action LIKE 'recommendation%' THEN 'discovery' WHEN NEW.action LIKE 'file-%' OR NEW.action LIKE 'maintenance-%' THEN 'maintenance' ELSE 'governance' END;
  target_id=NULL;target_kind=NULL;
 END IF;
 IF target_endpoint IS NULL THEN RETURN NEW;END IF;
 version_key=COALESCE(data->>'version',data->>'revision',data->>'sequence','1');
 v_event_key=TG_TABLE_NAME||':'||(data->>'id')||':'||version_key||':'||COALESCE(data->>'state','changed');
 INSERT INTO operations_autonomy_events_v1(id,endpoint,domain,event_key,event_type,target_type,target_id,source_version,created_at,available_at)
 VALUES(gen_random_uuid(),target_endpoint,event_domain,v_event_key,event_type,target_kind,target_id,version_key,clock_timestamp(),clock_timestamp()+interval '1 second'*COALESCE((SELECT (configuration->>'eventCoalesceSeconds')::int FROM operations_autonomy_runtime_v1 WHERE endpoint=target_endpoint),30))
 ON CONFLICT(endpoint,event_key) DO NOTHING;
 RETURN NEW;
END $event$;
REVOKE ALL ON FUNCTION public.galaxy_autonomy_business_event_v1() FROM PUBLIC;
CREATE TRIGGER galaxy_autonomy_feedback_v1 AFTER INSERT OR UPDATE OF revision,state ON operations_feedback_v1 FOR EACH ROW EXECUTE FUNCTION public.galaxy_autonomy_business_event_v1('governance','feedback.changed','feedback');
CREATE TRIGGER galaxy_autonomy_chat_report_v1 AFTER INSERT OR UPDATE OF version,state ON account_chat_reports_v1 FOR EACH ROW EXECUTE FUNCTION public.galaxy_autonomy_business_event_v1('governance','chat-report.changed','chat-report');
CREATE TRIGGER galaxy_autonomy_forum_report_v1 AFTER INSERT OR UPDATE OF version,state ON forum_reports_v1 FOR EACH ROW EXECUTE FUNCTION public.galaxy_autonomy_business_event_v1('governance','community-report.changed','community-report');
CREATE TRIGGER galaxy_autonomy_business_audit_v1 AFTER INSERT ON business_admin_audit_v1 FOR EACH ROW EXECUTE FUNCTION public.galaxy_autonomy_business_event_v1('governance','operations.changed','');


DO $autonomy_audit$
DECLARE previous text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO previous FROM pg_constraint WHERE conrelid='business_admin_audit_v1'::regclass AND conname='business_admin_audit_v1_action_check';
 IF previous IS NULL OR previous NOT LIKE 'CHECK (%' THEN RAISE EXCEPTION 'autonomy_audit_constraint_missing'; END IF;
 ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
 EXECUTE 'ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check '||
 'CHECK (('||substring(previous from 8 for length(previous)-8)||') OR action IN (''autonomy-config'',''autonomy-enable'',''autonomy-control'',''autonomy-run'',''autonomy-settings'',''autonomy-strategy-task'',''autonomy-decision'',''ai-delegation-save'',''ai-role-create'',''ai-role-update'',''ai-role-assignment-save''))';
END $autonomy_audit$;
