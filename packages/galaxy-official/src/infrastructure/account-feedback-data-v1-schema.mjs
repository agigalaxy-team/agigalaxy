export const accountFeedbackDataV1MigrationSql=`
ALTER TABLE operations_feedback_v1 ADD COLUMN owner_deleted_at timestamptz;
ALTER TABLE operations_feedback_v1 ADD COLUMN owner_delete_operation_id uuid;
ALTER TABLE operations_feedback_v1 ALTER COLUMN title DROP NOT NULL;
ALTER TABLE operations_feedback_v1 ALTER COLUMN body DROP NOT NULL;
ALTER TABLE operations_feedback_v1 DROP CONSTRAINT operations_feedback_v1_title_check;
ALTER TABLE operations_feedback_v1 DROP CONSTRAINT operations_feedback_v1_body_check;
ALTER TABLE operations_feedback_v1 ADD CONSTRAINT operations_feedback_owner_content_v1 CHECK(
 (owner_deleted_at IS NULL AND owner_delete_operation_id IS NULL AND title IS NOT NULL AND length(title) BETWEEN 1 AND 120 AND body IS NOT NULL AND length(body) BETWEEN 1 AND 6000)
 OR (owner_deleted_at IS NOT NULL AND owner_delete_operation_id IS NOT NULL AND title IS NULL AND body IS NULL));

CREATE TABLE account_feedback_data_operations_v1(
 sequence bigserial NOT NULL UNIQUE,operation_id uuid PRIMARY KEY,endpoint text NOT NULL,account_id uuid NOT NULL REFERENCES community_accounts(id),
 kind text NOT NULL CHECK(kind IN('export','delete')),cutoff_sequence bigint NOT NULL CHECK(cutoff_sequence>=0),
 state text NOT NULL CHECK(state IN('ready','pending','completed','attention')),
 feedback_count integer NOT NULL CHECK(feedback_count>=0),attachment_count integer NOT NULL CHECK(attachment_count>=0),
 metadata_deleted boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 CHECK((kind='export' AND state='ready' AND NOT metadata_deleted) OR (kind='delete' AND state IN('pending','completed','attention')))
);
CREATE INDEX account_feedback_data_owner_v1 ON account_feedback_data_operations_v1(endpoint,account_id,created_at DESC);
ALTER TABLE operations_feedback_v1 ADD CONSTRAINT operations_feedback_owner_delete_operation_v1
 FOREIGN KEY(owner_delete_operation_id) REFERENCES account_feedback_data_operations_v1(operation_id);
CREATE TABLE account_feedback_data_items_v1(
 operation_id uuid NOT NULL REFERENCES account_feedback_data_operations_v1(operation_id),
 attachment_id uuid NOT NULL UNIQUE REFERENCES feedback_attachments_v1(id),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','removing','removed','result-unknown')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),attempt_id uuid,
 attempted_at timestamptz,next_attempt_at timestamptz,result_code text,object_removed boolean,completed_at timestamptz,
 PRIMARY KEY(operation_id,attachment_id),CHECK(state<>'removed' OR object_removed IS TRUE)
);
CREATE INDEX account_feedback_data_pending_v1 ON account_feedback_data_items_v1(state,next_attempt_at) WHERE state<>'removed';

-- This entry only erases the exact owner's previously recorded selection. It
-- cannot rewrite feedback text, change an operator note or create an intent.
CREATE FUNCTION public.galaxy_account_erase_feedback_data(p_endpoint text,p_account_id uuid,p_operation_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE intent public.account_feedback_data_operations_v1%ROWTYPE;
BEGIN
 SELECT * INTO intent FROM public.account_feedback_data_operations_v1
  WHERE operation_id=p_operation_id AND endpoint=p_endpoint AND account_id=p_account_id AND kind='delete' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'account_feedback_delete_intent_required' USING ERRCODE='42501'; END IF;
 IF intent.metadata_deleted THEN RETURN; END IF;
 INSERT INTO public.account_feedback_data_items_v1(operation_id,attachment_id,state,object_removed,completed_at)
 SELECT p_operation_id,a.id,CASE WHEN a.purged_at IS NOT NULL THEN 'removed' ELSE 'pending' END,
  CASE WHEN a.purged_at IS NOT NULL THEN true ELSE NULL END,CASE WHEN a.purged_at IS NOT NULL THEN a.purged_at ELSE NULL END
 FROM public.feedback_attachments_v1 a JOIN public.operations_feedback_v1 f ON f.id=a.feedback_id AND f.endpoint=a.endpoint AND f.account_id=a.account_id
 WHERE f.endpoint=p_endpoint AND f.account_id=p_account_id AND f.sequence<=intent.cutoff_sequence AND f.owner_deleted_at IS NULL
  AND a.submission_operation_id=f.submission_operation_id;
 UPDATE public.feedback_attachments_v1 a SET revoked_at=COALESCE(a.revoked_at,intent.created_at),
  purge_pending=a.purged_at IS NULL,lease_id=NULL,lease_until=NULL,name='',media_type='',scan_result=NULL
 WHERE EXISTS(SELECT 1 FROM public.account_feedback_data_items_v1 i WHERE i.operation_id=p_operation_id AND i.attachment_id=a.id);
 UPDATE public.operations_feedback_v1 SET title=NULL,body=NULL,owner_deleted_at=intent.created_at,owner_delete_operation_id=p_operation_id,
  revision=revision+1,updated_at=intent.created_at
 WHERE endpoint=p_endpoint AND account_id=p_account_id AND sequence<=intent.cutoff_sequence AND owner_deleted_at IS NULL;
 UPDATE public.account_feedback_data_operations_v1 SET metadata_deleted=true,
  state=CASE WHEN EXISTS(SELECT 1 FROM public.account_feedback_data_items_v1 WHERE operation_id=p_operation_id AND state<>'removed') THEN 'pending' ELSE 'completed' END,
  updated_at=intent.created_at WHERE operation_id=p_operation_id;
END $$;
REVOKE ALL ON FUNCTION public.galaxy_account_erase_feedback_data(text,uuid,uuid) FROM PUBLIC;
`;
