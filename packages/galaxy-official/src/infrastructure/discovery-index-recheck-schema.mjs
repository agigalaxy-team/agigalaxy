// Additive index only. The central migration registry assigns its next version.
// No source permission, queue, worker role or retention policy is introduced.
export const discoveryIndexRecheckSchedulingSql=`
CREATE INDEX discovery_index_recheck_due_v1
 ON discovery_index_outbox_v1(endpoint,next_attempt_at,kind,source_id)
 WHERE state='applied' AND generation>applied_generation;
`;
