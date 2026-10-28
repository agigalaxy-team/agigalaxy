
CREATE TABLE task_materials_v1 (
 material_id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES task_requests(id),subject_id text NOT NULL REFERENCES subjects(id),
 root_event_id uuid NOT NULL, consent_id uuid NOT NULL REFERENCES consents(id),descriptor jsonb NOT NULL,
 body_text text NOT NULL, text_hash text NOT NULL CHECK(text_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,erased_at timestamptz,check_sequence bigint NOT NULL DEFAULT 0 CHECK(check_sequence>=0),
 CHECK(jsonb_typeof(descriptor)='object'),CHECK(expires_at>created_at),CHECK(erased_at IS NULL OR body_text='')
);
CREATE INDEX task_materials_v1_task ON task_materials_v1(task_id,material_id);
CREATE INDEX task_materials_v1_cleanup ON task_materials_v1(check_sequence,expires_at,material_id) WHERE erased_at IS NULL;
