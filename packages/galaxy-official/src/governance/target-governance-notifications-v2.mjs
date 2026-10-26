import { ServiceError } from "../shared/service-error.mjs";
// Necessary handling notices carry IDs/status only. They do not disclose the
// private statement to every affected member or manufacture a human read ACK.
export async function targetGovernanceNoticeWithin(db, actor, eventId, service) {
 if(!service)return null;
 const row=(await db.query('SELECT e.*,r.party_ids FROM target_governance_events_v2 e JOIN target_reports_v2 r ON r.id=e.report_id WHERE e.id=$1',[eventId])).rows[0];
 if(!row)return null;
 try{
  const report=await service.readWithin(db,actor,row.report_id),visible=report.events.some(e=>e.eventId===eventId);
  const necessary=['review','pause','resolve','resume','appeal','withdraw-report'].includes(row.kind)&&row.party_ids.includes(actor.subjectId);
  if(!visible&&!necessary)return null;
  return{actorId:row.subject_id,eventKind:'target-governance-'+row.kind,title:'任务或房间处理状态有更新',object:{type:'target-governance',id:row.report_id,eventId,target:report.target,state:report.state},
   serviceReceipt:true,sourceExpiresAt:new Date(Date.parse(row.created_at)+90*86400000).toISOString()};
 }catch(e){if(e instanceof ServiceError&&[403,404,410].includes(e.status))return null;throw e;}
}
