import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {z} from "zod";
import {digest} from "../../shared/digest.mjs";
import {operationsParse,operationsFail,operationsIso,operationsStamp} from "./content-visibility.mjs";
import {forumTagView} from "./forum-curation.mjs";
import {operationsContentVisibilitySchema,operationsContentCurationSchema,operationsTagCreateSchema,operationsTagUpdateSchema} from "../../shared/operations-forum-content-schema.mjs";
import {PublicContentReadModel} from './read-model.mjs';

// Original single-item visibility, curation and tag commands, source CAS, current grants and immutable governance events.
export class PublicContentCommands extends PublicContentReadModel{
 async recordEventWithin(db,actor,{kind,id,eventKind,operationId,sourceVersion,revision,reason,changes}){
  await db.query(`INSERT INTO operations_forum_content_events_v1(id,endpoint,target_kind,target_id,kind,operator_id,operation_id,source_version,revision,reason,changes,http_request_id,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[randomUUID(),this.endpoint,kind,id,eventKind,actor.operatorId,operationId,sourceVersion,revision,reason,JSON.stringify(changes),actor.httpRequestId??null,operationsStamp(this.now())]);
 }
 async visibilityWithin(db,actor,kind,id,x,{batch=false}={}){
  const view=await this.viewWithin(db,actor,kind,id,{detail:true,lock:true});
  if(view.version!==x.expectedVersion)operationsFail('operations_source_changed');
  if(view.visibility.version!==x.expectedRevision)operationsFail('operations_visibility_changed');
  const canHide=batch?view.capabilities.canBatchHide:view.capabilities.canHide,canRestore=batch?view.capabilities.canBatchRestore:view.capabilities.canRestore;
  if(x.kind==='hide'&&!canHide||x.kind==='restore'&&!canRestore)operationsFail('operations_source_unavailable');
  const input={...x,expectedVisibilityVersion:x.expectedRevision};
  const result=await this.changeVisibilityWithin(db,{kind:kind==='post'?'forum-post':'forum-reply',id,expectedVersion:x.expectedVersion,sourceVersion:view.version,input});
  await this.recordEventWithin(db,actor,{kind,id,eventKind:'visibility',operationId:x.operationId,sourceVersion:view.version,revision:result.visibility.version,reason:x.reason,
   changes:{kind:x.kind,hidden:result.visibility.hidden,until:result.visibility.until}});
  return result.visibility;
 }
 async visibility(operator,kind,id,input){
  const x=operationsParse(operationsContentVisibilitySchema,input),{reason,...metadata}=x;
  const saved=await this.command(operator,'community-content-visibility',{targetKind:kind,id,...metadata,reasonDigest:digest(reason)},async(db,actor)=>({kind,id,visibility:await this.visibilityWithin(db,actor,kind,id,x)}));
  return {...await this.get(operator,kind,id),operationId:x.operationId,replayed:saved.replayed??false};
 }
 async curate(operator,kind,id,input){
  const x=operationsParse(operationsContentCurationSchema,input),{reason,...metadata}=x;
  const saved=await this.command(operator,'community-content-curation',{kind,id,...metadata,reasonDigest:digest(reason)},async(db,actor)=>{
   const view=await this.viewWithin(db,actor,kind,id,{lock:true});
   if(view.version!==x.expectedVersion)operationsFail('operations_source_changed');if(view.curation.revision!==x.expectedRevision)operationsFail('operations_curation_changed');
   if(!view.capabilities.canCurate)operationsFail('operations_source_unavailable');
   const old=view.curation.appliesToCurrent?view.curation:{topic:null,pinned:false,featured:false,tagIds:[]},topic=Object.hasOwn(x,'topic')?x.topic:old.topic,
    pinned=x.pinned??old.pinned,featured=x.featured??old.featured,tagIds=[...(x.tagIds??old.tagIds)].sort((a,b)=>a<b?-1:a>b?1:0);
   if(tagIds.length&&(await db.query('SELECT id FROM operations_forum_tags_v1 WHERE endpoint=$1 AND id=ANY($2::uuid[]) AND enabled=true',[this.endpoint,tagIds])).rows.length!==tagIds.length)operationsFail('operations_tag_unavailable');
   if(view.curation.appliesToCurrent&&topic===old.topic&&pinned===old.pinned&&featured===old.featured&&isDeepStrictEqual(tagIds,[...old.tagIds].sort((a,b)=>a<b?-1:a>b?1:0)))operationsFail('operations_content_unchanged');
   const revision=view.curation.revision+1,at=operationsStamp(this.now());
   await db.query(`INSERT INTO operations_forum_curation_v1(endpoint,target_kind,target_id,revision,source_version,topic,pinned,featured,tag_ids,operation_id,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(endpoint,target_kind,target_id) DO UPDATE SET revision=EXCLUDED.revision,source_version=EXCLUDED.source_version,
    topic=EXCLUDED.topic,pinned=EXCLUDED.pinned,featured=EXCLUDED.featured,tag_ids=EXCLUDED.tag_ids,operation_id=EXCLUDED.operation_id,updated_at=EXCLUDED.updated_at`,
   [this.endpoint,kind,id,revision,view.version,topic,pinned,featured,JSON.stringify(tagIds),x.operationId,at]);
   await this.recordEventWithin(db,actor,{kind,id,eventKind:'curation',operationId:x.operationId,sourceVersion:view.version,revision,reason,changes:{topic,pinned,featured,tagIds}});
   return {kind,id,revision,sourceVersion:view.version};
  });
  return {...await this.get(operator,kind,id),operationId:x.operationId,replayed:saved.replayed??false};
 }
 async tag(operator,id,input){
  const creating=!id,x=operationsParse(creating?operationsTagCreateSchema:operationsTagUpdateSchema,input);if(id)operationsParse(z.uuid(),id);
  const saved=await this.command(operator,creating?'community-tag-create':'community-tag-update',{...(id?{id}:{}),operationId:x.operationId,expectedVersion:x.expectedVersion??null,nameDigest:x.name?digest(x.name):null,enabled:x.enabled??null},async(db,actor)=>{
   const old=id?(await db.query('SELECT * FROM operations_forum_tags_v1 WHERE endpoint=$1 AND id=$2 FOR UPDATE',[this.endpoint,id])).rows[0]:null;
   if(id&&!old)operationsFail('not_found',404);if(old&&old.revision!==x.expectedVersion)operationsFail('operations_tag_changed');
   const name=x.name??old.name,normalized=name.normalize('NFKC').replace(/\s+/g,' ').toLocaleLowerCase('en-US'),enabled=x.enabled??old?.enabled??true;
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912398))',[this.endpoint+':forum-tag:'+normalized]);
   if((await db.query('SELECT 1 FROM operations_forum_tags_v1 WHERE endpoint=$1 AND normalized_name=$2 AND ($3::uuid IS NULL OR id<>$3)',[this.endpoint,normalized,id??null])).rows.length)operationsFail('operations_tag_exists');
   const at=operationsStamp(this.now()),tagId=id??randomUUID(),revision=(old?.revision??0)+1;
   const row=(await db.query(`INSERT INTO operations_forum_tags_v1(id,endpoint,name,normalized_name,revision,enabled,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,normalized_name=EXCLUDED.normalized_name,revision=EXCLUDED.revision,enabled=EXCLUDED.enabled,updated_at=EXCLUDED.updated_at RETURNING *`,[tagId,this.endpoint,name,normalized,revision,enabled,old?operationsIso(old.created_at):at,at])).rows[0];
   await this.recordEventWithin(db,actor,{kind:'tag',id:tagId,eventKind:creating?'tag-create':'tag-update',operationId:x.operationId,sourceVersion:revision,revision,reason:'',changes:{name,enabled}});
   return {tag:forumTagView(row)};
  });return {...saved,replayed:saved.replayed??false};
 }
}
