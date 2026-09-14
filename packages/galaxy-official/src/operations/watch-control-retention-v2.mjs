// Only selected control metadata and exact operation receipts are retained.
// The existing lifecycle job does no model work and reads no room bodies.
export async function cleanupWatchControlsWithin(db,at){
 const ids=(await db.query(`SELECT watch_id FROM watch_controls_v2
  WHERE COALESCE(stopped_at,expires_at)<=$1 ORDER BY watch_id LIMIT 100`,[new Date((at-90*86400)*1000).toISOString()])).rows.map(r=>r.watch_id);
 if(ids.length){await db.query('DELETE FROM watch_control_operations_v2 WHERE watch_id=ANY($1::uuid[])',[ids]);
  await db.query('DELETE FROM watch_controls_v2 WHERE watch_id=ANY($1::uuid[])',[ids]);}
 return{watchControlReceipts:ids.length};
}
