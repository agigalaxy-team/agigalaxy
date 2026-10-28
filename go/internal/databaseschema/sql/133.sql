
CREATE TABLE web_event_outbox_v1 (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 module text NOT NULL, source_table text NOT NULL, source_ref jsonb NOT NULL,
 endpoint text, operation_id text, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE web_event_sequence_v1 (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), cursor bigint NOT NULL DEFAULT 0);
INSERT INTO web_event_sequence_v1(singleton,cursor) VALUES(true,0);
CREATE TABLE web_event_log_v1 (
 cursor bigint PRIMARY KEY, module text NOT NULL, source_table text NOT NULL,
 source_ref jsonb NOT NULL, endpoint text, operation_id text, committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION galaxy_web_events_promote_v1(batch integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record; next_cursor bigint; promoted integer:=0;
BEGIN
 IF batch<1 OR batch>256 THEN RAISE EXCEPTION 'invalid web event batch'; END IF;
 SELECT cursor INTO next_cursor FROM public.web_event_sequence_v1 WHERE singleton FOR UPDATE;
 FOR r IN SELECT * FROM public.web_event_outbox_v1 ORDER BY id LIMIT batch FOR UPDATE LOOP
  next_cursor:=next_cursor+1;
  INSERT INTO public.web_event_log_v1(cursor,module,source_table,source_ref,endpoint,operation_id)
   VALUES(next_cursor,r.module,r.source_table,r.source_ref,r.endpoint,r.operation_id);
  DELETE FROM public.web_event_outbox_v1 WHERE id=r.id;
  promoted:=promoted+1;
 END LOOP;
 UPDATE public.web_event_sequence_v1 SET cursor=next_cursor WHERE singleton;
 DELETE FROM public.web_event_log_v1 WHERE cursor<next_cursor-4095 OR committed_at<clock_timestamp()-interval '7 days';
 IF promoted>0 THEN PERFORM pg_notify('galaxy_web_event_ready_v1',''); END IF;
 RETURN promoted;
END; $$;
REVOKE ALL ON FUNCTION galaxy_web_events_promote_v1(integer) FROM PUBLIC;
CREATE FUNCTION galaxy_web_event_capture_v1() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r jsonb; refs jsonb; current_module text; source_endpoint text;
BEGIN
 IF TG_OP='DELETE' THEN r=to_jsonb(OLD); ELSE r=to_jsonb(NEW); END IF;
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=r THEN RETURN NEW; END IF;
 -- Refresh progress does not change the browser's account authority. Retain
 -- every other field in this comparison: revocation, principal, CSRF, account,
 -- original/max expiry and logout fences must still invalidate its projections.
 IF TG_TABLE_NAME='official_account_sessions_v1' AND TG_OP='UPDATE'
  AND to_jsonb(OLD)->>'refresh_state' IS DISTINCT FROM 'revoked'
  AND r->>'refresh_state' IS DISTINCT FROM 'revoked'
  AND (to_jsonb(OLD)-ARRAY['refresh_cipher','upstream_expires_at','idle_expires_at','refresh_version','refresh_state'])
    =(r-ARRAY['refresh_cipher','upstream_expires_at','idle_expires_at','refresh_version','refresh_state'])
 THEN RETURN NULL; END IF;
 source_endpoint:=r->>'endpoint';
 IF source_endpoint IS NULL AND r->>'account_id' IS NOT NULL THEN
  SELECT endpoint INTO source_endpoint FROM public.community_accounts WHERE id::text=r->>'account_id';
 END IF;
 SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO refs FROM jsonb_each(r)
 WHERE key IN ('id','account_id','subject_id','room_id','message_id','task_id','project_id','work_id','scope_id','post_id','reply_id','source_id','operator_id','endpoint','initiator_id','recipient_id','participant_id','decision_id','capsule_id','assistance_id','grant_id','builder_id','owner_id','request_id','watch_id','snapshot_id','notice_id');
 refs:=refs||jsonb_build_object('_operation',TG_OP,'_version',coalesce(r->>'revision',r->>'version',r->>'head_version'));
 FOREACH current_module IN ARRAY string_to_array(TG_ARGV[0],',') LOOP
  IF current_module='site-content' AND (r->>'state' IS DISTINCT FROM 'published' OR r->>'published_at' IS NULL OR TG_OP='DELETE') THEN CONTINUE; END IF;
  INSERT INTO public.web_event_outbox_v1(module,source_table,source_ref,endpoint,operation_id)
  VALUES(current_module,TG_TABLE_NAME,refs,source_endpoint,coalesce(r->>'last_operation_id',r->>'operation_id'));
 END LOOP;
 PERFORM pg_notify('galaxy_web_event_pending_v1','');
 RETURN NULL;
END; $$;
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON consents FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('authorization');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON bindings FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('authorization');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON external_identity_links FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('authorization');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON community_account_links FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('authorization');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON official_account_sessions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('authorization');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON target_governance_events_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('authorization');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON official_account_profiles_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('account,users');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON account_work_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('account-work');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON account_work_scopes_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('account-work');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON account_reading_bookmarks_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('bookmarks');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON reading_bookmarks_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('bookmarks');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON account_follows_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('follows');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON forum_posts_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('forum,community,information');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON forum_replies_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('forum,community,information');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON forum_permissions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('forum,authorization');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON forum_versions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('forum');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON chat_rooms FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('chat');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON chat_memberships FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('chat');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON chat_message_refs FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('chat,notifications');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON chat_cursors FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('chat');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON chat_message_preferences FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('chat');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON chat_agent_grants FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('chat');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON chat_attachments FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('chat');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON task_requests FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('tasks,information');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON task_participations FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('tasks');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON task_events FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('tasks,notifications');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON task_comments_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('tasks');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON task_materials_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('tasks');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON projects_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('projects,information');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON project_roles_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('projects');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON project_field_sources_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('projects');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON project_preferences_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('projects');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON contacts_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('contacts,authorization');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON capsules FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('capsules,resources,information');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON capsule_events FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('capsules,resources,notifications,information');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON capsule_permissions FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('authorization');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON capsule_uses FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('capsules');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON capsule_uses_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('capsules');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON notification_preferences FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('notifications');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON notification_reads FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('notifications');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON notification_options_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('notifications');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON notification_presentations FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('notifications');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON chat_decisions FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('chat,notifications');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON task_comment_events_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('tasks,notifications');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON incident_notices FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('notifications');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON assistance_events FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('notifications');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON context_grants FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('notifications');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON context_acceptances FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('notifications');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON comment_governance_events_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('notifications');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON qualification_permission_request_events FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('notifications');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON information_watch_changes_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('notifications,information');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_feedback_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('feedback');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_feedback_events_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('feedback');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_model_settings_state_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('model-settings');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_model_settings_versions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('model-settings');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_system_settings_heads_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('system-settings');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_system_settings_versions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('system-settings');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_system_general_publications_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('system-settings');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_business_roles_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('permissions');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_role_assignments_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('permissions');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_automation_grants_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('permissions');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_permission_authority_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('permissions');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_ai_work_accounts_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('ai-work-accounts');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_ai_work_assignments_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('ai-work-accounts');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_management_accounts_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('management-accounts');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_management_directory_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('management-accounts');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_registered_subjects_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('registered-users');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_registered_directory_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('registered-users');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_messaging_plans_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('messaging');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_messaging_runs_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('messaging');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_messaging_recipients_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('messaging');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_messaging_attempts_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('messaging');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_messaging_announcements_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('messaging');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_forum_curation_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('community');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_forum_tags_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('community');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_file_access_heads_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('files,authorization');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_file_cleanup_plans_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('files');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_file_cleanup_items_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('files');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_maintenance_plans_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('maintenance');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_recommendation_policy_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('recommendation');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_recommendation_themes_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('recommendation');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_agentos_conversations_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('agentos');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_agentos_executions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('agentos');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_agentos_tool_calls_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('agentos');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_product_rules_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('rules');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_policy_processes_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('rules');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_notices_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('notices');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_smtp_settings_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('smtp');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_p13_strategy_heads_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('strategies');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_p13_strategy_runs_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('strategies');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_p14_rule_heads_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('rules');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON account_chat_reports_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('chat-reports');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON account_chat_governance_events_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('chat-reports,authorization');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON site_publications_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('content,site-content');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON business_admin_audit_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('audit');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON community_accounts FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('users');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_search_quality_state_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('search-quality');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_search_quality_versions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('search-quality');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_content_visibility_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('community,authorization');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_model_settings_operations_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('model-settings');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_system_settings_commands_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('system-settings');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_messaging_commands_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('messaging');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_messaging_events_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('messaging');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_messaging_versions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('messaging');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_registered_commands_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('registered-users');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_registered_login_fences_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('registered-users');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_management_commands_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('management-accounts');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_management_entries_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('management-accounts');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_management_login_fences_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('management-accounts');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_ai_work_commands_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('ai-work-accounts');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_smtp_commands_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('smtp');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_smtp_tests_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('smtp');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_smtp_events_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('smtp');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_p13_strategy_rehearsals_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('strategies');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_p13_strategy_commands_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('strategies');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_p13_strategy_events_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('strategies');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_p13_strategy_versions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('strategies');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_p14_rule_commands_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('rules');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_p14_rule_events_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('rules');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_p14_rule_decisions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('rules');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_p14_rule_versions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('rules');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_retention_runs_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('retention');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_retention_observations_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('retention');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_product_commands_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('rules');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_maintenance_events_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('maintenance');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_file_access_events_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('files');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_recommendation_events_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('recommendation');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_search_quality_operations_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('search-quality');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_agentos_commands_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('agentos');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_agentos_conversation_commands_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('agentos');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_agentos_conversation_tool_calls_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('agentos');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_agentos_conversation_cards_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('agentos');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON builders FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('builders,information');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON builder_events FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('builders,information');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON builder_probes FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('builders');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON information_watches_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('information');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON information_watch_operations_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('information');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON choice_snapshot_preferences FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('choice-sync');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON choice_snapshot_heads FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('choice-sync');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON choice_snapshot_versions FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('choice-sync');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON ci_requests_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('ci');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON ci_observations_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('ci');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON ci_proofs_v2 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('ci');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON account_operations_notices_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('account');
