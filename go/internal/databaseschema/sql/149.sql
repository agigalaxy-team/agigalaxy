ALTER TABLE community_growth_sources_v1
 ADD COLUMN growth_experience bigint CHECK (growth_experience >= 0),
 ADD COLUMN growth_rule_version bigint CHECK (growth_rule_version > 0),
 ADD COLUMN growth_basis text DEFAULT 'legacy' CHECK (growth_basis IN ('legacy','baseline','version')),
 ADD COLUMN growth_earned_at timestamptz;
ALTER TABLE community_growth_sources_v1 ALTER COLUMN growth_basis DROP DEFAULT;

CREATE TABLE community_growth_ledger_state_v1 (
 endpoint text PRIMARY KEY,
 prepared_at timestamptz NOT NULL,
 reconciled_at timestamptz,
 activated_at timestamptz
);
INSERT INTO community_growth_ledger_state_v1(endpoint,prepared_at)
 SELECT endpoint,transaction_timestamp() FROM community_growth_initialized_v1;
UPDATE community_growth_reconcile_state_v1
 SET phase='content',cursor='',completed_at=NULL,updated_at=transaction_timestamp();
CREATE INDEX community_growth_pending_award_v1 ON community_growth_sources_v1(endpoint,id)
 WHERE active AND growth_rule_version IS NULL AND source_kind NOT IN ('evaluation','honor');

CREATE INDEX community_growth_active_content_recognition_v1
 ON community_growth_recognitions_v1(endpoint,object_kind,lower(object_id)) WHERE active AND kind='content';
CREATE INDEX forum_replies_discussion_heat_v1
 ON forum_replies_v1(post_id,account_id,created_at,id) WHERE state='published' AND erased_at IS NULL;

ALTER TABLE operations_autonomy_decisions_v1
 DROP CONSTRAINT operations_autonomy_decisions_v1_decision_check,
 ADD CONSTRAINT operations_autonomy_decisions_v1_decision_check CHECK(decision IN ('rejected','cancelled','no-action','approved'));
ALTER TABLE operations_agentos_conversation_tool_calls_v1
 DROP CONSTRAINT operations_conversation_tool_v5,
 ADD CONSTRAINT operations_conversation_tool_v5 CHECK(tool IN
  ('workbench-summary','query-operations','read-operation-object','list-authorized-work','run-authorized-work',
   'prepare-operation','read-ai-delegation','read-task-operation','plan-conversation-turn','assess-conversation-task',
   'read-dispatched-task','read-community-parameters'));

-- A frozen award by itself does not change the compatibility projection.
DROP TRIGGER web_growth_hint_v1 ON community_growth_sources_v1;
CREATE TRIGGER web_growth_hint_v1 AFTER INSERT OR DELETE ON community_growth_sources_v1
 FOR EACH ROW EXECUTE FUNCTION galaxy_web_growth_hint_v1();
CREATE TRIGGER web_growth_hint_update_v1 AFTER UPDATE ON community_growth_sources_v1 FOR EACH ROW
 WHEN (ROW(OLD.account_id,OLD.domains,OLD.title,OLD.object_kind,OLD.object_id,OLD.active,OLD.revision,OLD.occurred_at)
  IS DISTINCT FROM ROW(NEW.account_id,NEW.domains,NEW.title,NEW.object_kind,NEW.object_id,NEW.active,NEW.revision,NEW.occurred_at)
  OR (OLD.growth_rule_version IS NULL AND NEW.growth_rule_version IS NOT NULL AND OLD.updated_at IS DISTINCT FROM NEW.updated_at))
 EXECUTE FUNCTION galaxy_web_growth_hint_v1();

ALTER TABLE community_assessment_config_v1 ADD COLUMN retired_at timestamptz;

CREATE OR REPLACE FUNCTION galaxy_community_assessment_executor_changed_v1() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $executor$
DECLARE old_configuration jsonb; new_configuration jsonb; affected_executor uuid;
BEGIN
 IF TG_ARGV[0]='prompt' THEN
  IF NEW.domain<>'discovery' OR OLD.prompt_version IS NOT DISTINCT FROM NEW.prompt_version THEN RETURN NEW; END IF;
  affected_executor:=NEW.id;
 ELSE
  IF OLD.active_id IS NOT DISTINCT FROM NEW.active_id THEN RETURN NEW; END IF;
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
   WHERE c.endpoint=NEW.endpoint AND c.retired_at IS NULL AND c.executor_config_id=affected_executor AND x.endpoint=c.endpoint;
 END IF;
 RETURN NEW;
END
$executor$;

CREATE FUNCTION galaxy_community_growth_activate_v1() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $activate$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('community-assessment-config:'||NEW.endpoint,734912768));
 INSERT INTO public.community_assessment_config_v1(endpoint,version,updated_at,retired_at)
 VALUES(NEW.endpoint,1,NEW.activated_at,NEW.activated_at)
 ON CONFLICT(endpoint) DO UPDATE SET retired_at=excluded.retired_at
 WHERE community_assessment_config_v1.retired_at IS NULL;

 INSERT INTO public.web_event_outbox_v1(module,source_table,source_ref,endpoint)
 VALUES('growth','community_growth_sources_v1',jsonb_build_object('_scope_reset',true,'_operation','UPDATE'),NEW.endpoint);
 PERFORM pg_notify('galaxy_web_event_pending_v1','');
 RETURN NULL;
END
$activate$;
REVOKE ALL ON FUNCTION galaxy_community_growth_activate_v1() FROM PUBLIC;
CREATE TRIGGER community_growth_activate_v1 AFTER UPDATE OF activated_at ON community_growth_ledger_state_v1
 FOR EACH ROW WHEN (OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL)
 EXECUTE FUNCTION galaxy_community_growth_activate_v1();
