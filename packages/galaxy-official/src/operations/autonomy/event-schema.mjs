// Metadata-only outbox. AFTER triggers participate in the original business
// transaction, so a rollback cannot leave a phantom event to process.
export const operationsAutonomyEventsMigrationSql=`
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
`;
