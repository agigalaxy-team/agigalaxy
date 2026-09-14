import {recordContentErasure} from './lifecycle-product-v2.mjs';
const iso=n=>new Date(n*1000).toISOString(),day=86400;
export async function cleanupQualificationRequestsWithin(db,at){
 const rows=(await db.query(`SELECT e.id,e.subject_id,e.payload_hash,r.expires_at FROM qualification_permission_request_events e
  JOIN qualification_permission_requests r ON r.id=e.request_id WHERE r.expires_at<=$1 AND e.payload_text<>'' ORDER BY r.expires_at,e.id LIMIT 100 FOR UPDATE OF e`,[iso(at)])).rows;
 for(const row of rows)await recordContentErasure(db,{table:'qualification_permission_request_events',key:row.id,subjectId:row.subject_id,originalHash:row.payload_hash,
  at,retainedUntil:Math.max(at,Date.parse(row.expires_at)/1000+180*day),reason:'temporary-content-expired'});
 if(rows.length)await db.query("UPDATE qualification_permission_request_events SET payload_text='' WHERE id=ANY($1::uuid[])",[rows.map(r=>r.id)]);
 const parents=(await db.query('SELECT id FROM qualification_permission_requests WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT 50 FOR UPDATE',[iso(at-180*day)])).rows;
 let eventsRemoved=0;if(parents.length){eventsRemoved=(await db.query('DELETE FROM qualification_permission_request_events WHERE request_id=ANY($1::uuid[])',[parents.map(r=>r.id)])).rowCount;
  await db.query('DELETE FROM qualification_permission_requests WHERE id=ANY($1::uuid[])',[parents.map(r=>r.id)]);}
 return{qualificationRequestBodies:rows.length,qualificationRequestEvents:eventsRemoved,qualificationRequestReceipts:parents.length};
}
