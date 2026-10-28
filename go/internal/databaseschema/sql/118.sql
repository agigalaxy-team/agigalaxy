
ALTER TABLE operations_automation_grants_v1 ADD COLUMN resource_scope_kind text;
ALTER TABLE operations_automation_grants_v1 ADD CONSTRAINT operations_automation_resource_scope_v1 CHECK(
 resource_scope_kind IS NULL OR
 (resource_scope_kind='selected' AND cardinality(resource_ids)>0) OR
 (resource_scope_kind='eligible' AND cardinality(resource_ids)=0)
);
UPDATE operations_automation_grants_v1 SET resource_scope_kind='selected' WHERE cardinality(resource_ids)>0;
