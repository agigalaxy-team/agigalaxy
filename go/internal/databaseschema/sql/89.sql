
CREATE TABLE account_work_scopes_v1(
 account_id uuid NOT NULL REFERENCES community_accounts(id),
 scope_id uuid NOT NULL,
 work_id text NOT NULL,
 origin_subject_id text NOT NULL,
 created_at timestamptz NOT NULL,
 deleted_at timestamptz,
 deleted_reason text CHECK(deleted_reason IS NULL OR deleted_reason='owner-deleted'),
 deleted_by_kind text CHECK(deleted_by_kind IS NULL OR deleted_by_kind IN ('official-account','identity')),
 deleted_by_subject_id text,
 deleted_request_id uuid,
 PRIMARY KEY(account_id,scope_id),
 CHECK((deleted_at IS NULL)=(deleted_reason IS NULL))
);
CREATE TABLE account_work_v1(
 account_id uuid NOT NULL REFERENCES community_accounts(id),
 work_id text NOT NULL,
 origin_subject_id text NOT NULL,
 scope_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),
 state text NOT NULL CHECK(state IN ('stored','deleted')),
 upload_level text NOT NULL CHECK(upload_level IN ('history-overview','work-content','conversation-archive')),
 data jsonb,
 last_operation_id uuid NOT NULL,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 deleted_at timestamptz,
 PRIMARY KEY(account_id,work_id),
 FOREIGN KEY(account_id,scope_id) REFERENCES account_work_scopes_v1(account_id,scope_id),
 CHECK((state='stored' AND data IS NOT NULL AND deleted_at IS NULL) OR
       (state='deleted' AND data IS NULL AND deleted_at IS NOT NULL))
);
CREATE INDEX account_work_origin_v1 ON account_work_v1(account_id,origin_subject_id,work_id);
CREATE TABLE account_work_operations_v1(
 account_id uuid NOT NULL REFERENCES community_accounts(id),
 operation_id uuid NOT NULL,
 work_id text NOT NULL,
 scope_id uuid NOT NULL,
 origin_subject_id text NOT NULL,
 request_hash text NOT NULL,
 receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 origin_binding_id uuid NOT NULL,
 origin_device_id uuid,
 origin_key_id text,
 http_request_id uuid,
 PRIMARY KEY(account_id,operation_id),
 FOREIGN KEY(account_id,scope_id) REFERENCES account_work_scopes_v1(account_id,scope_id)
);
