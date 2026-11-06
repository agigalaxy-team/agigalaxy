-- Community growth, explicit public follows and monotonic recommendation feedback.
CREATE TABLE forum_reactions_v1 (
 account_id uuid NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('post','reply')), object_id uuid NOT NULL,
 liked boolean NOT NULL, revision bigint NOT NULL CHECK(revision>0), updated_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,kind,object_id)
);
CREATE INDEX forum_reactions_object_v1 ON forum_reactions_v1(kind,object_id) WHERE liked;
CREATE TABLE forum_reaction_operations_v1 (
 account_id uuid NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE, operation_id uuid NOT NULL,
 request_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,operation_id)
);
ALTER TABLE account_follows_v1 ADD COLUMN visibility text NOT NULL DEFAULT 'private' CHECK(visibility IN ('public','private'));
CREATE INDEX account_follows_public_owner_v1 ON account_follows_v1(account_id,followed_at DESC,id DESC) WHERE following AND visibility='public';
CREATE INDEX account_follows_public_target_v1 ON account_follows_v1(target_account_id,followed_at DESC,id DESC) WHERE following AND visibility='public';
CREATE TABLE discovery_feedback_state_v1 (
 endpoint text NOT NULL, profile_id text NOT NULL, item_key text NOT NULL, feedback_type text NOT NULL,
 desired_active boolean NOT NULL, revision bigint NOT NULL CHECK(revision>=1),
 applied_revision bigint NOT NULL DEFAULT 0 CHECK(applied_revision>=0 AND applied_revision<=revision),
 delivery_generation bigint NOT NULL DEFAULT 1 CHECK(delivery_generation>=1),
 applied_generation bigint NOT NULL DEFAULT 0 CHECK(applied_generation>=0 AND applied_generation<=delivery_generation),
 occurred_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text, updated_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,profile_id,item_key,feedback_type)
);
CREATE INDEX discovery_feedback_state_ready_v1 ON discovery_feedback_state_v1(endpoint,next_attempt_at,updated_at) WHERE delivery_generation>applied_generation;
CREATE INDEX discovery_feedback_state_item_v1 ON discovery_feedback_state_v1(endpoint,item_key);

CREATE TABLE community_growth_initialized_v1 (endpoint text PRIMARY KEY, levels_version bigint NOT NULL DEFAULT 1);
CREATE TABLE community_growth_rules_v1 (
 endpoint text NOT NULL, rule_key text NOT NULL, source_kind text NOT NULL, label text NOT NULL,
 experience bigint NOT NULL CHECK(experience>=0), enabled boolean NOT NULL, version bigint NOT NULL,
 updated_at timestamptz NOT NULL, PRIMARY KEY(endpoint,rule_key)
);
CREATE TABLE community_growth_rule_history_v1 (
 endpoint text NOT NULL, rule_key text NOT NULL, version bigint NOT NULL, snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL, PRIMARY KEY(endpoint,rule_key,version)
);
CREATE TABLE community_growth_levels_history_v1 (
 endpoint text NOT NULL, version bigint NOT NULL, snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL, PRIMARY KEY(endpoint,version)
);
CREATE TABLE community_growth_levels_v1 (
 endpoint text NOT NULL, level integer NOT NULL CHECK(level>0), minimum bigint NOT NULL CHECK(minimum>=0),
 label text NOT NULL, PRIMARY KEY(endpoint,level), UNIQUE(endpoint,minimum)
);
CREATE TABLE community_growth_sources_v1 (
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 endpoint text NOT NULL, source_kind text NOT NULL, source_id text NOT NULL, rule_key text NOT NULL,
 account_id uuid NOT NULL REFERENCES community_accounts(id), domains text[] NOT NULL DEFAULT '{}', title text NOT NULL DEFAULT '', object_kind text NOT NULL DEFAULT '', object_id text NOT NULL DEFAULT '', active boolean NOT NULL,
 revision bigint NOT NULL CHECK(revision>0), occurred_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,source_kind,source_id,rule_key,account_id), UNIQUE(endpoint,id)
);
CREATE INDEX community_growth_sources_account ON community_growth_sources_v1(endpoint,account_id,occurred_at DESC,source_id);
CREATE TABLE community_growth_definitions_v1 (
 endpoint text NOT NULL, id uuid NOT NULL, name text NOT NULL, description text NOT NULL, enabled boolean NOT NULL,
 version bigint NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY(endpoint,id)
);
CREATE TABLE community_growth_recognitions_v1 (
 endpoint text NOT NULL, id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('content','honor','activity')),
 account_id uuid NOT NULL REFERENCES community_accounts(id), definition_id uuid, object_kind text NOT NULL, object_id text NOT NULL,
 domain text NOT NULL, reason text NOT NULL, active boolean NOT NULL, revision bigint NOT NULL,
 issued_by text NOT NULL, updated_by text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,id), FOREIGN KEY(endpoint,definition_id) REFERENCES community_growth_definitions_v1(endpoint,id)
);
CREATE INDEX community_growth_recognitions_account ON community_growth_recognitions_v1(endpoint,account_id,created_at DESC);
CREATE TABLE community_growth_operations_v1 (
 endpoint text NOT NULL, operation_id uuid NOT NULL, actor_id text NOT NULL, kind text NOT NULL,
 request_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,operation_id)
);
CREATE TABLE community_growth_recognition_history_v1 (
 endpoint text NOT NULL, recognition_id uuid NOT NULL, revision bigint NOT NULL, snapshot jsonb NOT NULL,
 operator_id text NOT NULL, created_at timestamptz NOT NULL, PRIMARY KEY(endpoint,recognition_id,revision)
);

CREATE TABLE community_assessment_config_v1 (
 endpoint text PRIMARY KEY, version bigint NOT NULL CHECK(version>0), enabled boolean NOT NULL DEFAULT false,
 instructions text NOT NULL DEFAULT '', instructions_by_purpose jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(instructions_by_purpose)='object'), executor_config_id uuid, purposes text[] NOT NULL DEFAULT '{contribution-impact,evaluation-reference}',
 updated_by text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL
);
CREATE TABLE community_assessment_config_history_v1 (
 endpoint text NOT NULL, version bigint NOT NULL, snapshot jsonb NOT NULL, updated_by text NOT NULL,
 created_at timestamptz NOT NULL, PRIMARY KEY(endpoint,version)
);
CREATE TABLE community_assessment_source_revisions_v1 (
 endpoint text NOT NULL, account_id uuid NOT NULL REFERENCES community_accounts(id),
 source_kind text NOT NULL, source_id text NOT NULL, rule_key text NOT NULL, revision bigint NOT NULL,
 domains text[] NOT NULL, PRIMARY KEY(endpoint,account_id,source_kind,source_id,rule_key)
);
CREATE TABLE community_assessment_scopes_v1 (
 endpoint text NOT NULL, account_id uuid NOT NULL REFERENCES community_accounts(id), domain text NOT NULL,
 purpose text NOT NULL, input_revision bigint NOT NULL DEFAULT 1, applied_revision bigint NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','applied','failed')),
 task_id uuid, current_result_id uuid, next_attempt_at timestamptz NOT NULL,
 last_error text, updated_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,account_id,domain,purpose)
);
CREATE INDEX community_assessment_pending ON community_assessment_scopes_v1(endpoint,next_attempt_at,updated_at) WHERE state IN ('pending','failed');
CREATE TABLE community_assessment_tasks_v1 (
 endpoint text NOT NULL, id uuid NOT NULL, account_id uuid NOT NULL, domain text NOT NULL, purpose text NOT NULL,
 input_revision bigint NOT NULL, config_version bigint NOT NULL, configuration jsonb NOT NULL,
 native_task_id uuid, state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','saved','superseded','failed')),
 result_hash text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,id), UNIQUE(endpoint,account_id,domain,purpose,input_revision,config_version)
);
CREATE TABLE community_assessment_materials_v1 (
 endpoint text NOT NULL, task_id uuid NOT NULL, source_key text NOT NULL, source_kind text NOT NULL,
 source_id text NOT NULL, source_revision bigint NOT NULL, snapshot jsonb NOT NULL,
 read_version text, read_at timestamptz, PRIMARY KEY(endpoint,task_id,source_key),
 FOREIGN KEY(endpoint,task_id) REFERENCES community_assessment_tasks_v1(endpoint,id)
);
CREATE TABLE community_assessment_results_v1 (
 endpoint text NOT NULL, id uuid NOT NULL, task_id uuid NOT NULL, account_id uuid NOT NULL,
 domain text NOT NULL, purpose text NOT NULL, input_revision bigint NOT NULL, config_version bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('assessed','insufficient-material')), value double precision,
 coverage text NOT NULL, reason text NOT NULL, evidence jsonb NOT NULL, missing jsonb NOT NULL,
 model_version text NOT NULL, prompt_version text NOT NULL, adopted boolean NOT NULL,
 created_at timestamptz NOT NULL, PRIMARY KEY(endpoint,id), UNIQUE(endpoint,task_id),
 CHECK((status='assessed' AND value IS NOT NULL AND value>=0 AND value<=1) OR (status='insufficient-material' AND value IS NULL))
);

CREATE TABLE community_growth_reconcile_state_v1 (
 endpoint text PRIMARY KEY, phase text NOT NULL DEFAULT 'content', cursor text NOT NULL DEFAULT '',
 completed_at timestamptz, updated_at timestamptz NOT NULL
);
CREATE TABLE community_growth_dirty_objects_v1 (
 endpoint text NOT NULL, kind text NOT NULL CHECK(kind IN ('post','reply')), object_id uuid NOT NULL,
 generation bigint NOT NULL DEFAULT 1, cursor text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,kind,object_id)
);
CREATE INDEX community_growth_dirty_ready_v1 ON community_growth_dirty_objects_v1(endpoint,updated_at,kind,object_id);

ALTER TABLE operations_recommendation_policy_v1 ADD COLUMN community_signals jsonb NOT NULL DEFAULT '{"enabled":false,"matchWeight":1,"recognitionWeight":0.1,"authorWeight":0.1,"smoothing":20}'::jsonb;
-- Specialized public event hints contain only current-read locators, never
-- reaction owners, follow counterparts, source_id, weights, or source values.
CREATE FUNCTION galaxy_web_growth_hint_v1() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r jsonb; prior jsonb; current_row jsonb; ep text; module_name text; account text;
BEGIN
 IF TG_OP<>'INSERT' THEN prior=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN current_row=to_jsonb(NEW); END IF;
 r=COALESCE(current_row,prior);
 IF TG_OP='UPDATE' AND prior=r THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='forum_reactions_v1' THEN
  SELECT endpoint INTO ep FROM public.community_accounts WHERE id::text=r->>'account_id';
  INSERT INTO public.web_event_outbox_v1(module,source_table,source_ref,endpoint)
  VALUES('reactions',TG_TABLE_NAME,jsonb_build_object('object_id',r->>'object_id','object_kind',r->>'kind','_operation','UPDATE'),ep);
 ELSIF TG_TABLE_NAME IN ('official_account_profiles_v1','community_account_links','external_identity_links') THEN
  IF TG_TABLE_NAME='official_account_profiles_v1' AND TG_OP='UPDATE' AND
    prior->'query_enabled' IS NOT DISTINCT FROM current_row->'query_enabled' AND prior->'query_scope' IS NOT DISTINCT FROM current_row->'query_scope' AND
    prior->'query_linked_ids' IS NOT DISTINCT FROM current_row->'query_linked_ids' AND prior->'query_external_credentials' IS NOT DISTINCT FROM current_row->'query_external_credentials' THEN RETURN NULL; END IF;
  ep:=r->>'endpoint';
  IF ep IS NULL THEN SELECT endpoint INTO ep FROM public.community_accounts WHERE id::text=r->>'account_id'; END IF;
  FOREACH module_name IN ARRAY ARRAY['growth','public-follows'] LOOP
   INSERT INTO public.web_event_outbox_v1(module,source_table,source_ref,endpoint)
   VALUES(module_name,TG_TABLE_NAME,jsonb_build_object('_scope_reset',true,'_operation','UPDATE'),ep);
  END LOOP;
 ELSIF TG_TABLE_NAME='account_follows_v1' THEN
  IF TG_OP='UPDATE' AND prior->'following'=current_row->'following' AND prior->'visibility'=current_row->'visibility' THEN RETURN NULL; END IF;
  IF (COALESCE((prior->>'following')::boolean,false) AND prior->>'visibility'='public') OR (COALESCE((current_row->>'following')::boolean,false) AND current_row->>'visibility'='public') THEN
   SELECT endpoint INTO ep FROM public.community_accounts WHERE id::text=r->>'account_id';
   FOREACH account IN ARRAY ARRAY[r->>'account_id',r->>'target_account_id'] LOOP
    INSERT INTO public.web_event_outbox_v1(module,source_table,source_ref,endpoint)
    VALUES('public-follows',TG_TABLE_NAME,jsonb_build_object('account_id',account,'_operation','UPDATE'),ep);
   END LOOP;
  END IF;
 ELSIF TG_TABLE_NAME IN ('community_growth_rules_v1','community_growth_levels_v1','community_growth_definitions_v1') THEN
  INSERT INTO public.web_event_outbox_v1(module,source_table,source_ref,endpoint)
  VALUES('growth',TG_TABLE_NAME,jsonb_build_object('_operation','UPDATE'),r->>'endpoint');
 ELSE
  INSERT INTO public.web_event_outbox_v1(module,source_table,source_ref,endpoint)
  VALUES('growth',TG_TABLE_NAME,jsonb_build_object('account_id',r->>'account_id','object_kind',r->>'object_kind','object_id',r->>'object_id','_inactive',TG_OP='DELETE' OR COALESCE((r->>'active')::boolean,false)=false,'_operation','UPDATE'),r->>'endpoint');
  IF TG_OP='UPDATE' AND prior->'account_id' IS DISTINCT FROM current_row->'account_id' THEN
   INSERT INTO public.web_event_outbox_v1(module,source_table,source_ref,endpoint)
   VALUES('growth',TG_TABLE_NAME,jsonb_build_object('_inactive',true,'_operation','UPDATE'),prior->>'endpoint');
  END IF;
 END IF;
 PERFORM pg_notify('galaxy_web_event_pending_v1','');
 RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION galaxy_web_growth_hint_v1() FROM PUBLIC;
CREATE TRIGGER web_growth_hint_v1 AFTER INSERT OR UPDATE OR DELETE ON forum_reactions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_growth_hint_v1();
CREATE TRIGGER web_growth_hint_v1 AFTER INSERT OR UPDATE OR DELETE ON official_account_profiles_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_growth_hint_v1();
CREATE TRIGGER web_growth_hint_v1 AFTER INSERT OR UPDATE OR DELETE ON community_account_links FOR EACH ROW EXECUTE FUNCTION galaxy_web_growth_hint_v1();
CREATE TRIGGER web_growth_hint_v1 AFTER INSERT OR UPDATE OR DELETE ON external_identity_links FOR EACH ROW EXECUTE FUNCTION galaxy_web_growth_hint_v1();
CREATE TRIGGER web_growth_hint_v1 AFTER INSERT OR UPDATE OR DELETE ON account_follows_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_growth_hint_v1();
CREATE TRIGGER web_growth_hint_v1 AFTER INSERT OR UPDATE OR DELETE ON community_growth_sources_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_growth_hint_v1();
CREATE TRIGGER web_growth_hint_v1 AFTER INSERT OR UPDATE OR DELETE ON community_growth_recognitions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_growth_hint_v1();
CREATE TRIGGER web_growth_hint_v1 AFTER INSERT OR UPDATE OR DELETE ON community_growth_rules_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_growth_hint_v1();
CREATE TRIGGER web_growth_hint_v1 AFTER INSERT OR UPDATE OR DELETE ON community_growth_levels_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_growth_hint_v1();
CREATE TRIGGER web_growth_hint_v1 AFTER INSERT OR UPDATE OR DELETE ON community_growth_definitions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_growth_hint_v1();
CREATE TRIGGER web_growth_admin_v1 AFTER INSERT OR UPDATE OR DELETE ON community_growth_rules_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('rules');
CREATE TRIGGER web_growth_admin_v1 AFTER INSERT OR UPDATE OR DELETE ON community_growth_levels_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('rules');
CREATE TRIGGER web_growth_admin_v1 AFTER INSERT OR UPDATE OR DELETE ON community_growth_definitions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('community');
CREATE TRIGGER web_growth_admin_v1 AFTER INSERT OR UPDATE OR DELETE ON community_growth_recognitions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('community');
CREATE TRIGGER web_growth_admin_v1 AFTER INSERT OR UPDATE OR DELETE ON community_assessment_config_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('rules');
CREATE TRIGGER web_growth_admin_v1 AFTER INSERT OR UPDATE OR DELETE ON community_assessment_scopes_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('community');
CREATE TRIGGER web_growth_admin_v1 AFTER INSERT OR UPDATE OR DELETE ON community_assessment_results_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('community');

-- Assessment executor adoption
CREATE FUNCTION galaxy_community_assessment_model_material_v1(configuration jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $assessment_model_material$
 WITH RECURSIVE selected(id) AS (
  SELECT configuration#>>'{scenarios,discovery,modelId}'
  UNION
  SELECT fallback->>'modelId'
  FROM selected s
  JOIN LATERAL jsonb_array_elements(COALESCE(configuration->'models','[]'::jsonb)) model ON model->>'id'=s.id
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(model->'fallbacks','[]'::jsonb)) fallback
 )
 SELECT jsonb_build_object('binding',configuration#>'{scenarios,discovery}',
  'models',COALESCE((SELECT jsonb_agg(model-'displayName' ORDER BY model->>'id')
   FROM jsonb_array_elements(COALESCE(configuration->'models','[]'::jsonb)) model
   WHERE model->>'id' IN (SELECT id FROM selected)),'[]'::jsonb))
$assessment_model_material$;
REVOKE ALL ON FUNCTION galaxy_community_assessment_model_material_v1(jsonb) FROM PUBLIC;

CREATE FUNCTION galaxy_community_assessment_executor_changed_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $assessment_executor_changed$
DECLARE
 old_configuration jsonb;
 new_configuration jsonb;
 affected_executor uuid;
BEGIN
 IF TG_ARGV[0]='prompt' THEN
  IF NEW.domain<>'discovery' OR OLD.prompt_version IS NOT DISTINCT FROM NEW.prompt_version THEN RETURN NEW; END IF;
  affected_executor:=NEW.id;
 ELSE
  IF OLD.active_id IS NOT DISTINCT FROM NEW.active_id THEN RETURN NEW; END IF;
  -- active_id is advanced only after the retained model-settings apply
  -- operation verifies native completion and matching engine readback.
  SELECT configuration INTO old_configuration FROM public.operations_model_settings_versions_v1 WHERE endpoint=NEW.endpoint AND id=OLD.active_id;
  SELECT configuration INTO new_configuration FROM public.operations_model_settings_versions_v1 WHERE endpoint=NEW.endpoint AND id=NEW.active_id;
  IF public.galaxy_community_assessment_model_material_v1(old_configuration)
   IS NOT DISTINCT FROM public.galaxy_community_assessment_model_material_v1(new_configuration) THEN RETURN NEW; END IF;
  SELECT id INTO affected_executor FROM public.operations_autonomy_configs_v1 WHERE endpoint=NEW.endpoint AND domain='discovery';
 END IF;
 IF affected_executor IS NOT NULL THEN
  UPDATE public.community_assessment_scopes_v1 x
   SET input_revision=x.input_revision+1,state='pending',task_id=NULL,current_result_id=NULL,
       last_error=NULL,next_attempt_at=statement_timestamp(),updated_at=statement_timestamp()
   FROM public.community_assessment_config_v1 c
   WHERE c.endpoint=NEW.endpoint AND c.executor_config_id=affected_executor AND x.endpoint=c.endpoint;
 END IF;
 RETURN NEW;
END
$assessment_executor_changed$;
REVOKE ALL ON FUNCTION galaxy_community_assessment_executor_changed_v1() FROM PUBLIC;
-- Trigger execution keeps the caller's existing authority; no SECURITY DEFINER
-- or model/prompt write privilege is granted by these derived-state updates.
CREATE TRIGGER community_assessment_prompt_changed_v1 AFTER UPDATE OF prompt_version
 ON operations_autonomy_configs_v1 FOR EACH ROW
 WHEN (OLD.prompt_version IS DISTINCT FROM NEW.prompt_version)
 EXECUTE FUNCTION galaxy_community_assessment_executor_changed_v1('prompt');
CREATE TRIGGER community_assessment_model_adopted_v1 AFTER UPDATE OF active_id
 ON operations_model_settings_state_v1 FOR EACH ROW
 WHEN (OLD.active_id IS DISTINCT FROM NEW.active_id)
 EXECUTE FUNCTION galaxy_community_assessment_executor_changed_v1('model');

-- Transport only metadata for growth summaries. All source qualification stays
-- in the common forum reader; malformed source JSON is unavailable there.
CREATE FUNCTION galaxy_forum_public_payload_summary_v1(raw text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $forum_payload_summary$
DECLARE payload jsonb;
BEGIN
 BEGIN payload:=raw::jsonb;
 EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
 END;
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('title',payload->'title','topic',payload->'topic')::text;
END
$forum_payload_summary$;
REVOKE ALL ON FUNCTION galaxy_forum_public_payload_summary_v1(text) FROM PUBLIC;

-- Re-evaluate each affected item's existing desired feedback whenever the
-- original discovery source index generation changes, including expiry.
CREATE FUNCTION galaxy_discovery_feedback_source_changed_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.generation IS NOT DISTINCT FROM NEW.generation THEN RETURN NULL; END IF;
 UPDATE public.discovery_feedback_state_v1
 SET delivery_generation=delivery_generation+1,attempts=0,next_attempt_at=now(),last_error=NULL,updated_at=now()
 WHERE endpoint=NEW.endpoint AND item_key=NEW.kind||'_'||NEW.source_id::text;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION galaxy_discovery_feedback_source_changed_v1() FROM PUBLIC;
CREATE TRIGGER discovery_feedback_source_changed_v1
 AFTER INSERT OR UPDATE OF generation ON discovery_index_outbox_v1
 FOR EACH ROW EXECUTE FUNCTION galaxy_discovery_feedback_source_changed_v1();

-- Register the community management commands in the existing audit vocabulary.
DO $community_growth_audit$
DECLARE previous text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO previous FROM pg_constraint WHERE conrelid='business_admin_audit_v1'::regclass AND conname='business_admin_audit_v1_action_check';
 IF previous IS NULL OR previous NOT LIKE 'CHECK (%' THEN RAISE EXCEPTION 'community_growth_audit_constraint_missing'; END IF;
 ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
 EXECUTE 'ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check '||
 'CHECK (('||substring(previous from 8 for length(previous)-8)||') OR action IN (''community-growth.rule-save'',''community-growth.levels-save'',''community-growth.definition-save'',''community-growth.recognition-save''))';
END $community_growth_audit$;

-- Merge with the owning schema migration. These functions only project
-- derived copies of a precisely marked community assessment; they never
-- change an original task/call/command state, failure, operation or usage.

CREATE FUNCTION galaxy_community_assessment_arguments_minimized_v1(
 source_endpoint text, source_task uuid, source_tool text, source_arguments jsonb
) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $assessment_arguments_minimized$
 SELECT COALESCE((SELECT CASE source_tool
  WHEN 'read-community-assessment-material' THEN jsonb_strip_nulls(jsonb_build_object(
   'after',CASE WHEN jsonb_typeof(source_arguments->'after')='string' THEN source_arguments->'after' END,
   'limit',CASE WHEN jsonb_typeof(source_arguments->'limit')='number' THEN source_arguments->'limit' END))
  WHEN 'save-community-assessment-result' THEN jsonb_build_object(
   'accountId',a.account_id,'domain',a.domain,'purpose',a.purpose,
   'inputRevision',a.input_revision,'configVersion',a.config_version,
   'status',CASE WHEN source_arguments->>'status' IN ('assessed','insufficient-material') THEN source_arguments->'status' ELSE 'null'::jsonb END,
   'value',CASE WHEN jsonb_typeof(source_arguments->'value')='number' THEN source_arguments->'value' ELSE 'null'::jsonb END,
   'coverage',CASE WHEN source_arguments->>'coverage' IN ('none','partial','broad') THEN source_arguments->'coverage' ELSE 'null'::jsonb END,
   'reason','','missing','[]'::jsonb,'evidence','[]'::jsonb)
  WHEN 'assess-task' THEN jsonb_build_object(
   'scope','execution','goalSatisfied',CASE WHEN jsonb_typeof(source_arguments->'goalSatisfied')='boolean' THEN source_arguments->'goalSatisfied' ELSE 'null'::jsonb END,
   'summary','','remainingWork','[]'::jsonb,'deferredWork','[]'::jsonb)
  ELSE COALESCE(source_arguments,'{}'::jsonb) END
  FROM public.community_assessment_tasks_v1 a WHERE a.endpoint=source_endpoint AND a.id=source_task),
  COALESCE(source_arguments,'{}'::jsonb))
$assessment_arguments_minimized$;

CREATE FUNCTION galaxy_community_assessment_analysis_minimized_v1(
 source_result jsonb, source_run text, source_attempt uuid
) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $assessment_analysis_minimized$
 SELECT jsonb_set(CASE WHEN jsonb_typeof(source_result)='object' THEN source_result ELSE '{}'::jsonb END,
  '{analysis}',jsonb_build_object('state','withheld','basis','community-source-minimized',
    'nativeRunId',source_run,'nativeAttemptId',source_attempt,'reason','source-unavailable'),true)
$assessment_analysis_minimized$;

CREATE FUNCTION galaxy_community_assessment_view_minimized_v1(source_view jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $assessment_view_minimized$
 SELECT (COALESCE(source_view,'{}'::jsonb)-'summary'-'assessmentSummary'-'finalAnalysis') ||
  jsonb_build_object('summary',NULL,'assessmentSummary',NULL,
   'finalAnalysis',jsonb_build_object('state','withheld','reason','source-unavailable'))
$assessment_view_minimized$;

CREATE FUNCTION galaxy_community_assessment_lifecycle_guard_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $assessment_lifecycle_guard$
DECLARE marked boolean;
BEGIN
 IF TG_TABLE_NAME='operations_autonomy_tasks_v1' THEN
  marked:=NEW.configuration#>>'{communityAssessment,materialsState}'='minimized'
   OR OLD.configuration#>>'{communityAssessment,materialsState}'='minimized';
  IF marked AND EXISTS(SELECT 1 FROM public.community_assessment_tasks_v1 a
    WHERE a.endpoint=NEW.endpoint AND a.id=NEW.id AND a.native_task_id=NEW.id)
    AND NEW.domain='discovery' AND NEW.source='event'
    AND NEW.configuration#>>'{communityAssessment,taskId}'=NEW.id::text THEN
   NEW.configuration:=jsonb_set(NEW.configuration,'{communityAssessment,materialsState}','"minimized"'::jsonb,true);
   NEW.summary:=NULL;
   NEW.result:=public.galaxy_community_assessment_analysis_minimized_v1(NEW.result,NEW.native_run_id,NEW.native_attempt_id);
  END IF;
 ELSIF TG_TABLE_NAME='operations_autonomy_tool_calls_v1' THEN
  SELECT EXISTS(SELECT 1 FROM public.operations_autonomy_tasks_v1 t
    JOIN public.community_assessment_tasks_v1 a ON a.endpoint=t.endpoint AND a.id=t.id AND a.native_task_id=t.id
    WHERE t.endpoint=NEW.endpoint AND t.id=NEW.task_id AND t.domain='discovery' AND t.source='event'
      AND t.configuration#>>'{communityAssessment,taskId}'=t.id::text
      AND t.configuration#>>'{communityAssessment,materialsState}'='minimized') INTO marked;
  IF marked AND NEW.tool IN ('read-community-assessment-material','save-community-assessment-result','assess-task') THEN
   NEW.arguments:=public.galaxy_community_assessment_arguments_minimized_v1(NEW.endpoint,NEW.task_id,NEW.tool,NEW.arguments);
   NEW.read_outcome:=COALESCE(NEW.read_outcome,'{}'::jsonb)||jsonb_build_object('derivedContentState','minimized','derivedContentBasis','community-source-lifecycle');
  END IF;
 ELSE
  SELECT EXISTS(SELECT 1 FROM public.operations_autonomy_tasks_v1 t
    JOIN public.community_assessment_tasks_v1 a ON a.endpoint=t.endpoint AND a.id=t.id AND a.native_task_id=t.id
    WHERE t.endpoint=NEW.endpoint AND t.id::text=NEW.result#>>'{task,id}'
      AND t.domain='discovery' AND t.source='event'
      AND t.configuration#>>'{communityAssessment,taskId}'=t.id::text
      AND t.configuration#>>'{communityAssessment,materialsState}'='minimized') INTO marked;
  IF marked THEN NEW.result:=jsonb_set(NEW.result,'{task}',public.galaxy_community_assessment_view_minimized_v1(NEW.result->'task'),false); END IF;
 END IF;
 RETURN NEW;
END
$assessment_lifecycle_guard$;

REVOKE ALL ON FUNCTION galaxy_community_assessment_arguments_minimized_v1(text,uuid,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION galaxy_community_assessment_analysis_minimized_v1(jsonb,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION galaxy_community_assessment_view_minimized_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION galaxy_community_assessment_lifecycle_guard_v1() FROM PUBLIC;

CREATE TRIGGER community_assessment_task_lifecycle_v1 BEFORE UPDATE OF configuration,result,summary
 ON operations_autonomy_tasks_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_community_assessment_lifecycle_guard_v1();
CREATE TRIGGER community_assessment_tool_lifecycle_v1 BEFORE INSERT OR UPDATE OF arguments,read_outcome
 ON operations_autonomy_tool_calls_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_community_assessment_lifecycle_guard_v1();
CREATE TRIGGER community_assessment_command_lifecycle_v1 BEFORE INSERT OR UPDATE OF result
 ON operations_autonomy_commands_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_community_assessment_lifecycle_guard_v1();

-- Required when merged into the owning role files. The functions remain
-- invoker-rights; no lifecycle routine gains model/permission management.
-- galaxy_api: UPDATE(result) on operations_autonomy_commands_v1 (new).
-- galaxy_api and galaxy_evidence_worker: EXECUTE all three projection helpers.
-- Existing API UPDATE on task/configuration/result/summary and tool arguments /
-- read_outcome already covers its side of the projection. Worker roles require
-- only the helper EXECUTE used by their existing late task UPDATE trigger;
-- they do not gain UPDATE on original command/tool ledgers.
