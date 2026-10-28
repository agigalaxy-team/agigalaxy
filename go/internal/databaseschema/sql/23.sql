
ALTER TABLE data_exports ADD COLUMN views jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(views)='array');
