// Concrete, immutable legacy-file selections. No attachment FK: owner deletion
// and the existing metadata lifetime must not be held open by an operations plan.
export const operationsFileCleanupV1Sql=`
CREATE TABLE operations_file_cleanup_plans_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,revision integer NOT NULL CHECK(revision>0),
 state text NOT NULL CHECK(state IN('awaiting-approval','queued','running','completed','attention','cancelled')),
 created_by text NOT NULL,created_at timestamptz NOT NULL,reason text NOT NULL,
 approved_by text,approved_at timestamptz,cancelled_by text,cancelled_at timestamptz,completed_at timestamptz,
 item_count integer NOT NULL CHECK(item_count BETWEEN 1 AND 50),declared_bytes bigint NOT NULL CHECK(declared_bytes>=0),
 UNIQUE(endpoint,id)
);
CREATE TABLE operations_file_cleanup_items_v1(
 plan_id uuid NOT NULL REFERENCES operations_file_cleanup_plans_v1(id),position integer NOT NULL CHECK(position>=0),
 kind text NOT NULL CHECK(kind IN('chat','forum')),file_id uuid NOT NULL,
 expected_version text NOT NULL,reference_state jsonb NOT NULL,
 reason text NOT NULL CHECK(reason IN('expired','unreferenced')),byte_size bigint NOT NULL CHECK(byte_size>0),expires_at timestamptz,
 state text NOT NULL CHECK(state IN('pending','removing','removed','skipped','result-unknown')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),attempt_id uuid,attempted_at timestamptz,next_attempt_at timestamptz,
 result_code text,object_removed boolean,completed_at timestamptz,
 PRIMARY KEY(plan_id,position),UNIQUE(plan_id,kind,file_id)
);
CREATE INDEX operations_file_cleanup_plans_page_v1 ON operations_file_cleanup_plans_v1(endpoint,id);
CREATE INDEX operations_file_cleanup_work_v1 ON operations_file_cleanup_plans_v1(state,created_at,id) WHERE state IN('queued','running');
-- Row locks require UPDATE privileges even when they return no content. Keep
-- that right inside this exact approved-item function, never on worker roles.
CREATE FUNCTION public.galaxy_worker_lock_file_cleanup_sources(selected_endpoint text,selected_plan uuid,selected_kind text,selected_file uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.operations_file_cleanup_plans_v1 p JOIN public.operations_file_cleanup_items_v1 i ON i.plan_id=p.id
  WHERE p.endpoint=selected_endpoint AND p.id=selected_plan AND p.state IN('queued','running') AND p.approved_by IS NOT NULL AND p.approved_at IS NOT NULL
  AND i.kind=selected_kind AND i.file_id=selected_file AND i.state='removing') THEN RAISE EXCEPTION 'file_cleanup_approved_item_required';END IF;
 IF selected_kind='chat' THEN
  PERFORM 1 FROM public.chat_message_refs m JOIN public.chat_attachments a ON a.message_id=m.message_id WHERE a.id=selected_file FOR SHARE OF m NOWAIT;
 ELSIF selected_kind='forum' THEN
  PERFORM 1 FROM public.forum_attachment_links_v1 l WHERE l.attachment_id=selected_file FOR SHARE OF l NOWAIT;
  PERFORM 1 FROM public.forum_posts_v1 p WHERE p.id IN(SELECT l.post_id FROM public.forum_attachment_links_v1 l WHERE l.attachment_id=selected_file) ORDER BY p.id FOR SHARE OF p NOWAIT;
  PERFORM 1 FROM public.forum_versions_v1 v WHERE v.id IN(SELECT l.version_id FROM public.forum_attachment_links_v1 l WHERE l.attachment_id=selected_file) ORDER BY v.id FOR SHARE OF v NOWAIT;
  PERFORM 1 FROM public.forum_replies_v1 r WHERE r.id IN(SELECT l.reply_id FROM public.forum_attachment_links_v1 l WHERE l.attachment_id=selected_file) ORDER BY r.id FOR SHARE OF r NOWAIT;
 ELSE RAISE EXCEPTION 'file_cleanup_kind_invalid';END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.galaxy_worker_lock_file_cleanup_sources(text,uuid,text,uuid) FROM PUBLIC;
DO $file_cleanup$
DECLARE previous text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO previous FROM pg_constraint
 WHERE conrelid='business_admin_audit_v1'::regclass AND conname='business_admin_audit_v1_action_check';
 IF previous IS NULL OR previous NOT LIKE 'CHECK (%' THEN RAISE EXCEPTION 'file_cleanup_audit_constraint_missing'; END IF;
 ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
 EXECUTE 'ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check '||
  'CHECK (('||substring(previous from 8 for length(previous)-8)||') OR action IN (''file-cleanup-read'',''file-cleanup-create'',''file-cleanup-approve'',''file-cleanup-cancel''))';
END $file_cleanup$;
`;
