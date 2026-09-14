const iso = seconds => new Date(seconds * 1000).toISOString();

// Worker-owned cleanup for independently retained copies. It only erases the
// service-held copy; source chat messages and local device data remain outside
// this operation's control. Event hashes and minimal metadata stay as receipts.
export async function cleanupOutcomeMaterialsWithin(db, at, { limit = 100, store = null } = {}) {
  if (!Number.isSafeInteger(at) || at < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Invalid outcome material lifecycle input');
  const rows = (await db.query(`SELECT m.id,m.storage_key FROM outcome_materials_v2 m WHERE m.purged_at IS NULL AND
    (m.purge_pending OR m.expires_at <= $1 OR (m.state='requested' AND m.request_expires_at <= $1)
     OR EXISTS(SELECT 1 FROM cases c WHERE c.id=m.case_id AND c.state='withdrawn')
     OR EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id IN (m.subject_id,m.author_id)
       AND d.state IN ('approved','partial','primary-erased')))
    ORDER BY m.created_at,m.id LIMIT $2 FOR UPDATE SKIP LOCKED`, [iso(at), limit])).rows;
  for (const row of rows) {
    if (row.storage_key) {
      if (!store) throw new Error('Outcome material storage unavailable for cleanup');
      await store.erase({ key: row.storage_key });
    }
    await db.query(`UPDATE outcome_materials_v2
      SET state='erased',body_text='',name='',media_type='',purge_pending=false,purged_at=$2
      WHERE id=$1`, [row.id, iso(at)]);
  }
  return { outcomeMaterialCopiesErased: rows.length, externalCopiesErased: false };
}
