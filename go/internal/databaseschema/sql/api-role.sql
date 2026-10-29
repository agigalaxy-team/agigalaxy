-- Explicit administrative provisioning after migrations; the API is not a schema owner.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='galaxy_api') THEN CREATE ROLE galaxy_api NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO galaxy_api;
GRANT SELECT,INSERT ON chat_participants_v3,account_reading_bookmarks_v2,account_reading_bookmark_operations_v2,forum_attachments_v1,forum_attachment_links_v1 TO galaxy_api;
GRANT UPDATE(saved,revision,saved_at,updated_at) ON account_reading_bookmarks_v2 TO galaxy_api;
GRANT UPDATE(state,uploaded_at,expires_at,published_at,lease_id,lease_until,last_error,revoked_at,purge_pending) ON forum_attachments_v1 TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON account_external_credentials_v1 TO galaxy_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON account_work_scopes_v1,account_work_v1,account_work_operations_v1 TO galaxy_api;
GRANT SELECT,INSERT ON official_account_profiles_v1,official_account_type_history_v1 TO galaxy_api;
GRANT UPDATE(subject_type,display_name,avatar_key,bio,revision,query_enabled,query_scope,query_linked_ids,query_external_credentials,archive_retention_days,updated_at) ON official_account_profiles_v1 TO galaxy_api;
GRANT SELECT,INSERT,DELETE ON private_conversation_archives_v1,private_conversation_chunks_v1 TO galaxy_api;
GRANT UPDATE(state,byte_length,chunk_count,updated_at,expires_at) ON private_conversation_archives_v1 TO galaxy_api;
GRANT SELECT,INSERT ON private_conversation_deletions_v1 TO galaxy_api;
GRANT SELECT,INSERT ON forum_sections_v2,forum_section_events_v2,forum_notification_reads_v2 TO galaxy_api;
GRANT UPDATE(version,title,theme,description,audience,state,category,updated_at) ON forum_sections_v2 TO galaxy_api;
GRANT SELECT,INSERT ON reading_bookmarks_v1,reading_bookmark_operations_v1 TO galaxy_api;
GRANT UPDATE(saved,revision,saved_at,updated_at) ON reading_bookmarks_v1 TO galaxy_api;
GRANT SELECT,INSERT ON task_materials_v1 TO galaxy_api;
GRANT UPDATE(body_text,erased_at) ON task_materials_v1 TO galaxy_api;
GRANT SELECT,INSERT ON chat_attachments TO galaxy_api;
GRANT SELECT,INSERT ON outcome_materials_v2,outcome_material_events_v2 TO galaxy_api;
GRANT UPDATE(state,approval_id,revision,approved_at,expires_at,body_text,name,media_type,byte_size,scan_result,last_error,purge_pending,purged_at,storage_key,encryption_key_id) ON outcome_materials_v2 TO galaxy_api;
GRANT UPDATE(state,message_id,uploaded_at,expires_at,lease_id,lease_until,last_error,revoked_at,purge_pending) ON chat_attachments TO galaxy_api;
GRANT SELECT,INSERT ON external_identity_links TO galaxy_api;
GRANT UPDATE (revoked_at) ON external_identity_links TO galaxy_api;
GRANT SELECT ON builder_probes TO galaxy_api;
GRANT SELECT,INSERT ON honor_rule_versions TO galaxy_api;
GRANT USAGE ON SEQUENCE honor_rule_versions_sequence_seq TO galaxy_api;
GRANT SELECT ON search_documents,search_index_control TO galaxy_api;
GRANT SELECT ON schema_migrations, subjects, binding_challenges, bindings, access_credentials,
  audit_events, jobs, session_challenges, consents, cases, case_events,
  evidence_submissions, verification_attempts, proofs, assistance_requests, assistance_events, context_grants, context_acceptances, notification_preferences, notification_reads, moderation_reports, moderation_events, capsules, capsule_events, capsule_uses, builders, builder_events TO galaxy_api;
GRANT INSERT ON subjects, binding_challenges, bindings, access_credentials, audit_events,
  jobs, session_challenges, consents, cases, case_events, evidence_submissions, proofs, assistance_requests, assistance_events, context_grants, context_acceptances, notification_preferences, notification_reads, moderation_reports, moderation_events, capsules, capsule_events, capsule_uses, builders, builder_events TO galaxy_api;
GRANT UPDATE (consumed_at) ON binding_challenges, session_challenges TO galaxy_api;
GRANT SELECT ON incident_notices TO galaxy_api;
GRANT UPDATE (revoked_at) ON bindings, access_credentials, consents, proofs, context_grants TO galaxy_api;
GRANT UPDATE (revision) ON capsules, builders TO galaxy_api;
GRANT UPDATE (version, state) ON cases TO galaxy_api;
GRANT UPDATE (version, state, paused, appeal_count) ON moderation_reports TO galaxy_api;
GRANT UPDATE (settings, revision, updated_at, archived_before) ON notification_preferences TO galaxy_api;
GRANT DELETE ON notification_reads TO galaxy_api;
GRANT UPDATE (version, snapshot) ON assistance_requests TO galaxy_api;
GRANT USAGE ON SEQUENCE audit_events_sequence_seq TO galaxy_api;
GRANT SELECT,INSERT ON audit_access_grants,audit_reads TO galaxy_api;
GRANT UPDATE (revoked_at) ON audit_access_grants TO galaxy_api;
GRANT SELECT ON recovery_state TO galaxy_api;
GRANT SELECT ON deletion_executions TO galaxy_api;
GRANT SELECT,INSERT ON deletion_requests,deletion_events TO galaxy_api;
GRANT UPDATE (state,revision,updated_at) ON deletion_requests TO galaxy_api;

CREATE OR REPLACE FUNCTION public.galaxy_api_lock_subject(owner_id text)
RETURNS TABLE(public_key text) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.public_key FROM public.subjects s WHERE s.id=owner_id FOR UPDATE;
$$;
CREATE OR REPLACE FUNCTION public.galaxy_api_lock_evidence_read(evidence_id uuid, owner_id text)
RETURNS SETOF public.evidence_submissions LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.* FROM public.evidence_submissions e WHERE e.id=evidence_id AND e.subject_id=owner_id FOR SHARE;
$$;
CREATE OR REPLACE FUNCTION public.galaxy_api_lock_evidence_write(evidence_id uuid, owner_id text)
RETURNS SETOF public.evidence_submissions LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.* FROM public.evidence_submissions e WHERE e.id=evidence_id AND e.subject_id=owner_id FOR UPDATE;
$$;
REVOKE ALL ON FUNCTION public.galaxy_api_lock_subject(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.galaxy_api_lock_evidence_read(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.galaxy_api_lock_evidence_write(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.galaxy_api_lock_subject(text) TO galaxy_api;
GRANT EXECUTE ON FUNCTION public.galaxy_api_lock_evidence_read(uuid,text) TO galaxy_api;
GRANT EXECUTE ON FUNCTION public.galaxy_api_lock_evidence_write(uuid,text) TO galaxy_api;

GRANT SELECT,INSERT ON data_exports,data_export_reads TO galaxy_api;
GRANT UPDATE(revoked_at) ON data_exports TO galaxy_api;
GRANT SELECT,INSERT ON runtime_config_events TO galaxy_api;
GRANT USAGE ON SEQUENCE runtime_config_events_sequence_seq TO galaxy_api;
GRANT SELECT,INSERT ON profile_statements TO galaxy_api;

-- Product v2 additions. Historical records stay append-only.
GRANT SELECT,INSERT ON subject_control_events,case_task_links,task_events,community_account_links,community_interactions TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON subject_control_heads,device_authorizations,recovery_authorizations,identity_control_operations TO galaxy_api;
GRANT SELECT,INSERT ON community_accounts,community_daily_usage,community_write_receipts,task_requests,task_participations TO galaxy_api;
GRANT UPDATE(verified_at,verification_method) ON community_accounts TO galaxy_api;
GRANT UPDATE(used) ON community_daily_usage TO galaxy_api;
GRANT UPDATE(responded_at) ON community_write_receipts TO galaxy_api;
GRANT UPDATE(case_id,version,snapshot) ON task_requests TO galaxy_api;
GRANT UPDATE(version,snapshot) ON task_participations TO galaxy_api;
GRANT UPDATE(device_id,key_id,control_epoch) ON bindings,access_credentials TO galaxy_api;
GRANT EXECUTE ON FUNCTION public.galaxy_api_lock_subject_control(text,boolean) TO galaxy_api;
GRANT SELECT,INSERT ON verification_objects,verification_events,verification_dependencies TO galaxy_api;
GRANT UPDATE(version,state) ON verification_objects TO galaxy_api;

-- CUR-35 chat metadata and erasure receipts. Message bodies stay in Prosody.
GRANT SELECT,INSERT,UPDATE ON chat_rooms,chat_memberships,chat_decisions,chat_message_refs,chat_message_operations,chat_cursors,chat_message_preferences,chat_agent_grants TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE chat_message_refs_sequence_seq TO galaxy_api;
GRANT SELECT,UPDATE ON chat_directory_clock TO galaxy_api;
GRANT SELECT,INSERT ON chat_human_message_reads TO galaxy_api;
REVOKE ALL ON FUNCTION public.galaxy_chat_next_directory_order() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.galaxy_chat_next_directory_order() TO galaxy_api;
GRANT SELECT ON lifecycle_erasure_records TO galaxy_api;
GRANT SELECT,INSERT ON capsule_permissions,capsule_uses_v2 TO galaxy_api;
GRANT UPDATE(revoked_at,revoke_id,revoke_consent_id,revoke_payload_text,revoke_payload_hash) ON capsule_permissions TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON notification_options_v2,notification_presentations,personal_summary_preferences,personal_summary_heads,personal_summary_versions TO galaxy_api;
GRANT SELECT,INSERT ON projects_v2,project_events_v2,project_roles_v2,project_transfers_v2,project_preferences_v2 TO galaxy_api;
GRANT UPDATE(revision,state,owner_id,document_event_id,policy_event_id,updated_at) ON projects_v2 TO galaxy_api;
GRANT UPDATE(grant_event_id,revoke_event_id,state,updated_at) ON project_roles_v2 TO galaxy_api;
GRANT UPDATE(state,response_event_id,updated_at) ON project_transfers_v2 TO galaxy_api;
GRANT UPDATE(revision,settings,updated_at) ON project_preferences_v2 TO galaxy_api;
GRANT SELECT,INSERT ON project_field_sources_v2 TO galaxy_api;
GRANT UPDATE(event_id) ON project_field_sources_v2 TO galaxy_api;
GRANT SELECT,INSERT ON contacts_v2,contact_events_v2 TO galaxy_api;
GRANT UPDATE(state,revision,response_event_id,room_id,updated_at) ON contacts_v2 TO galaxy_api;
GRANT SELECT,INSERT ON experience_objects,experience_events,qualification_calculation_grants TO galaxy_api;
GRANT UPDATE(version,state) ON experience_objects TO galaxy_api;
GRANT UPDATE(revoked_at,revoke_id,revoke_consent_id,revoke_payload_text,revoke_payload_hash) ON qualification_calculation_grants TO galaxy_api;
GRANT SELECT,INSERT ON contribution_publications TO galaxy_api;
GRANT UPDATE(revoked_at,revoke_id,revoke_consent_id,revoke_payload_text,revoke_payload_hash) ON contribution_publications TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON room_shared_summaries TO galaxy_api;
GRANT SELECT,INSERT ON recruitment_opportunities,recruitment_events,recruitment_task_links TO galaxy_api;
GRANT UPDATE(revision,updated_at,publisher_id,contact_subject_id,current_event_id,expires_at,state) ON recruitment_opportunities TO galaxy_api;
GRANT SELECT,INSERT ON context_grants_v2,context_events_v2 TO galaxy_api;
GRANT UPDATE(state,response_event_id,revoked_at) ON context_grants_v2 TO galaxy_api;
GRANT SELECT,INSERT ON ci_requests_v2,ci_proofs_v2 TO galaxy_api;
GRANT SELECT ON ci_observations_v2 TO galaxy_api;
GRANT UPDATE(state) ON ci_requests_v2 TO galaxy_api;
GRANT UPDATE(revoked_at) ON ci_proofs_v2 TO galaxy_api;
-- Independent comments and scoped governance; authors append versions, never
-- physically erase someone else's source or set community account penalties.
GRANT SELECT,INSERT ON task_comments_v2,task_comment_events_v2,comment_reports_v2,comment_governance_events_v2 TO galaxy_api;
GRANT UPDATE(revision,current_event_id,state,review_state,rule_version,rule_reasons,review_event_id) ON task_comments_v2 TO galaxy_api;
GRANT UPDATE(version,state,pause_until,pause_event_id,decision_event_id,closed_at,appeal_count) ON comment_reports_v2 TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON choice_snapshot_preferences,choice_snapshot_heads,choice_snapshot_versions TO galaxy_api;
GRANT SELECT,INSERT ON configuration_objects,configuration_events TO galaxy_api;
GRANT UPDATE(version,state) ON configuration_objects TO galaxy_api;
GRANT SELECT,INSERT ON qualification_permission_requests,qualification_permission_request_events TO galaxy_api;
GRANT UPDATE(version,state) ON qualification_permission_requests TO galaxy_api;
GRANT SELECT,INSERT ON trust_package_permissions TO galaxy_api;
GRANT UPDATE(revoked_at,revoke_operation_id,revoke_payload_text,revoke_signed,revoke_signature_hash) ON trust_package_permissions TO galaxy_api;

-- Structured Hub Charters, explicit membership and scoped direct read peering.
GRANT SELECT,INSERT ON hub_events_v2,hub_peering_events_v2 TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON hub_heads_v2,hub_memberships_v2,hub_intake_v2,hub_peering_agreements_v2,hub_peering_grants_v2,hub_peering_receipts_v2 TO galaxy_api;
GRANT SELECT,INSERT ON hub_peering_changes_v2 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE hub_peering_changes_v2_sequence_seq TO galaxy_api;
-- Actual Pack use is the runner's independent reference stream.
GRANT SELECT,INSERT ON worker_pack_uses,worker_pack_use_events TO galaxy_api;
GRANT UPDATE(version,state) ON worker_pack_uses TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON information_watches_v2,information_watch_changes_v2 TO galaxy_api;
GRANT SELECT,INSERT ON information_watch_operations_v2 TO galaxy_api;
GRANT SELECT,INSERT ON target_reports_v2,target_governance_events_v2 TO galaxy_api;
-- Group approval bytes remain immutable to the API role.
GRANT SELECT,INSERT ON identity_groups_v2,identity_group_operations_v2,identity_group_approvals_v2 TO galaxy_api;
GRANT UPDATE(version,state,current_operation_id,member_ids,updated_at) ON identity_groups_v2 TO galaxy_api;
GRANT UPDATE(state,closed_at,result_version) ON identity_group_operations_v2 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE identity_group_approvals_v2_sequence_seq TO galaxy_api;
GRANT UPDATE(version,state,restriction_scopes,restriction_until,restriction_event_id,decision_event_id,closed_at,appeal_count) ON target_reports_v2 TO galaxy_api;
-- Selected watch controls only. Exact operation receipts are immutable.
GRANT SELECT,INSERT ON watch_controls_v2,watch_control_operations_v2 TO galaxy_api;
GRANT UPDATE(revision,state,current_grant_id,current_binding_id,expires_at,updated_at,stopped_at) ON watch_controls_v2 TO galaxy_api;

-- Independent ordinary forum. Immutable signed event/evidence bytes cannot be
-- rewritten by the API. Only finite CAS heads and explicit revocation mutate.
GRANT SELECT,INSERT ON forum_posts_v1,forum_versions_v1,forum_replies_v1,forum_events_v1,forum_permissions_v1,forum_reports_v1,forum_governance_events_v1,forum_daily_usage_v1,forum_write_receipts_v1 TO galaxy_api;
GRANT UPDATE(head_version,current_version_id,state,updated_at) ON forum_posts_v1 TO galaxy_api;
GRANT UPDATE(state) ON forum_versions_v1 TO galaxy_api;
GRANT UPDATE(state,revision) ON forum_replies_v1 TO galaxy_api;
GRANT UPDATE(revoked_at) ON forum_permissions_v1 TO galaxy_api;
GRANT UPDATE(version,state,appeal_count,decision_event_id,restriction_event_id,restriction_until,closed_at,audit_until) ON forum_reports_v1 TO galaxy_api;
GRANT UPDATE(used) ON forum_daily_usage_v1 TO galaxy_api;
GRANT UPDATE(revocation_kind,revocation_control_event_id,revocation_request_id) ON bindings TO galaxy_api;

-- Persistent public account sessions and separate operator authentication.
GRANT SELECT,INSERT,DELETE ON oidc_login_transactions_v1 TO galaxy_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON official_account_logins_v1,official_account_sessions_v1,
  operations_operator_logins_v1,operations_operator_sessions_v1 TO galaxy_api;
GRANT SELECT,INSERT ON operations_operator_principals_v1 TO galaxy_api;
GRANT UPDATE(display_name,updated_at) ON operations_operator_principals_v1 TO galaxy_api;
GRANT SELECT,INSERT ON business_admin_audit_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE business_admin_audit_v1_sequence_seq TO galaxy_api;
GRANT UPDATE(restricted_until,restriction_reason,restriction_revision) ON community_accounts TO galaxy_api;
GRANT UPDATE(state,attempts,lease_id,locked_until,available_at,search_recovery_count,search_recovery_generation,search_recovery_at) ON jobs TO galaxy_api;

-- pg-boss runtime DML only; its schema/queues are installed by migration 93.
GRANT USAGE ON SCHEMA galaxy_jobs TO galaxy_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA galaxy_jobs TO galaxy_api;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA galaxy_jobs TO galaxy_api;
GRANT EXECUTE ON FUNCTION galaxy_jobs.job_now() TO galaxy_api;
GRANT USAGE ON TYPE galaxy_jobs.job_state TO galaxy_api;
GRANT SELECT,INSERT ON site_publications_v1 TO galaxy_api;
GRANT UPDATE(job_id,state,error,updated_at) ON site_publications_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE site_publications_v1_sequence_seq TO galaxy_api;
GRANT SELECT,INSERT ON account_chat_reports_v1,account_chat_governance_events_v1,account_chat_governance_materials_v1 TO galaxy_api;
GRANT UPDATE ON account_chat_reports_v1,account_chat_governance_events_v1,account_chat_governance_materials_v1 TO galaxy_api;

-- Operations business changes preserve immutable source authorizations.
GRANT SELECT,INSERT,UPDATE ON operations_content_visibility_v1 TO galaxy_api;
GRANT SELECT,INSERT ON forum_operations_events_v1 TO galaxy_api;
GRANT UPDATE(operations_disclosed) ON forum_reports_v1 TO galaxy_api;
GRANT UPDATE(operations_retry_revision) ON chat_attachments,forum_attachments_v1 TO galaxy_api;
GRANT SELECT,INSERT ON operations_product_commands_v1,operations_product_rules_v1 TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON operations_policy_processes_v1,operations_notices_v1,operations_retention_runs_v1 TO galaxy_api;
GRANT SELECT ON operations_retention_observations_v1 TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON account_operations_notices_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE account_operations_notices_v1_sequence_seq,operations_notices_v1_sequence_seq,operations_retention_runs_v1_sequence_seq TO galaxy_api;

-- Private ordinary feedback: prose and notes stay in their own immutable rows.
GRANT SELECT,INSERT ON operations_feedback_v1,operations_feedback_events_v1 TO galaxy_api;
GRANT UPDATE(category,module,state,revision,updated_at) ON operations_feedback_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_feedback_v1_sequence_seq,operations_feedback_events_v1_sequence_seq TO galaxy_api;

-- Exact owner-recorded feedback erasure; no general prose UPDATE or DELETE.
GRANT SELECT,INSERT ON account_feedback_data_operations_v1,account_feedback_data_items_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE account_feedback_data_operations_v1_sequence_seq TO galaxy_api;
GRANT EXECUTE ON FUNCTION public.galaxy_account_erase_feedback_data(text,uuid,uuid) TO galaxy_api;

-- Operator curation changes independent metadata, never signed publication bytes.
GRANT SELECT,INSERT ON operations_forum_curation_v1,operations_forum_tags_v1,operations_forum_content_events_v1 TO galaxy_api;
GRANT UPDATE(revision,source_version,topic,pinned,featured,tag_ids,operation_id,updated_at) ON operations_forum_curation_v1 TO galaxy_api;
GRANT UPDATE(name,normalized_name,revision,enabled,updated_at) ON operations_forum_tags_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_forum_content_events_v1_sequence_seq TO galaxy_api;

-- Private feedback files bind only to their account's exact submission.
GRANT SELECT,INSERT ON feedback_attachments_v1 TO galaxy_api;
GRANT UPDATE(state,uploaded_at,expires_at,feedback_id,bound_at,lease_id,lease_until,last_error,revoked_at,purge_pending) ON feedback_attachments_v1 TO galaxy_api;

-- One-case message visibility is independent of source messages and bodies.
GRANT SELECT,INSERT ON operations_chat_message_visibility_v1 TO galaxy_api;
GRANT UPDATE(message_revision,revision,hidden,current_event_id,updated_at) ON operations_chat_message_visibility_v1 TO galaxy_api;

-- Management business grants have one PG authority and immutable change events.
GRANT SELECT,INSERT ON operations_permission_authority_v1,operations_business_roles_v1,operations_role_assignments_v1,operations_automation_grants_v1,operations_permission_events_v1 TO galaxy_api;
GRANT UPDATE(version) ON operations_permission_authority_v1 TO galaxy_api;
GRANT UPDATE(name,description,enabled,version,permissions,updated_by,updated_at) ON operations_business_roles_v1 TO galaxy_api;
GRANT UPDATE(enabled,version,updated_by,updated_at) ON operations_role_assignments_v1 TO galaxy_api;
GRANT UPDATE(name,executor_kind,mode,enabled,version,permissions,resource_ids,resource_scope_kind,updated_by,updated_at) ON operations_automation_grants_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_permission_events_v1_sequence_seq TO galaxy_api;

-- Versioned official messaging. No delete or immutable-event rewriting.
GRANT SELECT,INSERT ON operations_messaging_plans_v1,operations_messaging_versions_v1,operations_messaging_commands_v1,operations_messaging_events_v1 TO galaxy_api;
GRANT UPDATE(version,revision,state,updated_by,approved_by,approved_role,approved_at,job_id,updated_at) ON operations_messaging_plans_v1 TO galaxy_api;
GRANT SELECT ON operations_messaging_runs_v1,operations_messaging_recipients_v1,operations_messaging_attempts_v1,operations_messaging_announcements_v1 TO galaxy_api;
GRANT UPDATE(revision,state,error_code,job_id,updated_at,completed_at) ON operations_messaging_runs_v1 TO galaxy_api;
GRANT UPDATE(state,attempt_id,attempt_count,lease_until,retry_at,message_id,error_code,retryable,submitted_at,completed_at,updated_at) ON operations_messaging_recipients_v1 TO galaxy_api;
GRANT UPDATE(state,error_code,finished_at) ON operations_messaging_attempts_v1 TO galaxy_api;
GRANT UPDATE(withdrawn_at) ON operations_messaging_announcements_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_messaging_plans_v1_sequence_seq,operations_messaging_events_v1_sequence_seq TO galaxy_api;
GRANT SELECT,INSERT ON operations_smtp_settings_v1,operations_smtp_commands_v1,operations_smtp_events_v1,operations_smtp_tests_v1 TO galaxy_api;
GRANT UPDATE(version,configuration,updated_by,updated_at) ON operations_smtp_settings_v1 TO galaxy_api;
GRANT UPDATE(state,code,finished_at) ON operations_smtp_tests_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_smtp_events_v1_sequence_seq,operations_smtp_tests_v1_sequence_seq TO galaxy_api;

-- The native Agno identity has no business-database access. The API rechecks
-- each request against current grants, task scope and source permissions.
GRANT SELECT ON operations_agentos_executions_v1 TO galaxy_api;
GRANT SELECT,INSERT ON operations_agentos_source_refs_v1,operations_agentos_commands_v1,operations_agentos_tool_calls_v1 TO galaxy_api;
GRANT UPDATE(state,revision,updated_at) ON operations_agentos_executions_v1 TO galaxy_api;
GRANT UPDATE(result) ON operations_agentos_commands_v1 TO galaxy_api;
GRANT UPDATE(state,result,code,completed_at) ON operations_agentos_tool_calls_v1 TO galaxy_api;

GRANT SELECT,INSERT ON discovery_usage_events_v1,discovery_delivery_outbox_v1,discovery_index_control_v1 TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON discovery_index_outbox_v1,discovery_feedback_v1 TO galaxy_api;

-- Recommendation policy and receipts cannot edit source content or old facts.
GRANT SELECT,INSERT ON operations_recommendation_policy_v1,operations_recommendation_themes_v1 TO galaxy_api;
GRANT UPDATE(revision,enabled,directions,controls,updated_at) ON operations_recommendation_policy_v1 TO galaxy_api;
GRANT UPDATE(label,enabled,revision,mapping,updated_at) ON operations_recommendation_themes_v1 TO galaxy_api;
GRANT SELECT,INSERT ON operations_recommendation_events_v1,discovery_recommendation_requests_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_recommendation_events_v1_sequence_seq,discovery_recommendation_requests_v1_sequence_seq TO galaxy_api;
-- Search quality version/native-task bridge, migration108. No immutable rows
-- can be rewritten or deleted, and the worker receives no settings authority.
GRANT SELECT,INSERT ON operations_search_quality_state_v1,operations_search_quality_versions_v1,operations_search_quality_operations_v1,discovery_search_requests_v1 TO galaxy_api;
GRANT UPDATE(revision,active_id,draft_id,pending_operation,updated_at) ON operations_search_quality_state_v1 TO galaxy_api;
GRANT UPDATE(phase,native_task_id,submitted_at,error_code,updated_at) ON operations_search_quality_operations_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_search_quality_operations_v1_sequence_seq TO galaxy_api;

-- Maintenance109: plans and append-only commands, no native DB credentials.
GRANT SELECT,INSERT ON operations_maintenance_plans_v1,operations_maintenance_events_v1 TO galaxy_api;
GRANT UPDATE(revision,state,approved_by,approved_at,approved_revision,updated_at,execution_id) ON operations_maintenance_plans_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_maintenance_events_v1_sequence_seq TO galaxy_api;

-- Human-only model configuration110. No provider secret or mutable intent.
GRANT SELECT,INSERT ON operations_model_settings_state_v1,operations_model_settings_versions_v1,operations_model_settings_operations_v1 TO galaxy_api;
GRANT UPDATE(revision,active_id,draft_id,pending_operation,updated_at) ON operations_model_settings_state_v1 TO galaxy_api;
GRANT UPDATE(phase,error_code,credential_ref,updated_at) ON operations_model_settings_operations_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_model_settings_operations_v1_sequence_seq TO galaxy_api;

-- P14 drafts/publication, immutable rule history and metadata-only decisions.
GRANT SELECT,INSERT ON operations_p14_rule_heads_v1,operations_p14_rule_versions_v1,operations_p14_rule_commands_v1,operations_p14_rule_events_v1,operations_p14_rule_decisions_v1 TO galaxy_api;
GRANT UPDATE(revision,active_id,draft_id,updated_at) ON operations_p14_rule_heads_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_p14_rule_events_v1_sequence_seq TO galaxy_api;
GRANT SELECT,INSERT ON operations_p13_strategy_heads_v1,operations_p13_strategy_versions_v1,operations_p13_strategy_commands_v1,operations_p13_strategy_rehearsals_v1,operations_p13_strategy_runs_v1,operations_p13_strategy_events_v1 TO galaxy_api;
GRANT UPDATE(revision,active_id,draft_id,paused,blocked_version_ids,updated_at) ON operations_p13_strategy_heads_v1 TO galaxy_api;
GRANT UPDATE(state,native_run_id,approved_by,approval_native_run_id,decision,effect_result,code,updated_at) ON operations_p13_strategy_runs_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_p13_strategy_events_v1_sequence_seq TO galaxy_api;

-- A human conversation cannot mint an unattended execution grant. Typed
-- business cards retain the owner's exact confirmation and original effect ID.
GRANT SELECT ON operations_agentos_conversations_v1 TO galaxy_api;
GRANT UPDATE(retired_at,retirement_reason) ON operations_agentos_conversations_v1 TO galaxy_api;
GRANT SELECT,INSERT ON operations_agentos_conversation_commands_v1 TO galaxy_api;
GRANT UPDATE(state,result,native_run_id) ON operations_agentos_conversation_commands_v1 TO galaxy_api;
GRANT SELECT,INSERT ON operations_agentos_conversation_tool_calls_v1,operations_agentos_conversation_sources_v1,operations_agentos_conversation_cards_v1 TO galaxy_api;
GRANT UPDATE(state,metadata,updated_at) ON operations_agentos_conversation_tool_calls_v1 TO galaxy_api;
GRANT UPDATE(state,result,updated_at) ON operations_agentos_conversation_cards_v1 TO galaxy_api;

-- Concrete legacy cleanup: API plans/approvals cannot rewrite fixed selections
-- or forge worker attempts/results. Cancellation records only its own outcome.
GRANT SELECT,INSERT ON operations_file_cleanup_plans_v1,operations_file_cleanup_items_v1 TO galaxy_api;
GRANT UPDATE(revision,state,approved_by,approved_at,cancelled_by,cancelled_at) ON operations_file_cleanup_plans_v1 TO galaxy_api;
GRANT UPDATE(state,result_code,completed_at) ON operations_file_cleanup_items_v1 TO galaxy_api;

-- A reversible access overlay does not grant deletion or scan-state changes.
GRANT SELECT,INSERT ON operations_file_access_heads_v1,operations_file_access_events_v1 TO galaxy_api;
GRANT UPDATE(revision,stopped_until,operation_id,operator_id,reason,updated_at) ON operations_file_access_heads_v1 TO galaxy_api;

-- Registered-user121 reads the complete derived directory. An original command
-- can update only its result/state, never replace its owner, target or input.
GRANT SELECT ON operations_registered_subjects_v1,operations_registered_generations_v1,operations_registered_entries_v1,operations_registered_directory_v1,operations_registered_commands_v1 TO galaxy_api;
GRANT INSERT(operation_id,endpoint,operator_id,registration_id,kind,state,input,result,created_at,updated_at) ON operations_registered_commands_v1 TO galaxy_api;
GRANT UPDATE(state,result,updated_at) ON operations_registered_commands_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_registered_commands_v1_sequence_seq TO galaxy_api;
GRANT SELECT,INSERT ON operations_registered_login_fences_v1 TO galaxy_api;
GRANT UPDATE(revoked_before) ON operations_registered_login_fences_v1 TO galaxy_api;

-- Management122 uses the independent management realm. This role receives
-- bounded lifecycle/command writes, not root configuration or credential data.
GRANT SELECT,INSERT ON operations_management_accounts_v1 TO galaxy_api;
GRANT UPDATE(version,note,login_blocked,deleted_at,updated_at) ON operations_management_accounts_v1 TO galaxy_api;
GRANT SELECT,INSERT,DELETE ON operations_management_generations_v1 TO galaxy_api;
GRANT UPDATE(state,completed_at,observed_count,source_count_before,source_count_after,code) ON operations_management_generations_v1 TO galaxy_api;
GRANT SELECT,INSERT ON operations_management_entries_v1 TO galaxy_api;
GRANT SELECT,INSERT ON operations_management_directory_v1 TO galaxy_api;
GRANT UPDATE(issuer,generation_id,sync_id,lease_until,last_started_at,last_completed_at,last_error) ON operations_management_directory_v1 TO galaxy_api;
GRANT SELECT ON operations_management_commands_v1 TO galaxy_api;
GRANT INSERT(operation_id,endpoint,operator_id,target_operator_id,kind,state,input,result,created_at,updated_at) ON operations_management_commands_v1 TO galaxy_api;
GRANT UPDATE(target_operator_id,state,result,updated_at) ON operations_management_commands_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_management_commands_v1_sequence_seq TO galaxy_api;
GRANT SELECT,INSERT ON operations_management_login_fences_v1 TO galaxy_api;
GRANT UPDATE(revoked_before) ON operations_management_login_fences_v1 TO galaxy_api;

-- AI123: existing five identities are initialized only by explicit deployment.
-- No API identity creation/deletion. Conversation/execution bindings cannot
-- UPDATE; the explicit grant-editor column permission is isolated below.
GRANT SELECT ON operations_ai_work_accounts_v1,operations_ai_work_assignments_v1,operations_ai_work_commands_v1 TO galaxy_api;
GRANT UPDATE(name,description,enabled,version,authorization_version,updated_at) ON operations_ai_work_accounts_v1 TO galaxy_api;
GRANT INSERT(id,endpoint,ai_account_id,role_id,enabled,version,created_at,updated_at) ON operations_ai_work_assignments_v1 TO galaxy_api;
GRANT UPDATE(enabled,version,updated_at) ON operations_ai_work_assignments_v1 TO galaxy_api;
GRANT INSERT(endpoint,operation_id,ai_account_id,domain,operator_id,kind,selection,result,reason,created_at) ON operations_ai_work_commands_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_ai_work_commands_v1_sequence_seq TO galaxy_api;
-- Remove any prior table-wide INSERT before installing explicit immutable inserts.
REVOKE INSERT ON operations_agentos_conversations_v1,operations_agentos_executions_v1 FROM galaxy_api;
GRANT INSERT(id,endpoint,operator_id,domain,permission_key,session_id,created_at,retired_at,retirement_reason,ai_account_id) ON operations_agentos_conversations_v1 TO galaxy_api;
GRANT INSERT(id,endpoint,grant_id,grant_version,domain,executor_kind,mode,operator_id,created_by,actions,resource_ids,state,revision,session_id,prepared_command,created_at,updated_at,ai_account_id) ON operations_agentos_executions_v1 TO galaxy_api;

-- The existing human-only authorization editor now explicitly binds a grant
-- to a current AI work identity. Conversation/execution bindings stay immutable.
GRANT UPDATE(ai_account_id) ON operations_automation_grants_v1 TO galaxy_api;


-- System124: public settings versions and original-result reconciliation only.
-- Secret values are held by the protected host and are never stored here.
GRANT SELECT ON operations_system_settings_versions_v1,operations_system_settings_commands_v1,operations_system_settings_heads_v1,operations_system_general_publications_v1 TO galaxy_api;
GRANT INSERT(id,endpoint,section,revision,configuration,operator_id,created_at) ON operations_system_settings_versions_v1 TO galaxy_api;
GRANT INSERT(endpoint,operation_id,operator_id,operator_role,section,kind,input,version_id,revision,state,result,created_at,updated_at) ON operations_system_settings_commands_v1 TO galaxy_api;
GRANT UPDATE(state,result,updated_at) ON operations_system_settings_commands_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_system_settings_commands_v1_sequence_seq TO galaxy_api;
GRANT INSERT(endpoint,section,revision,version_id,pending_operation,updated_at) ON operations_system_settings_heads_v1 TO galaxy_api;
GRANT UPDATE(revision,version_id,pending_operation,updated_at) ON operations_system_settings_heads_v1 TO galaxy_api;
GRANT INSERT(endpoint,operation_id,operator_id,input,publication_id,result,created_at) ON operations_system_general_publications_v1 TO galaxy_api;
GRANT UPDATE(base_publication_id) ON site_publications_v1 TO galaxy_api;

-- Account125: owner-scoped choices and immutable metadata-only receipts.
GRANT SELECT ON account_follows_v1,account_follow_operations_v1 TO galaxy_api;
GRANT INSERT(id,account_id,target_account_id,following,revision,created_at,followed_at,updated_at) ON account_follows_v1 TO galaxy_api;
GRANT UPDATE(following,revision,followed_at,updated_at) ON account_follows_v1 TO galaxy_api;
GRANT INSERT(account_id,operation_id,request_hash,result,created_at) ON account_follow_operations_v1 TO galaxy_api;

-- Proposed schema127: only this non-authorizing registration source.
GRANT SELECT ON official_account_registrations_v1 TO galaxy_api;
GRANT INSERT(account_id,uid,endpoint,issuer,external_subject,created_at,updated_at) ON official_account_registrations_v1 TO galaxy_api;
GRANT UPDATE(display_name,avatar_key,bio,preset_revision,preset_updated_by,updated_at,adopted_at) ON official_account_registrations_v1 TO galaxy_api;

-- Autonomy129: plan/prompt/task state. No identity or model credential changes.
GRANT SELECT,INSERT,UPDATE ON operations_autonomy_configs_v1,operations_autonomy_tasks_v1 TO galaxy_api;
GRANT SELECT,INSERT ON operations_autonomy_versions_v1,operations_autonomy_commands_v1 TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON operations_autonomy_events_v1,operations_autonomy_receipts_v1,operations_autonomy_tool_calls_v1 TO galaxy_api;
GRANT SELECT ON operations_autonomy_health_v1 TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON operations_ai_role_delegations_v1 TO galaxy_api;
GRANT SELECT,INSERT ON operations_ai_role_delegation_events_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_ai_role_delegation_events_v1_sequence_seq TO galaxy_api;
GRANT UPDATE(subject_scope,created_by,updated_by,created_by_ai_account_id,updated_by_ai_account_id,managed_ai_account_ids) ON operations_business_roles_v1 TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON operations_ai_duty_operations_v1 TO galaxy_api;
GRANT UPDATE(approved_ai) ON operations_messaging_plans_v1 TO galaxy_api;
GRANT INSERT(approved_ai) ON operations_messaging_runs_v1 TO galaxy_api;
GRANT INSERT(actor_kind,ai_context) ON operations_messaging_events_v1 TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON operations_autonomy_strategy_schedules_v1 TO galaxy_api;
GRANT SELECT,INSERT ON operations_autonomy_event_consumers_v1 TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON operations_autonomy_runtime_v1 TO galaxy_api;
GRANT SELECT,INSERT ON operations_autonomy_runtime_versions_v1 TO galaxy_api;
GRANT SELECT,INSERT ON operations_autonomy_decisions_v1 TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON operations_autonomy_workbench_runs_v1 TO galaxy_api;
GRANT EXECUTE ON FUNCTION public.galaxy_autonomy_workbench_pending_v1(text,uuid),public.galaxy_autonomy_workbench_receipts_v1(text,uuid) TO galaxy_api;
GRANT EXECUTE ON FUNCTION public.galaxy_autonomy_lock_persisted_authority_v1(text,uuid) TO galaxy_api;

-- Web change delivery: only the fixed promotion function writes the technical log.
GRANT SELECT ON web_event_sequence_v1,web_event_log_v1 TO galaxy_api;
GRANT EXECUTE ON FUNCTION public.galaxy_web_events_promote_v1(integer) TO galaxy_api;

GRANT EXECUTE ON FUNCTION public.galaxy_autonomy_workbench_card_states_v1(text,uuid) TO galaxy_api;
