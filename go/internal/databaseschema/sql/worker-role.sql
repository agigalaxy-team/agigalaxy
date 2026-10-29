-- Explicit administrative provisioning, after schema migrations. Never run on API startup.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='galaxy_evidence_worker') THEN
    CREATE ROLE galaxy_evidence_worker NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO galaxy_evidence_worker;
GRANT USAGE ON SCHEMA galaxy_jobs TO galaxy_evidence_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA galaxy_jobs TO galaxy_evidence_worker;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA galaxy_jobs TO galaxy_evidence_worker;
GRANT EXECUTE ON FUNCTION galaxy_jobs.job_now() TO galaxy_evidence_worker;
-- Native pg-boss scheduling starts its fixed cron queue through this invoker
-- function. The worker still has no schema CREATE or ownership privileges.
GRANT EXECUTE ON FUNCTION galaxy_jobs.create_queue(text,jsonb) TO galaxy_evidence_worker;
GRANT USAGE ON TYPE galaxy_jobs.job_state TO galaxy_evidence_worker;
GRANT UPDATE(search_recovery_count,search_recovery_generation,search_recovery_at) ON jobs TO galaxy_evidence_worker;
GRANT SELECT ON forum_attachments_v1,forum_attachment_links_v1 TO galaxy_evidence_worker;
GRANT UPDATE(state,name,media_type,scan_result,scan_attempts,lease_id,lease_until,last_error,purge_pending,purged_at) ON forum_attachments_v1 TO galaxy_evidence_worker;
GRANT DELETE ON forum_attachments_v1 TO galaxy_evidence_worker;
GRANT SELECT(id,account_id,selection,origin_subject_id,expires_at),DELETE ON private_conversation_archives_v1 TO galaxy_evidence_worker;
GRANT SELECT,INSERT ON private_conversation_deletions_v1 TO galaxy_evidence_worker;
GRANT SELECT ON forum_sections_v2,forum_section_events_v2,forum_notification_reads_v2 TO galaxy_evidence_worker;
GRANT SELECT(authorization_kind,account_viewers) ON forum_permissions_v1 TO galaxy_evidence_worker;
GRANT SELECT(id,endpoint) ON community_accounts TO galaxy_evidence_worker;
GRANT SELECT,DELETE ON task_materials_v1 TO galaxy_evidence_worker;
GRANT UPDATE(body_text,erased_at,check_sequence) ON task_materials_v1 TO galaxy_evidence_worker;
GRANT SELECT ON chat_attachments TO galaxy_evidence_worker;
GRANT SELECT,UPDATE,DELETE ON outcome_materials_v2 TO galaxy_evidence_worker;
GRANT SELECT,INSERT ON outcome_material_events_v2 TO galaxy_evidence_worker;
GRANT SELECT(id,subject_id,state) ON deletion_requests TO galaxy_evidence_worker;
GRANT SELECT(message_id,state,expires_at) ON chat_message_refs TO galaxy_evidence_worker;
GRANT UPDATE(state,name,media_type,scan_result,scan_attempts,lease_id,lease_until,last_error,purge_pending,purged_at) ON chat_attachments TO galaxy_evidence_worker;
GRANT DELETE ON chat_attachments TO galaxy_evidence_worker;
GRANT SELECT,INSERT ON builder_probes TO galaxy_evidence_worker;
GRANT SELECT ON schema_migrations, cases, case_events, bindings, consents, jobs,
  evidence_submissions, verification_attempts TO galaxy_evidence_worker;
REVOKE UPDATE ON jobs, evidence_submissions FROM galaxy_evidence_worker;
GRANT UPDATE (state, attempts, lease_id, locked_until, available_at) ON jobs TO galaxy_evidence_worker;
GRANT UPDATE (state) ON evidence_submissions TO galaxy_evidence_worker;
GRANT INSERT ON verification_attempts, audit_events TO galaxy_evidence_worker;
GRANT USAGE ON SEQUENCE verification_attempts_ordinal_seq, audit_events_sequence_seq TO galaxy_evidence_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON search_documents TO galaxy_evidence_worker;
GRANT SELECT,INSERT,UPDATE ON search_index_control TO galaxy_evidence_worker;
GRANT SELECT ON proofs,capsules,capsule_events TO galaxy_evidence_worker;
GRANT SELECT ON builders,builder_events TO galaxy_evidence_worker;
GRANT EXECUTE ON FUNCTION public.galaxy_queue_search_source(text,uuid,text),public.galaxy_search_lock_sources(jsonb) TO galaxy_evidence_worker;
GRANT SELECT ON recovery_state TO galaxy_evidence_worker;
GRANT SELECT (subject_id,state) ON deletion_requests TO galaxy_evidence_worker;
GRANT SELECT ON moderation_events TO galaxy_evidence_worker;

-- FOR SHARE requires update privileges. These narrow functions acquire locks
-- without granting the worker mutation access to identity, consent or case data.
CREATE OR REPLACE FUNCTION public.galaxy_worker_lock_case(case_id uuid, owner_id text)
RETURNS TABLE(state text) LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  SELECT c.state FROM public.cases c WHERE c.id=case_id AND c.subject_id=owner_id FOR SHARE;
$$;
CREATE OR REPLACE FUNCTION public.galaxy_worker_lock_consent(grant_id uuid, owner_id text, checked_at timestamptz)
RETURNS SETOF public.consents LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  SELECT c.* FROM public.consents c JOIN public.bindings b ON b.id=c.binding_id
  WHERE c.id=grant_id AND c.subject_id=owner_id AND c.revoked_at IS NULL AND b.revoked_at IS NULL
  AND c.expires_at>checked_at AND b.expires_at>checked_at FOR SHARE OF c,b;
$$;
REVOKE ALL ON FUNCTION public.galaxy_worker_lock_case(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.galaxy_worker_lock_consent(uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.galaxy_worker_lock_case(uuid,text) TO galaxy_evidence_worker;
GRANT EXECUTE ON FUNCTION public.galaxy_worker_lock_consent(uuid,text,timestamptz) TO galaxy_evidence_worker;
CREATE OR REPLACE FUNCTION public.galaxy_worker_lock_builder(builder_id uuid)
RETURNS SETOF public.builders LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT b.* FROM public.builders b WHERE b.id=builder_id FOR SHARE;
$$;
REVOKE ALL ON FUNCTION public.galaxy_worker_lock_builder(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.galaxy_worker_lock_builder(uuid) TO galaxy_evidence_worker;

GRANT SELECT,DELETE ON data_exports TO galaxy_evidence_worker;
GRANT SELECT(id,expires_at),DELETE ON trust_package_permissions TO galaxy_evidence_worker;
-- Comment expiry / closed governance audit, not open-case moderation powers.
GRANT SELECT ON task_comments_v2,task_comment_events_v2,comment_reports_v2,comment_governance_events_v2 TO galaxy_evidence_worker;
GRANT UPDATE(payload_text,text_fingerprint,link_fingerprints,erased_at) ON task_comment_events_v2 TO galaxy_evidence_worker;
GRANT UPDATE(review_event_id) ON task_comments_v2 TO galaxy_evidence_worker;
GRANT UPDATE(pause_event_id,decision_event_id) ON comment_reports_v2 TO galaxy_evidence_worker;
GRANT DELETE ON comment_reports_v2,comment_governance_events_v2 TO galaxy_evidence_worker;
-- Bounded product retention worker. No control-key or formal-fact delete grant.
GRANT SELECT,DELETE ON identity_control_operations,community_daily_usage,community_write_receipts,lifecycle_erasure_records TO galaxy_evidence_worker;
GRANT INSERT ON lifecycle_erasure_records TO galaxy_evidence_worker;
GRANT SELECT ON task_requests,task_participations,task_events TO galaxy_evidence_worker;
GRANT UPDATE(snapshot) ON task_requests,task_participations TO galaxy_evidence_worker;
GRANT UPDATE(payload_text) ON task_events TO galaxy_evidence_worker;
GRANT SELECT,INSERT ON runtime_config_events TO galaxy_evidence_worker;
GRANT USAGE ON SEQUENCE runtime_config_events_sequence_seq TO galaxy_evidence_worker;
GRANT SELECT(operation_id,subject_id,payload_hash,created_at,payload_text),UPDATE(payload_text) ON contact_events_v2 TO galaxy_evidence_worker;

-- v2 selected text uses its explicit grant deadline; no remote transport here.
GRANT SELECT(id,subject_id,payload_hash,expires_at,payload_text,erased_at), UPDATE(payload_text,erased_at) ON context_grants_v2 TO galaxy_evidence_worker;

-- CI v2 workers observe under exact delegated requests, never sign or alter sources.
GRANT SELECT,DELETE ON qualification_permission_requests,qualification_permission_request_events TO galaxy_evidence_worker;
GRANT UPDATE(state) ON qualification_permission_requests TO galaxy_evidence_worker;
GRANT UPDATE(payload_text) ON qualification_permission_request_events TO galaxy_evidence_worker;
GRANT SELECT ON ci_requests_v2,ci_observations_v2,verification_objects,verification_events TO galaxy_evidence_worker;
GRANT UPDATE(state) ON ci_requests_v2 TO galaxy_evidence_worker;
GRANT INSERT ON ci_observations_v2 TO galaxy_evidence_worker;
CREATE OR REPLACE FUNCTION public.galaxy_worker_lock_ci_case(request_id uuid,case_id uuid)
RETURNS SETOF public.cases LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT c.* FROM public.cases c JOIN public.ci_requests_v2 r ON r.case_id=c.id
 WHERE r.id=$1 AND c.id=$2 AND r.state<>'revoked' FOR SHARE OF c;
$$;
CREATE OR REPLACE FUNCTION public.galaxy_worker_lock_ci_record(request_id uuid,record_id uuid)
RETURNS SETOF public.verification_objects LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT o.* FROM public.verification_objects o JOIN public.ci_requests_v2 r ON r.case_id=o.case_id
 WHERE r.id=$1 AND o.id=$2 AND r.state<>'revoked' FOR SHARE OF o;
$$;
REVOKE ALL ON FUNCTION public.galaxy_worker_lock_ci_case(uuid,uuid),public.galaxy_worker_lock_ci_record(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.galaxy_worker_lock_ci_case(uuid,uuid),public.galaxy_worker_lock_ci_record(uuid,uuid) TO galaxy_evidence_worker;

-- Temporary Hub intake only; cannot approve membership or sign a peering reply.
GRANT SELECT,DELETE ON hub_intake_v2,hub_events_v2,hub_peering_receipts_v2 TO galaxy_evidence_worker;
GRANT UPDATE(payload_text) ON hub_events_v2 TO galaxy_evidence_worker;
GRANT SELECT,DELETE ON information_watches_v2,information_watch_operations_v2,information_watch_changes_v2 TO galaxy_evidence_worker;
GRANT SELECT,DELETE ON target_reports_v2,target_governance_events_v2 TO galaxy_evidence_worker;
GRANT UPDATE(restriction_event_id,decision_event_id) ON target_reports_v2 TO galaxy_evidence_worker;
GRANT UPDATE(payload_text,erased_at) ON target_governance_events_v2 TO galaxy_evidence_worker;
GRANT SELECT,DELETE ON identity_groups_v2,identity_group_operations_v2,identity_group_approvals_v2 TO galaxy_evidence_worker;
GRANT UPDATE(current_operation_id,source_erased_at) ON identity_groups_v2 TO galaxy_evidence_worker;
GRANT UPDATE(payload_text,erased_at) ON identity_group_operations_v2 TO galaxy_evidence_worker;
GRANT SELECT,DELETE ON watch_controls_v2,watch_control_operations_v2 TO galaxy_evidence_worker;

-- Bounded forum erasure only. Current control/proof payloads and signing keys
-- remain outside this additional role; no new Consent or binding write grant.
GRANT SELECT,DELETE ON forum_posts_v1,forum_versions_v1,forum_replies_v1,forum_events_v1,forum_reports_v1,forum_governance_events_v1,forum_daily_usage_v1,forum_write_receipts_v1 TO galaxy_evidence_worker;
GRANT SELECT(id,subject_id,account_id,event_id,consent_id,origin_binding_id,source_device_id,source_key_id,accepted_epoch,accepted_control_hash,signature_hash,payload_hash,action,object_id,visibility,fields,viewers,issued_at,published_until,accepted_at,authorization_audit_until,revoked_at,erased_at,policy_hash),DELETE ON forum_permissions_v1 TO galaxy_evidence_worker;
GRANT SELECT(id,subject_id,kind) ON subject_control_events TO galaxy_evidence_worker;
GRANT UPDATE(payload_text,erased_at) ON forum_events_v1,forum_governance_events_v1 TO galaxy_evidence_worker;
GRANT EXECUTE ON FUNCTION public.galaxy_worker_prune_forum_authorizations(timestamptz) TO galaxy_evidence_worker;
GRANT EXECUTE ON FUNCTION public.galaxy_worker_lock_closed_forum_reports(timestamptz) TO galaxy_evidence_worker;
GRANT SELECT,UPDATE ON account_chat_reports_v1,account_chat_governance_events_v1,account_chat_governance_materials_v1 TO galaxy_evidence_worker;

-- Queue delegation reads only the stored management principal and current
-- directory roles; the worker never receives browser tokens or signing keys.
GRANT SELECT ON operations_content_visibility_v1,forum_operations_events_v1,operations_operator_principals_v1 TO galaxy_evidence_worker;
GRANT INSERT ON business_admin_audit_v1 TO galaxy_evidence_worker;
GRANT SELECT(sequence) ON business_admin_audit_v1 TO galaxy_evidence_worker;
GRANT USAGE,SELECT ON SEQUENCE business_admin_audit_v1_sequence_seq TO galaxy_evidence_worker;
GRANT SELECT ON operations_product_rules_v1 TO galaxy_evidence_worker;
GRANT SELECT,INSERT,UPDATE ON operations_policy_processes_v1 TO galaxy_evidence_worker;
GRANT SELECT,UPDATE ON account_operations_notices_v1,operations_notices_v1,operations_retention_runs_v1 TO galaxy_evidence_worker;
GRANT SELECT,INSERT,UPDATE ON operations_retention_observations_v1 TO galaxy_evidence_worker;

-- Scanning changes availability. An owner-deletion consumer may finish only
-- the exact owner intent, independently of operator cleanup plans.
GRANT SELECT ON feedback_attachments_v1 TO galaxy_evidence_worker;
GRANT UPDATE(state,scan_result,scan_attempts,lease_id,lease_until,last_error,purge_pending) ON feedback_attachments_v1 TO galaxy_evidence_worker;
GRANT UPDATE(name,media_type,purged_at) ON feedback_attachments_v1 TO galaxy_evidence_worker;
GRANT SELECT(id,endpoint,account_id,submission_operation_id,sequence,owner_deleted_at,owner_delete_operation_id) ON operations_feedback_v1 TO galaxy_evidence_worker;
GRANT SELECT ON account_feedback_data_operations_v1,account_feedback_data_items_v1 TO galaxy_evidence_worker;
GRANT UPDATE(state,updated_at) ON account_feedback_data_operations_v1 TO galaxy_evidence_worker;
GRANT UPDATE(state,attempt_count,attempt_id,attempted_at,next_attempt_at,result_code,object_removed,completed_at) ON account_feedback_data_items_v1 TO galaxy_evidence_worker;

-- Read gates may observe coverage; this role cannot create, release or erase it.
GRANT SELECT(message_id,hidden) ON operations_chat_message_visibility_v1 TO galaxy_evidence_worker;

-- Recheck the original delegated operator's current business grants. No grant
-- mutation, automation execution, or permission-event payload access is given.
GRANT SELECT ON operations_permission_authority_v1,operations_business_roles_v1,operations_role_assignments_v1 TO galaxy_evidence_worker;

-- Current official-message execution only; no role/plan/configuration editing.
GRANT SELECT ON operations_messaging_plans_v1,operations_messaging_versions_v1 TO galaxy_evidence_worker;
-- Acquire only this endpoint's requested plan lock in the caller transaction.
-- Do not grant plan UPDATE to a queue worker. Immutable config stays outside
-- the definer function and uses the worker's existing SELECT privilege.
CREATE OR REPLACE FUNCTION public.galaxy_worker_lock_messaging_plan(requested_plan_id uuid, expected_endpoint text)
RETURNS SETOF public.operations_messaging_plans_v1
LANGUAGE sql STRICT SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT p.* FROM public.operations_messaging_plans_v1 p
  WHERE p.id=requested_plan_id AND p.endpoint=expected_endpoint FOR UPDATE OF p;
$$;
REVOKE ALL ON FUNCTION public.galaxy_worker_lock_messaging_plan(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.galaxy_worker_lock_messaging_plan(uuid,text) TO galaxy_evidence_worker;
GRANT SELECT,INSERT ON operations_messaging_runs_v1,operations_messaging_recipients_v1,operations_messaging_attempts_v1,operations_messaging_announcements_v1 TO galaxy_evidence_worker;
GRANT UPDATE(revision,state,audience_count,error_code,job_id,updated_at,completed_at) ON operations_messaging_runs_v1 TO galaxy_evidence_worker;
GRANT UPDATE(state,attempt_id,attempt_count,lease_until,retry_at,message_id,error_code,retryable,submitted_at,completed_at,updated_at) ON operations_messaging_recipients_v1 TO galaxy_evidence_worker;
GRANT UPDATE(state,error_code,finished_at) ON operations_messaging_attempts_v1 TO galaxy_evidence_worker;
GRANT USAGE,SELECT ON SEQUENCE operations_messaging_runs_v1_sequence_seq,operations_messaging_recipients_v1_sequence_seq,operations_messaging_announcements_v1_sequence_seq TO galaxy_evidence_worker;
GRANT SELECT ON operations_smtp_settings_v1 TO galaxy_evidence_worker;
GRANT SELECT(id,endpoint,issuer,external_subject,uid) ON community_accounts TO galaxy_evidence_worker;
GRANT SELECT(account_id,subject_type) ON official_account_profiles_v1 TO galaxy_evidence_worker;
GRANT INSERT ON operations_notices_v1,account_operations_notices_v1 TO galaxy_evidence_worker;
GRANT USAGE,SELECT ON SEQUENCE operations_notices_v1_sequence_seq,account_operations_notices_v1_sequence_seq TO galaxy_evidence_worker;
GRANT EXECUTE ON FUNCTION public.galaxy_notice_original_operator_role(text,uuid,text) TO galaxy_evidence_worker;

GRANT SELECT ON discovery_usage_events_v1 TO galaxy_evidence_worker;
GRANT SELECT,UPDATE ON discovery_delivery_outbox_v1 TO galaxy_evidence_worker;
GRANT SELECT,INSERT,UPDATE ON discovery_index_control_v1,discovery_index_outbox_v1 TO galaxy_evidence_worker;
GRANT SELECT ON operations_forum_curation_v1,operations_forum_tags_v1 TO galaxy_evidence_worker;
GRANT SELECT(signer_public_key) ON forum_permissions_v1 TO galaxy_evidence_worker;
GRANT SELECT(account_id,subject_id,identity_link_id) ON community_account_links TO galaxy_evidence_worker;
GRANT SELECT(id,issuer,client_id,revoked_at) ON external_identity_links TO galaxy_evidence_worker;

-- Execute only an already human-approved concrete cleanup plan. This role
-- cannot insert/approve plans or replace immutable file/source selections.
GRANT SELECT ON operations_file_cleanup_plans_v1,operations_file_cleanup_items_v1 TO galaxy_evidence_worker;
GRANT UPDATE(revision,state,completed_at) ON operations_file_cleanup_plans_v1 TO galaxy_evidence_worker;
GRANT UPDATE(state,attempt_count,attempt_id,attempted_at,next_attempt_at,result_code,object_removed,completed_at) ON operations_file_cleanup_items_v1 TO galaxy_evidence_worker;
GRANT SELECT(revision) ON chat_message_refs TO galaxy_evidence_worker;
GRANT EXECUTE ON FUNCTION public.galaxy_worker_lock_file_cleanup_sources(text,uuid,text,uuid) TO galaxy_evidence_worker;

-- Background attachment projections can observe the access gate. They cannot
-- create/restore overlays or read the operator's private reason/history.
GRANT SELECT(endpoint,kind,file_id,revision,stopped_until) ON operations_file_access_heads_v1 TO galaxy_evidence_worker;

-- Registered-user121 sync writes only rebuildable directory generations.
-- The released baseline already grants community_accounts issuer/subject reads.
-- No command input, identity-management action or login-fence access is granted.
GRANT SELECT,INSERT ON operations_registered_subjects_v1 TO galaxy_evidence_worker;
GRANT UPDATE(external_subject) ON operations_registered_subjects_v1 TO galaxy_evidence_worker;
GRANT SELECT,INSERT,DELETE ON operations_registered_generations_v1 TO galaxy_evidence_worker;
GRANT UPDATE(state,completed_at,source_count_before,source_count_after,observed_count,code) ON operations_registered_generations_v1 TO galaxy_evidence_worker;
GRANT SELECT,INSERT ON operations_registered_entries_v1 TO galaxy_evidence_worker;
GRANT SELECT,INSERT ON operations_registered_directory_v1 TO galaxy_evidence_worker;
GRANT UPDATE(issuer,generation_id,sync_id,lease_until,last_started_at,last_completed_at,last_error) ON operations_registered_directory_v1 TO galaxy_evidence_worker;

-- Current management lifecycle only; no management sync, profile note,
-- native credentials, command input/results or login-fence access.
GRANT SELECT(operator_id,endpoint,issuer,external_subject,version,login_blocked,deleted_at) ON operations_management_accounts_v1 TO galaxy_evidence_worker;

-- AI123: current stable AI authority only. No prose, command history or mutation.
GRANT SELECT(id,endpoint,domain,enabled,authorization_version) ON operations_ai_work_accounts_v1 TO galaxy_evidence_worker;
GRANT SELECT(id,endpoint,ai_account_id,role_id,enabled,version) ON operations_ai_work_assignments_v1 TO galaxy_evidence_worker;
GRANT SELECT(ai_account_id) ON operations_agentos_executions_v1 TO galaxy_evidence_worker;

-- Directory sync may reserve stable public locators, never profile prose.
GRANT SELECT(account_id,uid,endpoint,issuer,external_subject,created_at) ON official_account_registrations_v1 TO galaxy_evidence_worker;
GRANT INSERT(account_id,uid,endpoint,issuer,external_subject,created_at,updated_at) ON official_account_registrations_v1 TO galaxy_evidence_worker;

-- Autonomy129 scheduler and original-run reconciliation. The worker cannot
-- edit existing prompt/plan versions, enable plans or mutate business roles.
GRANT SELECT,INSERT ON operations_autonomy_configs_v1 TO galaxy_evidence_worker;
GRANT UPDATE(next_due_at,last_valid_at) ON operations_autonomy_configs_v1 TO galaxy_evidence_worker;
GRANT SELECT,INSERT ON operations_autonomy_versions_v1 TO galaxy_evidence_worker;
GRANT SELECT,INSERT,UPDATE ON operations_autonomy_tasks_v1,operations_autonomy_health_v1 TO galaxy_evidence_worker;
GRANT SELECT ON operations_autonomy_commands_v1 TO galaxy_evidence_worker;
GRANT SELECT,UPDATE ON operations_autonomy_events_v1 TO galaxy_evidence_worker;
GRANT SELECT ON operations_autonomy_receipts_v1,operations_autonomy_tool_calls_v1,operations_ai_role_delegations_v1 TO galaxy_evidence_worker;
GRANT SELECT(id,name,enabled) ON operations_ai_work_accounts_v1 TO galaxy_evidence_worker;
GRANT SELECT(id,endpoint,version) ON operations_automation_grants_v1 TO galaxy_evidence_worker;
GRANT SELECT(enabled,permissions,executor_kind,mode,ai_account_id,resource_ids,resource_scope_kind) ON operations_automation_grants_v1 TO galaxy_evidence_worker;
GRANT SELECT(endpoint,active_id) ON operations_p13_strategy_heads_v1 TO galaxy_evidence_worker;
GRANT SELECT(approved_ai) ON operations_messaging_plans_v1 TO galaxy_evidence_worker;
GRANT INSERT(approved_ai) ON operations_messaging_runs_v1 TO galaxy_evidence_worker;
GRANT INSERT(actor_kind,ai_context) ON operations_messaging_events_v1 TO galaxy_evidence_worker;
GRANT SELECT,INSERT,UPDATE ON operations_autonomy_strategy_schedules_v1 TO galaxy_evidence_worker;
GRANT SELECT,INSERT ON operations_autonomy_event_consumers_v1 TO galaxy_evidence_worker;
GRANT SELECT ON operations_p13_strategy_heads_v1,operations_p13_strategy_versions_v1 TO galaxy_evidence_worker;
GRANT SELECT,INSERT ON operations_autonomy_runtime_v1 TO galaxy_evidence_worker;
GRANT EXECUTE ON FUNCTION public.galaxy_autonomy_workbench_receipts_v1(text,uuid) TO galaxy_evidence_worker;
GRANT INSERT,UPDATE ON operations_autonomy_receipts_v1 TO galaxy_evidence_worker;
GRANT SELECT ON operations_autonomy_decisions_v1 TO galaxy_evidence_worker;
GRANT SELECT,INSERT,UPDATE ON operations_autonomy_workbench_runs_v1 TO galaxy_evidence_worker;
GRANT EXECUTE ON FUNCTION public.galaxy_autonomy_workbench_pending_v1(text,uuid) TO galaxy_evidence_worker;
GRANT EXECUTE ON FUNCTION public.galaxy_autonomy_lock_persisted_authority_v1(text,uuid) TO galaxy_evidence_worker;
GRANT SELECT(endpoint,version_id,result) ON operations_p13_strategy_rehearsals_v1 TO galaxy_evidence_worker;
