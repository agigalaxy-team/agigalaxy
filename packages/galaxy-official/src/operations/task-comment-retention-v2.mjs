import { recordContentErasure } from './lifecycle-product-v2.mjs';
const day = 86400,
  stamp = (n) => new Date(n * 1000).toISOString();
// Caller holds a Worker transaction. Comments never copy source bodies into
// notifications, search or replies, so their current reader stops all reuse.
export async function cleanupTaskCommentsWithin(db, at) {
  const expired = (
    await db.query(
      `SELECT e.id,e.subject_id,e.payload_hash FROM task_comment_events_v2 e JOIN task_comments_v2 c ON c.id=e.comment_id
  WHERE c.expires_at<=$1 AND e.payload_text<>'' ORDER BY c.expires_at,e.id LIMIT 100 FOR UPDATE OF e`,
      [stamp(at)],
    )
  ).rows;
  for (const row of expired)
    await recordContentErasure(db, {
      table: 'task_comment_events_v2',
      key: row.id,
      subjectId: row.subject_id,
      originalHash: row.payload_hash,
      at,
      retainedUntil: at + 180 * day,
      reason: 'temporary-content-expired',
    });
  if (expired.length)
    await db.query(
      "UPDATE task_comment_events_v2 SET payload_text='',text_fingerprint=NULL,link_fingerprints='[]',erased_at=$2 WHERE id=ANY($1::uuid[])",
      [expired.map((r) => r.id), stamp(at)],
    );
  await db.query(
    'UPDATE task_comments_v2 SET review_event_id=NULL WHERE expires_at<=$1 AND review_event_id IS NOT NULL',
    [stamp(at)],
  );
  const cases = (
    await db.query(
      'SELECT id FROM comment_reports_v2 WHERE closed_at<=$1 ORDER BY closed_at,id LIMIT 100 FOR UPDATE',
      [stamp(at - 180 * day)],
    )
  ).rows;
  if (cases.length) {
    const ids = cases.map((r) => r.id);
    await db.query(
      'UPDATE task_comments_v2 SET review_event_id=NULL WHERE review_event_id IN (SELECT id FROM comment_governance_events_v2 WHERE report_id=ANY($1::uuid[]))',
      [ids],
    );
    await db.query(
      'UPDATE comment_reports_v2 SET pause_event_id=NULL,decision_event_id=NULL WHERE id=ANY($1::uuid[])',
      [ids],
    );
    await db.query(
      'DELETE FROM comment_governance_events_v2 WHERE report_id=ANY($1::uuid[])',
      [ids],
    );
    await db.query('DELETE FROM comment_reports_v2 WHERE id=ANY($1::uuid[])', [
      ids,
    ]);
  }
  return {
    expiredCommentBodies: expired.length,
    closedGovernanceCases: cases.length,
  };
}
