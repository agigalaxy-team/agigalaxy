
ALTER TABLE bindings ADD COLUMN revocation_kind text CHECK(revocation_kind IN ('explicit-binding','device-revoked','recovery'));
ALTER TABLE bindings ADD COLUMN revocation_control_event_id uuid;
ALTER TABLE bindings ADD COLUMN revocation_request_id uuid;
CREATE TABLE forum_posts_v1(
 id uuid PRIMARY KEY,subject_id text REFERENCES subjects(id),account_id uuid REFERENCES community_accounts(id),
 head_version integer NOT NULL CHECK(head_version>0),current_version_id uuid,state text NOT NULL CHECK(state IN ('published','withdrawn')),
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,erased_at timestamptz);
CREATE TABLE forum_events_v1(
 id uuid PRIMARY KEY,subject_id text REFERENCES subjects(id),account_id uuid REFERENCES community_accounts(id),
 kind text NOT NULL,post_id uuid,version_id uuid,reply_id uuid,consent_id uuid REFERENCES consents(id),
 payload_text text NOT NULL,payload_hash text NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'),result jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL,erased_at timestamptz);
CREATE TABLE forum_permissions_v1(
 id uuid PRIMARY KEY,subject_id text REFERENCES subjects(id),account_id uuid REFERENCES community_accounts(id),event_id uuid NOT NULL,
 consent_id uuid REFERENCES consents(id),origin_binding_id uuid REFERENCES bindings(id),source_device_id uuid,source_key_id text,
 accepted_epoch integer NOT NULL,accepted_control_hash text,signer_public_key text NOT NULL,signature_hash text NOT NULL,
 payload_hash text NOT NULL,action text NOT NULL,object_id text NOT NULL,visibility text NOT NULL CHECK(visibility IN ('Public','Private')),
 fields jsonb NOT NULL,viewers jsonb NOT NULL,issued_at timestamptz NOT NULL,published_until timestamptz NOT NULL,
 accepted_at timestamptz NOT NULL,authorization_audit_until timestamptz NOT NULL,revoked_at timestamptz,erased_at timestamptz,policy_hash text NOT NULL);
CREATE TABLE forum_versions_v1(
 id uuid PRIMARY KEY,post_id uuid NOT NULL REFERENCES forum_posts_v1(id),subject_id text REFERENCES subjects(id),account_id uuid REFERENCES community_accounts(id),
 version_number integer NOT NULL CHECK(version_number>0),publication_event_id uuid REFERENCES forum_events_v1(id) ON DELETE SET NULL,
 permission_id uuid REFERENCES forum_permissions_v1(id) ON DELETE SET NULL,payload_hash text NOT NULL,published_until timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN ('published','withdrawn')),created_at timestamptz NOT NULL,erased_at timestamptz,UNIQUE(post_id,version_number));
ALTER TABLE forum_posts_v1 ADD CONSTRAINT forum_posts_current_version_fk FOREIGN KEY(current_version_id) REFERENCES forum_versions_v1(id) ON DELETE SET NULL;
CREATE TABLE forum_replies_v1(
 id uuid PRIMARY KEY,post_id uuid NOT NULL REFERENCES forum_posts_v1(id),post_version_id uuid NOT NULL REFERENCES forum_versions_v1(id),
 reply_to_id uuid REFERENCES forum_replies_v1(id),subject_id text REFERENCES subjects(id),account_id uuid REFERENCES community_accounts(id),
 content_revision integer NOT NULL DEFAULT 1 CHECK(content_revision=1),revision integer NOT NULL CHECK(revision IN (1,2)),
 publication_event_id uuid REFERENCES forum_events_v1(id) ON DELETE SET NULL,permission_id uuid REFERENCES forum_permissions_v1(id) ON DELETE SET NULL,
 payload_hash text NOT NULL,published_until timestamptz NOT NULL,state text NOT NULL CHECK(state IN ('published','withdrawn')),created_at timestamptz NOT NULL,erased_at timestamptz);
CREATE TABLE forum_reports_v1(
 id uuid PRIMARY KEY,subject_id text REFERENCES subjects(id),reporter_id text REFERENCES subjects(id),account_id uuid REFERENCES community_accounts(id),
 target jsonb NOT NULL,target_author_id text REFERENCES subjects(id),version integer NOT NULL CHECK(version>0),
 state text NOT NULL CHECK(state IN ('pending','resolved','appealed','withdrawn')),appeal_count integer NOT NULL DEFAULT 0 CHECK(appeal_count BETWEEN 0 AND 3),
 decision_event_id uuid,restriction_event_id uuid,restriction_until timestamptz,created_at timestamptz NOT NULL,closed_at timestamptz,audit_until timestamptz);
CREATE TABLE forum_governance_events_v1(
 id uuid PRIMARY KEY,operation_id uuid NOT NULL UNIQUE,report_id uuid NOT NULL REFERENCES forum_reports_v1(id),subject_id text REFERENCES subjects(id),account_id uuid REFERENCES community_accounts(id),
 version integer NOT NULL CHECK(version>0),kind text NOT NULL,consent_id uuid REFERENCES consents(id),permission_id uuid REFERENCES forum_permissions_v1(id) ON DELETE SET NULL,
 payload_text text NOT NULL,payload_hash text NOT NULL,created_at timestamptz NOT NULL,erased_at timestamptz,
 resolution text,effect_until timestamptz,result jsonb NOT NULL DEFAULT '{}',UNIQUE(report_id,version));
CREATE TABLE forum_daily_usage_v1(
 account_id uuid NOT NULL REFERENCES community_accounts(id),day date NOT NULL,category text NOT NULL CHECK(category IN ('post','version','reply','report')),
 used integer NOT NULL CHECK(used>0),PRIMARY KEY(account_id,day,category));
CREATE TABLE forum_write_receipts_v1(
 operation_id uuid PRIMARY KEY,subject_id text REFERENCES subjects(id),account_id uuid REFERENCES community_accounts(id),category text,
 payload_hash text NOT NULL,consent_id uuid REFERENCES consents(id),locator jsonb NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL,retained_until timestamptz NOT NULL);
CREATE INDEX forum_posts_owner_v1 ON forum_posts_v1(subject_id,id);
CREATE INDEX forum_versions_post_v1 ON forum_versions_v1(post_id,version_number);
CREATE INDEX forum_replies_target_v1 ON forum_replies_v1(post_id,post_version_id,id);
CREATE INDEX forum_permissions_expiry_v1 ON forum_permissions_v1(published_until,id);
CREATE INDEX forum_reports_parties_v1 ON forum_reports_v1(target_author_id,reporter_id,id);
CREATE INDEX forum_governance_report_v1 ON forum_governance_events_v1(report_id,version);
-- Maintenance can remove only forum authorization no longer used by any
-- forum source/receipt. It receives counts, never a key or signed payload,
-- and has no general DELETE privilege on global Consent or control tables.
CREATE FUNCTION public.galaxy_worker_prune_forum_authorizations(before_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE permit record; permissions_count integer:=0;consents_count integer:=0;audits_count integer:=0;n integer;
 effective_before timestamptz:=LEAST(COALESCE(before_at,transaction_timestamp()),transaction_timestamp());
BEGIN
 FOR permit IN SELECT p.id,p.consent_id FROM public.forum_permissions_v1 p WHERE p.authorization_audit_until<=effective_before
  AND p.published_until<=effective_before
  AND NOT EXISTS(SELECT 1 FROM public.forum_events_v1 e WHERE e.id=p.event_id)
  AND NOT EXISTS(SELECT 1 FROM public.forum_versions_v1 v WHERE v.permission_id=p.id)
  AND NOT EXISTS(SELECT 1 FROM public.forum_replies_v1 r WHERE r.permission_id=p.id)
  AND NOT EXISTS(SELECT 1 FROM public.forum_governance_events_v1 e WHERE e.permission_id=p.id)
  AND (p.consent_id IS NULL OR EXISTS(SELECT 1 FROM public.consents c WHERE c.id=p.consent_id AND c.intent->>'action' IN
    ('forum.post.publish','forum.reply.publish','forum.withdraw','forum.report.publish','forum.report.event','forum.governance.resolve'))
   AND NOT EXISTS(SELECT 1 FROM public.forum_permissions_v1 other WHERE other.consent_id=p.consent_id AND other.id<>p.id)
   AND NOT EXISTS(SELECT 1 FROM public.forum_events_v1 e WHERE e.consent_id=p.consent_id)
   AND NOT EXISTS(SELECT 1 FROM public.forum_governance_events_v1 e WHERE e.consent_id=p.consent_id)
   AND NOT EXISTS(SELECT 1 FROM public.forum_write_receipts_v1 r WHERE r.consent_id=p.consent_id))
  ORDER BY p.published_until,p.id LIMIT 100 FOR UPDATE OF p
 LOOP
  IF permit.consent_id IS NOT NULL THEN
   -- Fresh source capture takes a Consent share lock. Serialize with it and
   -- recheck all references before erasing the discoverable permit locator.
   PERFORM 1 FROM public.consents c WHERE c.id=permit.consent_id FOR UPDATE;
   IF EXISTS(SELECT 1 FROM public.forum_permissions_v1 p WHERE p.consent_id=permit.consent_id AND p.id<>permit.id)
    OR EXISTS(SELECT 1 FROM public.forum_events_v1 e WHERE e.consent_id=permit.consent_id)
    OR EXISTS(SELECT 1 FROM public.forum_governance_events_v1 e WHERE e.consent_id=permit.consent_id)
    OR EXISTS(SELECT 1 FROM public.forum_write_receipts_v1 r WHERE r.consent_id=permit.consent_id) THEN CONTINUE;END IF;
  END IF;
  DELETE FROM public.forum_permissions_v1 WHERE id=permit.id;permissions_count:=permissions_count+1;
  IF permit.consent_id IS NOT NULL THEN
   DELETE FROM public.audit_events WHERE consent_id=permit.consent_id AND action IN ('consent.create','consent.revoke','forum.post.publish','forum.reply.publish','forum.withdraw','forum.report.publish','forum.report.event','forum.governance.resolve');
   GET DIAGNOSTICS n=ROW_COUNT;audits_count:=audits_count+n;
   DELETE FROM public.consents WHERE id=permit.consent_id;GET DIAGNOSTICS n=ROW_COUNT;consents_count:=consents_count+n;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('permissions',permissions_count,'consents',consents_count,'audits',audits_count);
END;
$$;
REVOKE ALL ON FUNCTION public.galaxy_worker_prune_forum_authorizations(timestamptz) FROM PUBLIC;
-- Closed-case retention needs a row lock, but the worker must not receive any
-- report transition UPDATE right. This returns only eligible opaque IDs.
CREATE FUNCTION public.galaxy_worker_lock_closed_forum_reports(checked_at timestamptz)
RETURNS TABLE(id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT r.id FROM public.forum_reports_v1 r
 WHERE r.audit_until<=LEAST(COALESCE(checked_at,transaction_timestamp()),transaction_timestamp())
  AND (r.restriction_until IS NULL OR r.restriction_until<=LEAST(COALESCE(checked_at,transaction_timestamp()),transaction_timestamp()))
  AND r.state IN ('resolved','withdrawn') ORDER BY r.audit_until,r.id LIMIT 100 FOR UPDATE OF r;
$$;
REVOKE ALL ON FUNCTION public.galaxy_worker_lock_closed_forum_reports(timestamptz) FROM PUBLIC;
