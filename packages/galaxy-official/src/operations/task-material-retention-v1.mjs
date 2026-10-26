import {TaskMaterialServiceV1} from "../tasks/v2/material-v1.mjs";
import {CommunityForumV1} from "../community/community-forum-v1.mjs";
import {recordContentErasure} from './lifecycle-product-v2.mjs';
import {forumStamp} from "../community/community-forum-permissions-v1.mjs";

export async function eraseTaskMaterialWithin(db,row,{at,reason,requestId=null}){
 if(row.erased_at||!row.body_text)return false;
 await recordContentErasure(db,{table:'task_materials_v1',key:row.material_id,subjectId:row.subject_id,originalHash:row.text_hash,
  at,retainedUntil:at+180*86400,requestId,reason});
 await db.query("UPDATE task_materials_v1 SET body_text='',erased_at=$2 WHERE material_id=$1",[row.material_id,forumStamp(at)]);return true;
}
export async function cleanupTaskMaterialsWithin(db,at,{endpoint,forumPolicy}={}){
 const rows=(await db.query('SELECT * FROM task_materials_v1 WHERE erased_at IS NULL ORDER BY check_sequence,expires_at,material_id LIMIT 100 FOR UPDATE')).rows;
 if(rows.length&&!endpoint)throw new Error('task_material_retention_endpoint_required');
 const access={endpoint,now:()=>at},forum=new CommunityForumV1(access,null,{policy:forumPolicy}),materials=new TaskMaterialServiceV1(access,null,{forum});
 let erased=0;
 for(const row of rows){const state=await materials.statusWithin(db,row,{lock:false});
  if(!state.available&&state.permanent&&await eraseTaskMaterialWithin(db,row,{at,reason:state.reasons?.includes('material-expired')?'temporary-content-expired':'derived-content-erased'}))erased++;
  else await db.query('UPDATE task_materials_v1 SET check_sequence=check_sequence+1 WHERE material_id=$1',[row.material_id]);
 }
 const removed=(await db.query(`DELETE FROM task_materials_v1 WHERE material_id IN(SELECT material_id FROM task_materials_v1
  WHERE erased_at IS NOT NULL AND erased_at<=$1 ORDER BY erased_at,material_id LIMIT 100)`,[forumStamp(at-180*86400)])).rowCount;
 return {taskMaterialBodiesErased:erased,taskMaterialReceiptsRemoved:removed};
}
