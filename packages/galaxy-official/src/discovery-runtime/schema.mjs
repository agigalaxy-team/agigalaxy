// Registry owner assigns this source to migration 106. No retention/default
// cache policy or deletion consumer is introduced here.
export const discoveryRuntimeMigrationSql=`
CREATE TABLE discovery_usage_events_v1(
 endpoint text NOT NULL,id uuid NOT NULL,account_id uuid,visitor_id uuid NOT NULL,
 profile_id text NOT NULL,name text NOT NULL CHECK(name IN ('pageview','content-view','content-click','content-exposure','content-bookmark','content-participate','search','search-click','not-interested')),
 purpose text NOT NULL CHECK(purpose='site-usage-analytics'),payload jsonb NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,id)
);
CREATE INDEX discovery_usage_account_time_v1 ON discovery_usage_events_v1(endpoint,account_id,created_at);
CREATE TABLE discovery_delivery_outbox_v1(
 endpoint text NOT NULL,event_id uuid NOT NULL,target text NOT NULL CHECK(target IN ('openpanel','gorse')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','result-unknown','delivered','excluded')),
 attempts integer NOT NULL DEFAULT 0,submission_started boolean NOT NULL DEFAULT false,next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_id uuid,lease_until timestamptz,last_error text,
 PRIMARY KEY(endpoint,event_id,target),FOREIGN KEY(endpoint,event_id) REFERENCES discovery_usage_events_v1(endpoint,id)
);
CREATE INDEX discovery_delivery_due_v1 ON discovery_delivery_outbox_v1(endpoint,next_attempt_at) WHERE state IN ('pending','leased','result-unknown');
CREATE TABLE discovery_index_control_v1(endpoint text PRIMARY KEY,scan_after text NOT NULL DEFAULT '',scan_complete boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE discovery_index_outbox_v1(
 endpoint text NOT NULL,kind text NOT NULL CHECK(kind IN ('post','reply')),source_id uuid NOT NULL,
 generation bigint NOT NULL DEFAULT 1,applied_generation bigint NOT NULL DEFAULT 0,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','applied','failed')),
 lease_id uuid,lease_until timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 0,
 indexed_version text,source_expires_at timestamptz,last_error text,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(endpoint,kind,source_id)
);
CREATE INDEX discovery_index_due_v1 ON discovery_index_outbox_v1(endpoint,next_attempt_at) WHERE state IN ('pending','leased','failed');
CREATE TABLE discovery_feedback_v1(endpoint text NOT NULL,profile_id text NOT NULL,item_key text NOT NULL,negative boolean NOT NULL,updated_at timestamptz NOT NULL,PRIMARY KEY(endpoint,profile_id,item_key));
CREATE FUNCTION galaxy_discovery_source_changed_v1() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE source_kind text;source_identifier uuid;
BEGIN
 source_kind:=CASE WHEN TG_TABLE_NAME='forum_replies_v1' THEN 'reply' ELSE 'post' END;
 source_identifier:=CASE WHEN TG_TABLE_NAME='forum_versions_v1' THEN COALESCE((to_jsonb(NEW)->>'post_id')::uuid,(to_jsonb(OLD)->>'post_id')::uuid) ELSE COALESCE((to_jsonb(NEW)->>'id')::uuid,(to_jsonb(OLD)->>'id')::uuid) END;
 INSERT INTO discovery_index_outbox_v1(endpoint,kind,source_id)
 SELECT endpoint,source_kind,source_identifier FROM discovery_index_control_v1
 ON CONFLICT(endpoint,kind,source_id) DO UPDATE SET generation=discovery_index_outbox_v1.generation+1,state='pending',next_attempt_at=now(),updated_at=now();
 IF source_kind='post' THEN
  INSERT INTO discovery_index_outbox_v1(endpoint,kind,source_id)
  SELECT c.endpoint,'reply',r.id FROM discovery_index_control_v1 c CROSS JOIN forum_replies_v1 r WHERE r.post_id=source_identifier
  ON CONFLICT(endpoint,kind,source_id) DO UPDATE SET generation=discovery_index_outbox_v1.generation+1,state='pending',next_attempt_at=now(),updated_at=now();
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION galaxy_discovery_source_changed_v1() FROM PUBLIC;
CREATE TRIGGER discovery_post_changed_v1 AFTER INSERT OR UPDATE OR DELETE ON forum_posts_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_discovery_source_changed_v1();
CREATE TRIGGER discovery_version_changed_v1 AFTER INSERT OR UPDATE OR DELETE ON forum_versions_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_discovery_source_changed_v1();
CREATE TRIGGER discovery_reply_changed_v1 AFTER INSERT OR UPDATE OR DELETE ON forum_replies_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_discovery_source_changed_v1();
CREATE FUNCTION galaxy_discovery_visibility_changed_v1() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 INSERT INTO discovery_index_outbox_v1(endpoint,kind,source_id)
 SELECT c.endpoint,s.kind,s.id FROM discovery_index_control_v1 c CROSS JOIN
 (SELECT 'post' AS kind,id FROM forum_posts_v1 UNION ALL SELECT 'reply',id FROM forum_replies_v1) s
 ON CONFLICT(endpoint,kind,source_id) DO UPDATE SET generation=discovery_index_outbox_v1.generation+1,state='pending',next_attempt_at=now(),updated_at=now();
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION galaxy_discovery_visibility_changed_v1() FROM PUBLIC;
CREATE TRIGGER discovery_permission_changed_v1 AFTER UPDATE OR DELETE ON forum_permissions_v1 FOR EACH STATEMENT EXECUTE FUNCTION galaxy_discovery_visibility_changed_v1();
CREATE TRIGGER discovery_section_changed_v1 AFTER UPDATE OR DELETE ON forum_sections_v2 FOR EACH STATEMENT EXECUTE FUNCTION galaxy_discovery_visibility_changed_v1();
CREATE TRIGGER discovery_governance_changed_v1 AFTER INSERT OR UPDATE OR DELETE ON forum_governance_events_v1 FOR EACH STATEMENT EXECUTE FUNCTION galaxy_discovery_visibility_changed_v1();
CREATE TRIGGER discovery_visibility_changed_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_content_visibility_v1 FOR EACH STATEMENT EXECUTE FUNCTION galaxy_discovery_visibility_changed_v1();
CREATE TRIGGER discovery_curation_changed_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_forum_curation_v1 FOR EACH STATEMENT EXECUTE FUNCTION galaxy_discovery_visibility_changed_v1();
CREATE TRIGGER discovery_tag_changed_v1 AFTER UPDATE OR DELETE ON operations_forum_tags_v1 FOR EACH STATEMENT EXECUTE FUNCTION galaxy_discovery_visibility_changed_v1();
CREATE TRIGGER discovery_binding_changed_v1 AFTER UPDATE OR DELETE ON bindings FOR EACH STATEMENT EXECUTE FUNCTION galaxy_discovery_visibility_changed_v1();
CREATE TRIGGER discovery_consent_changed_v1 AFTER UPDATE OR DELETE ON consents FOR EACH STATEMENT EXECUTE FUNCTION galaxy_discovery_visibility_changed_v1();
CREATE TRIGGER discovery_deletion_changed_v1 AFTER INSERT OR UPDATE OR DELETE ON deletion_requests FOR EACH STATEMENT EXECUTE FUNCTION galaxy_discovery_visibility_changed_v1();
`;

export const discoveryRuntimeApiGrantsSql=`
GRANT SELECT,INSERT ON discovery_usage_events_v1,discovery_delivery_outbox_v1,discovery_index_control_v1 TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON discovery_index_outbox_v1,discovery_feedback_v1 TO galaxy_api;
`;
export const discoveryRuntimeWorkerGrantsSql=`
GRANT SELECT ON discovery_usage_events_v1 TO galaxy_evidence_worker;
GRANT SELECT,UPDATE ON discovery_delivery_outbox_v1 TO galaxy_evidence_worker;
GRANT SELECT,INSERT,UPDATE ON discovery_index_control_v1,discovery_index_outbox_v1 TO galaxy_evidence_worker;
GRANT SELECT ON operations_forum_curation_v1,operations_forum_tags_v1 TO galaxy_evidence_worker;
GRANT SELECT(signer_public_key) ON forum_permissions_v1 TO galaxy_evidence_worker;
GRANT SELECT(account_id,subject_id,identity_link_id) ON community_account_links TO galaxy_evidence_worker;
GRANT SELECT(id,issuer,client_id,revoked_at) ON external_identity_links TO galaxy_evidence_worker;
`;
