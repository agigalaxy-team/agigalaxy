import {recordContentErasure} from './lifecycle-product-v2.mjs';
const day=86400;
export async function cleanupHubsWithin(db,at){
  const rows=(await db.query(`SELECT e.id,e.subject_id,e.payload_hash FROM hub_events_v2 e JOIN hub_intake_v2 t ON t.id=e.object_id
    WHERE e.kind IN ('intake-open','intake-reply','intake-close') AND t.expires_at<=$1 AND e.payload_text<>'' ORDER BY t.expires_at,e.id LIMIT 100 FOR UPDATE OF e`,[at])).rows;
  for(const r of rows)await recordContentErasure(db,{table:'hub_events_v2',key:r.id,subjectId:r.subject_id,originalHash:r.payload_hash,at,retainedUntil:at+180*day,reason:'temporary-content-expired'});
  if(rows.length)await db.query("UPDATE hub_events_v2 SET payload_text='' WHERE id=ANY($1::uuid[])",[rows.map(r=>r.id)]);
  // Intake expiry is immutable; DELETE takes the required row locks without
  // granting this worker permission to extend or rewrite a relationship.
  const expired=(await db.query('SELECT id FROM hub_intake_v2 WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT 50',[at-180*day])).rows.map(r=>r.id);
  if(expired.length){await db.query("DELETE FROM hub_events_v2 WHERE object_id=ANY($1::uuid[]) AND kind IN ('intake-open','intake-reply','intake-close')",[expired]);await db.query('DELETE FROM hub_intake_v2 WHERE id=ANY($1::uuid[])',[expired]);}
  const receipts=await db.query('DELETE FROM hub_peering_receipts_v2 WHERE (query_id,side) IN (SELECT query_id,side FROM hub_peering_receipts_v2 WHERE created_at<=$1 ORDER BY created_at,query_id,side LIMIT 100)',[at-180*day]);
  return{hubIntakeBodies:rows.length,hubIntakeReceipts:expired.length,hubQueryReceipts:receipts.rowCount};
}
