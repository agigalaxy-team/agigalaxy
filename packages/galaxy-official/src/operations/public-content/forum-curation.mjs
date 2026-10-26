import {operationsIso} from "./content-visibility.mjs";

export const forumTagView=row=>({id:row.id,name:row.name,version:row.revision,enabled:row.enabled,createdAt:operationsIso(row.created_at),updatedAt:operationsIso(row.updated_at)});
export async function forumCurationWithin(db,{endpoint,kind,id,version}){
 const row=(await db.query('SELECT * FROM operations_forum_curation_v1 WHERE endpoint=$1 AND target_kind=$2 AND target_id=$3',[endpoint,kind,id])).rows[0],
  applies=!!row&&row.source_version===version,tagIds=applies?row.tag_ids:[],
  tags=tagIds.length?(await db.query('SELECT * FROM operations_forum_tags_v1 WHERE endpoint=$1 AND id=ANY($2::uuid[]) AND enabled=true ORDER BY name,id',[endpoint,tagIds])).rows.map(forumTagView):[];
 return {revision:row?.revision??0,sourceVersion:row?.source_version??null,appliesToCurrent:applies,topic:applies?row.topic:null,
  pinned:applies&&row.pinned,featured:applies&&row.featured,tagIds:tags.map(tag=>tag.id),tags,publicPlacement:'not-connected'};
}
