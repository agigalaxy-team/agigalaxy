// Worker-only bounded cleanup; public routes cannot remove durable read/audit records.
export async function cleanupExpiredExports(db, now = new Date()) {
  const removed = await db.query(`DELETE FROM data_exports WHERE id IN (SELECT id FROM data_exports
    WHERE expires_at<=$1 OR revoked_at IS NOT NULL ORDER BY expires_at LIMIT 100) RETURNING id`, [now.toISOString()]);
  return { removed: removed.rowCount, payloadFilesStored: false };
}
