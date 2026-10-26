import {z} from "zod";
import {digest} from "../../shared/digest.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {operationsParse,operationsFail,operationsIso,operationsStamp,operationsVisibilityWithin} from "../../operations-content-visibility.mjs";
import {operationsAnalyticsPeriod} from "../../operations-analytics.mjs";
import {forumCurationWithin,forumTagView} from "../../operations-forum-curation.mjs";
import {hasOperationsPermission as permitted} from "../../operations-permission-catalog.mjs";
import {operationsOperatorNamesWithin} from "../../operations-history-identities.mjs";
import {operationsContentQuerySchema,operationsContentHistorySchema} from "../../shared/operations-forum-content-schema.mjs";
import {sixTopics,key,visibilityState,candidates} from './helpers.mjs';
import {PublicContentSource} from './source.mjs';

// Authorized source projections, metadata directories/history and attachment reads with the original before/after authority and source checks.
export class PublicContentReadModel extends PublicContentSource{
 async viewWithin(db,actor,kind,id,{detail=false,lock=false}={}){
  const {head,source}=await this.rawWithin(db,kind,id,{lock}),read=await this.publicSourceWithin(db,kind,head,source);
  if(!read.candidate)operationsFail('not_found',404);
  const version=kind==='post'?head.head_version:head.revision,postId=kind==='post'?id:head.post_id,
   own=await operationsVisibilityWithin(db,{endpoint:this.endpoint,kind:kind==='post'?'forum-post':'forum-reply',id,now:this.now()}),
   parent=kind==='reply'?await operationsVisibilityWithin(db,{endpoint:this.endpoint,kind:'forum-post',id:postId,now:this.now()}):null,
   caseHidden=await this.caseHiddenWithin(db,kind,head,source),
   inheritedHidden=!!parent?.hidden,hidden=own.hidden||inheritedHidden||caseHidden,
   curation=await forumCurationWithin(db,{endpoint:this.endpoint,kind,id,version}),
   originalTopic=!read.available?null:kind==='post'?(source?.topic??'unclassified'):(read.parentView?.availability==='available'?read.parentView.originalTopic??'unclassified':null),
   author=read.available?(await db.query('SELECT a.uid,p.display_name FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2',[head.account_id,this.endpoint])).rows[0]:null,
   title=read.available?(kind==='post'?read.payload.title:read.parentView?.availability==='available'?read.parentView.payload.title:null):null;
  const attachments=detail&&read.available&&this.forum.attachments?(await this.forum.attachments.metadataWithin(db,read.payload.attachments??[])).map(file=>{
   const available=!hidden&&file.state==='available'&&!file.cleanupPending&&(kind==='post'||read.parentView?.availability==='available');
   return {id:file.attachmentId,name:file.name??null,mediaType:file.mediaType??null,byteSize:file.size??null,state:file.state,
    availability:available?'available':'unavailable',contentPath:available?'/v1/operations/community/content/'+kind+'/'+id+'/attachments/'+file.attachmentId+'/content':null};
  }):[];
  return {kind,id,postId,versionId:kind==='post'?head.current_version_id??null:head.post_version_id,version,
   author:read.available?{accountId:head.account_id,uid:author?.uid??null,displayName:author?.display_name??null,subjectId:head.subject_id??null}:{accountId:null,uid:null,displayName:null,subjectId:null},
   title,excerpt:read.available?read.payload.body.slice(0,180):null,topic:curation.topic??originalTopic,originalTopic,state:head.state,
   sourceState:read.available?'available':'unavailable',createdAt:operationsIso(head.created_at),updatedAt:operationsIso(head.updated_at??head.created_at),
   visibility:{version:own.version,hidden,ownHidden:own.hidden,inheritedHidden,caseHidden,until:own.until,operationId:own.operationId},curation,
   capabilities:{canHide:permitted(actor,'content.hide')&&read.available&&!hidden,canRestore:permitted(actor,'content.restore')&&read.available&&own.hidden&&!inheritedHidden&&!caseHidden,
    canBatchHide:permitted(actor,'content.batch.hide')&&read.available&&!hidden,canBatchRestore:permitted(actor,'content.batch.restore')&&read.available&&own.hidden&&!inheritedHidden&&!caseHidden,
    canCurate:permitted(actor,'content.curate')&&read.available},maxHideSeconds:this.maxHideSeconds,
   ...(detail?{body:read.available?read.payload.body:null,links:read.available?read.payload.links??[]:[],attachments,publishedUntil:read.available?Math.floor(Date.parse(source.published_until)/1000):null}:{})};
 }
 async tagsWithin(db){return (await db.query('SELECT * FROM operations_forum_tags_v1 WHERE endpoint=$1 ORDER BY name,id',[this.endpoint])).rows.map(forumTagView);}
 async historyWithin(db,kind,id,input={}){
  const q=operationsParse(operationsContentHistorySchema,input),rows=(await db.query(`SELECT * FROM operations_forum_content_events_v1 WHERE endpoint=$1 AND target_kind=$2 AND target_id=$3
   AND ($4::bigint IS NULL OR sequence<$4::bigint) ORDER BY sequence DESC LIMIT 51`,[this.endpoint,kind,id,q.historyAfter??null])).rows;
  const selected=rows.slice(0,50),names=await operationsOperatorNamesWithin(db,{endpoint:this.endpoint,operatorIds:selected.map(row=>row.operator_id)});
  return {items:selected.map(row=>({id:row.id,sequence:String(row.sequence),kind:row.kind,operatorId:row.operator_id,operatorDisplayName:names.get(row.operator_id)??null,operationId:row.operation_id,
   sourceVersion:row.source_version,revision:row.revision,reason:row.reason,changes:row.changes,createdAt:operationsIso(row.created_at)})),nextAfter:rows.length>50?String(rows[49].sequence):null};
 }
 get(operator,kind,id,input={}){operationsParse(operationsContentHistorySchema,input);return this.run(operator,false,'community-content-read',{kind,id},async(db,actor)=>({
  content:await this.viewWithin(db,actor,kind,id,{detail:true}),history:await this.historyWithin(db,kind,id,input),permissions:{canManage:['content.hide','content.restore','content.curate','content.batch.hide','content.batch.restore'].some(code=>permitted(actor,code))},checkedAt:this.now()}));}
 attachmentContent(operator,kind,id,attachmentId,{authorize=null}={}){
  operationsParse(z.uuid(),attachmentId);
  return this.run(operator,false,'community-content-read',{kind,id,attachmentId},async(db,actor)=>{
   const files=this.forum.attachments;if(!files)operationsFail('attachment_service_unavailable',503);files.configured();
   const authorizeCurrent=async()=>{const fresh=await this.businessAdmin.authorizeAction(authorize?await authorize():operator,'content.read',{db});
    if(fresh.operatorId!==actor.operatorId)operationsFail('business_admin_denied',403);await this.principalWithin(db,fresh);};
   await authorizeCurrent();const view=await this.viewWithin(db,actor,kind,id,{detail:true});
   if(view.sourceState!=='available'||view.visibility.hidden||!view.attachments.some(file=>file.id===attachmentId&&file.availability==='available'))operationsFail('attachment_source_unavailable',404);
   const source=kind==='reply'?{replyId:id}:{postId:id,versionId:view.versionId};let row=await files.row(db,attachmentId);
   await files.readableWithin(db,null,row,source);
   const bytes=await files.store.get({key:row.storage_key,keyId:row.encryption_key_id,size:Number(row.byte_size)});
   if(!bytes||digest(bytes)!==row.sha256)operationsFail('attachment_storage_integrity_failed',502);
   await authorizeCurrent();row=await files.row(db,attachmentId);await files.readableWithin(db,null,row,source);
   return {bytes,name:row.name,mediaType:row.media_type,sha256:row.sha256,attachmentId};
  });
 }
 matches(view,q){
  if(q.kind&&view.kind!==q.kind||q.topic&&view.topic!==q.topic||q.visibility&&q.visibility!==visibilityState(view)
   ||q.pinned!==undefined&&view.curation.pinned!==q.pinned||q.featured!==undefined&&view.curation.featured!==q.featured)return false;
  const needle=q.query.toLocaleLowerCase('en-US'),metadata=[view.kind,view.id,view.postId,view.versionId,view.state,visibilityState(view)],
   text=view.sourceState==='available'?[view.title,view.excerpt,view.body,view.author.uid,view.author.displayName]:[];
  return !needle||[...metadata,...text].some(value=>typeof value==='string'&&value.toLocaleLowerCase('en-US').includes(needle));
 }
 async candidatesWithin(db,q,{after=null,limit=201}={}){
  let pivot=null;
  if(after){const [kind,id]=after.split(':');pivot=(await db.query(`SELECT * FROM (${candidates}) entries WHERE kind=$2 AND id=$3`,[this.endpoint,kind,id])).rows[0];if(!pivot)operationsFail('operations_content_cursor_changed');}
  const from=q.days==='all'?null:operationsAnalyticsPeriod(this.now(),q.days).period.from;
  return (await db.query(`SELECT * FROM (${candidates}) entries WHERE ($2::text IS NULL OR kind=$2) AND ($3::timestamptz IS NULL OR created_at>=$3)
   AND created_at<=$4 AND ($9::uuid IS NULL OR id=$9::uuid) AND ($5::timestamptz IS NULL OR (created_at,kind,id)<($5::timestamptz,$6::text,$7::uuid))
   ORDER BY created_at DESC,kind DESC,id DESC LIMIT $8`,[this.endpoint,q.kind??null,from,operationsStamp(this.now()),pivot?operationsIso(pivot.created_at):null,pivot?.kind??null,pivot?.id??null,limit,q.targetId??null])).rows;
 }
 list(operator,input={}){
  const q=operationsParse(operationsContentQuerySchema,input),{query,...metadata}=q;
  return this.run(operator,false,'community-content-query',{...metadata,hasQuery:!!query},async(db,actor)=>{
   const cache=new Map(),read=async row=>{const k=key(row);if(!cache.has(k))cache.set(k,this.viewWithin(db,actor,row.kind,row.id,{detail:true}).catch(error=>{if(error instanceof ServiceError&&error.status===404)return null;throw error;}));return cache.get(k);},
    rows=await this.candidatesWithin(db,q,{after:q.after,limit:201}),items=[];let last=null,processed=0;
   for(const row of rows.slice(0,200)){last=row;processed++;const view=await read(row);if(view&&this.matches(view,q)){const {body:_body,links:_links,attachments:_attachments,publishedUntil:_publishedUntil,...item}=view;items.push(item);}if(items.length===q.limit)break;}
   const all=await this.candidatesWithin(db,q,{limit:2001}),trendDays=q.days===28?28:7,window=operationsAnalyticsPeriod(this.now(),trendDays);
   let summary={available:false,state:'unavailable',reason:'public-content-window-too-large',total:null,visible:null,hidden:null,unavailable:null,posts:null,replies:null,pendingReview:null,trendDays,daily:[]};
   if(all.length<=2000){
    const daily=window.dates.map(date=>({date,posts:0,replies:0})),byDate=new Map(daily.map(day=>[day.date,day]));let total=0,visible=0,hidden=0,unavailable=0,posts=0,replies=0;
    for(const row of all){const view=await read(row);if(!view||!this.matches(view,q))continue;total++;const state=visibilityState(view);if(state==='unavailable')unavailable++;else if(state==='hidden')hidden++;else visible++;if(view.kind==='post')posts++;else replies++;
     const date=new Date(Date.parse(view.createdAt)+28800000).toISOString().slice(0,10),day=byDate.get(date);if(day&&state==='visible')day[view.kind==='post'?'posts':'replies']++;
    }
    summary={available:true,state:'available',reason:null,total,visible,hidden,unavailable,posts,replies,pendingReview:null,trendDays,daily};
   }
   return {items,nextAfter:processed<rows.length&&last?key(last):null,scanTruncated:processed===200&&items.length<q.limit&&rows.length>200,summary,
    topics:sixTopics,tags:await this.tagsWithin(db),permissions:{canManage:['content.hide','content.restore','content.curate','content.batch.hide','content.batch.restore'].some(code=>permitted(actor,code))},checkedAt:this.now()};
  });
 }
 tags(operator){return this.run(operator,false,'community-tags-query',{},async(db,actor)=>({items:await this.tagsWithin(db),permissions:{canManage:permitted(actor,'content.tags.manage')},checkedAt:this.now()}));}
}
