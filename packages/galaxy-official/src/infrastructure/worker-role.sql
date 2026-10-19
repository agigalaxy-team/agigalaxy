-- Explicit administrative provisioning, after schema migrations. Never run on API startup.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='galaxy_evidence_worker') THEN
    CREATE ROLE galaxy_evidence_worker NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO galaxy_evidence_worker;
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
 WHERE r.id=request_id AND c.id=case_id AND r.state<>'revoked' FOR SHARE OF c;
$$;
CREATE OR REPLACE FUNCTION public.galaxy_worker_lock_ci_record(request_id uuid,record_id uuid)
RETURNS SETOF public.verification_objects LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT o.* FROM public.verification_objects o JOIN public.ci_requests_v2 r ON r.case_id=o.case_id
 WHERE r.id=request_id AND o.id=record_id AND r.state<>'revoked' FOR SHARE OF o;
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
