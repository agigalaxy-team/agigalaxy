
ALTER TABLE capsule_uses_v2 ADD COLUMN origin_kind text;
ALTER TABLE capsule_uses_v2 ADD COLUMN origin_id uuid REFERENCES case_events(id);
ALTER TABLE capsule_uses_v2 ADD COLUMN origin_version integer;
UPDATE capsule_uses_v2 SET origin_kind='attempt',origin_id=attempt_id,origin_version=attempt_version
 WHERE kind IN ('apply','reverify');
ALTER TABLE capsule_uses_v2 DROP CONSTRAINT capsule_uses_v2_check;
ALTER TABLE capsule_uses_v2 ADD CONSTRAINT capsule_application_origin_shape CHECK (
 (kind='reference' AND origin_kind IS NULL AND origin_id IS NULL AND origin_version IS NULL
  AND attempt_id IS NULL AND attempt_version IS NULL AND result_id IS NULL AND result_version IS NULL AND prior_use_id IS NULL)
 OR
 (kind IN ('apply','reverify') AND origin_kind IS NOT NULL AND origin_kind IN ('attempt','intervention')
  AND origin_id IS NOT NULL AND origin_version IS NOT NULL AND origin_version>0
  AND result_id IS NOT NULL AND result_version IS NOT NULL AND result_version>0
  AND ((origin_kind='attempt' AND attempt_id IS NOT NULL AND attempt_version IS NOT NULL
        AND attempt_id=origin_id AND attempt_version=origin_version)
       OR (origin_kind='intervention' AND attempt_id IS NULL AND attempt_version IS NULL)))
);
