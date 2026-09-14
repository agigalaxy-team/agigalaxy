// Metadata receipts only. Uses the existing lifecycle worker; it never queries
// information sources, creates a session or schedules a model.
export async function cleanupInformationWatchesWithin(db, at) {
  const iso = (n) => new Date(n * 1000).toISOString();
  const removed = (
    await db.query(
      `DELETE FROM information_watch_changes_v2 WHERE id IN
  (SELECT id FROM information_watch_changes_v2 WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT 100)`,
      [iso(at)],
    )
  ).rowCount;
  const old = (
    await db.query(
      'SELECT id FROM information_watches_v2 WHERE COALESCE(ended_at,expires_at)<=$1 ORDER BY id LIMIT 100',
      [iso(at - 90 * 86400)],
    )
  ).rows.map((r) => r.id);
  if (old.length) {
    await db.query(
      'DELETE FROM information_watch_changes_v2 WHERE watch_id=ANY($1::uuid[])',
      [old],
    );
    await db.query(
      'DELETE FROM information_watch_operations_v2 WHERE watch_id=ANY($1::uuid[])',
      [old],
    );
    await db.query(
      'DELETE FROM information_watches_v2 WHERE id=ANY($1::uuid[])',
      [old],
    );
  }
  return {
    informationChangeReceipts: removed,
    informationWatchReceipts: old.length,
  };
}
