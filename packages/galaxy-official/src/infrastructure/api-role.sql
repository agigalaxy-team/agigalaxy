-- Explicit administrative provisioning after migrations; the API is not a schema owner.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='galaxy_api') THEN CREATE ROLE galaxy_api NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO galaxy_api;
GRANT SELECT,INSERT ON task_materials_v1 TO galaxy_api;
GRANT UPDATE(body_text,erased_at) ON task_materials_v1 TO galaxy_api;
GRANT SELECT,INSERT ON chat_attachments TO galaxy_api;
GRANT SELECT,INSERT ON outcome_materials_v2,outcome_material_events_v2 TO galaxy_api;
GRANT UPDATE(state,approval_id,revision,approved_at,expires_at,body_text,name,media_type,byte_size,scan_result,last_error,purge_pending,purged_at) ON outcome_materials_v2 TO galaxy_api;
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
