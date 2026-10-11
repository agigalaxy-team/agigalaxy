// Migration78 preserves original room/message/decision IDs, hashes and TTLs.
export const chatRoomGovernanceV2MigrationSql = `
ALTER TABLE chat_rooms ADD COLUMN join_rule jsonb NOT NULL DEFAULT '{"mode":"approval-required","version":1,"decisionId":null,"requestHash":null,"expiresAt":null}';
ALTER TABLE chat_rooms ADD COLUMN administrator_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE chat_rooms ADD CONSTRAINT chat_administrators_shape CHECK(jsonb_typeof(administrator_ids)='array' AND jsonb_array_length(administrator_ids)<=9);
ALTER TABLE chat_rooms ADD CONSTRAINT chat_join_rule_shape CHECK((jsonb_typeof(join_rule)='object'
 AND join_rule ?& ARRAY['mode','version','decisionId','requestHash','expiresAt']
 AND join_rule->>'mode' IN ('approval-required','member-invite','manager-invite','open') AND (join_rule->>'version')::integer>=1
 AND jsonb_typeof(join_rule->'expiresAt') IN ('number','null')
 AND (join_rule->>'expiresAt' IS NULL OR join_rule->>'expiresAt' ~ '^[0-9]+$' AND (join_rule->>'expiresAt')::numeric>0)
 AND ((join_rule->>'version'='1' AND join_rule->>'mode'='approval-required' AND join_rule->>'expiresAt' IS NULL AND join_rule->>'decisionId' IS NULL AND join_rule->>'requestHash' IS NULL)
  OR ((join_rule->>'version')::integer>=2 AND join_rule->>'decisionId' ~ '^[0-9a-f-]{36}$' AND join_rule->>'requestHash' ~ '^[0-9a-f]{64}$'))) IS TRUE);
ALTER TABLE chat_decisions ADD COLUMN authority_rule_version integer;
ALTER TABLE chat_decisions ADD COLUMN authority_rule_hash text;
ALTER TABLE chat_decisions ADD CONSTRAINT chat_decision_rule_reference CHECK
 (((authority_rule_version IS NULL AND authority_rule_hash IS NULL) OR (action IN ('invite','open-join') AND authority_rule_version>=1 AND authority_rule_hash ~ '^[0-9a-f]{64}$')) IS TRUE);
`;
