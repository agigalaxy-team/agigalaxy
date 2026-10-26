import { transaction } from "../infrastructure/database.mjs";
// Separate original-body retention from operational restrictions. At 180 days
// after closure, even the maximum 30-day restriction has expired. No MAM delete.
export async function purgeTargetGovernanceV2(db, now) {
 return transaction(db,tx=>cleanupTargetGovernanceWithin(tx,now));
}
export async function cleanupTargetGovernanceWithin(tx,now){
  const rows=(await tx.query('SELECT id FROM target_reports_v2 WHERE closed_at<=$1 AND (restriction_until IS NULL OR restriction_until<=$2) ORDER BY closed_at,id LIMIT 100 FOR UPDATE',
   [new Date((now-180*86400)*1000),new Date(now*1000)])).rows;
  if(!rows.length)return{targetReports:0,targetGovernanceEvents:0};const ids=rows.map(x=>x.id);
  await tx.query('UPDATE target_reports_v2 SET restriction_event_id=NULL,decision_event_id=NULL WHERE id=ANY($1::uuid[])',[ids]);
  const events=await tx.query('DELETE FROM target_governance_events_v2 WHERE report_id=ANY($1::uuid[])',[ids]);
  const reports=await tx.query('DELETE FROM target_reports_v2 WHERE id=ANY($1::uuid[])',[ids]);
  return{targetReports:reports.rowCount??reports.affectedRows??rows.length,targetGovernanceEvents:events.rowCount??events.affectedRows??0};
}
