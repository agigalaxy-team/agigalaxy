import {ServiceError} from './shared/service-error.mjs';
import {digest} from './shared/digest.mjs';
const rule=(ok,code,status=404)=>{if(!ok)throw new ServiceError(code,status);};
export function createIdentityGroupSourceReader({cases,configurations}){
 return async function readWithin(db,actor,ref,{authorApproval=false}={}){
  if(actor&&!authorApproval)rule(actor.scopes?.includes('history')||(ref.kind==='case-event'&&actor.scopes?.includes('case-teaser')),'identity_group_source_scope_required',403);
  let row,view;
  if(ref.kind==='case-event'){
   rule(ref.caseId,'identity_group_source_unavailable');
   row=(await db.query('SELECT * FROM case_events WHERE id=$1 AND case_id=$2 AND version=$3',[ref.id,ref.caseId,ref.version])).rows[0];
   rule(row?.payload_text,'identity_group_source_unavailable');
   const parent=(await db.query('SELECT * FROM cases WHERE id=$1',[ref.caseId])).rows[0];
   rule(parent&&parent.state!=='withdrawn','identity_group_source_unavailable');
   const rows=(await db.query('SELECT * FROM case_events WHERE case_id=$1 ORDER BY version LIMIT 1001',[ref.caseId])).rows;
   view=(await cases.projectAuthorizedWithin(db,actor,parent,rows)).view;
   rule(view.events.some(e=>e.eventId===ref.id&&e.caseVersion===ref.version),'identity_group_source_unavailable');
   rule(row.payload.actorId===row.subject_id,'identity_group_legacy_author_unknown',409);
  }else{
   view=await configurations.requireReferenceWithin(db,actor,ref);
   row=(await db.query('SELECT * FROM configuration_events WHERE configuration_id=$1 AND version=$2',[ref.id,ref.version])).rows[0];
  }
  rule(row?.payload_text&&digest(row.payload_text)===row.payload_hash,'identity_group_source_unavailable');
  rule(row.subject_id===ref.originalSubjectId&&row.payload_hash===ref.sourceHash,'identity_group_source_changed',409);
  rule(!(await db.query("SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased') LIMIT 1",[row.subject_id])).rows.length,'identity_group_source_deletion_pending',409);
  return{ref,originalSubjectId:row.subject_id,sourceHash:row.payload_hash,record:JSON.parse(row.payload_text),
   signatureSubjectId:row.subject_id,sourceAuthority:'original-authored-record; not-execution-or-capability-certification',accessGranted:false};
 };
}
