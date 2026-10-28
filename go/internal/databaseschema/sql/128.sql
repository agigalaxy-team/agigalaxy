
CREATE INDEX discovery_index_recheck_due_v1
 ON discovery_index_outbox_v1(endpoint,next_attempt_at,kind,source_id)
 WHERE state='applied' AND generation>applied_generation;
