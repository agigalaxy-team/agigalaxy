export const chatContentBudgetMigrationSql = `
ALTER TABLE chat_message_refs ADD COLUMN content_bytes bigint NOT NULL DEFAULT 0 CHECK(content_bytes>=0);
-- Historical metadata lacks a body length. Reserve the transport's maximum,
-- never assume an unmeasured existing MAM body costs zero bytes.
UPDATE chat_message_refs SET content_bytes=64000 WHERE state IN ('pending','accepted') OR purge_pending;
ALTER TABLE chat_message_operations ADD COLUMN state text NOT NULL DEFAULT 'complete' CHECK(state IN ('pending','complete','cancelled'));
ALTER TABLE chat_message_operations ADD COLUMN previous_content_bytes bigint NOT NULL DEFAULT 0 CHECK(previous_content_bytes>=0);
ALTER TABLE chat_message_operations ADD COLUMN target_content_bytes bigint NOT NULL DEFAULT 0 CHECK(target_content_bytes>=0);
ALTER TABLE chat_message_operations ADD COLUMN base_revision integer NOT NULL DEFAULT 0 CHECK(base_revision>=0);
ALTER TABLE chat_message_operations ADD CONSTRAINT chat_pending_edit_reservation CHECK(state<>'pending' OR (kind='edit' AND base_revision>0));
CREATE UNIQUE INDEX chat_one_pending_edit ON chat_message_operations(message_id) WHERE kind='edit' AND state='pending';
`;
