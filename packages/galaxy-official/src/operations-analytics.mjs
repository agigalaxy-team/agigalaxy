import {publicReadBatch} from './discovery-runtime/public-read-batch.mjs';

const daySeconds=86400,shanghaiOffset=8*3600,publicSourceWave=100;
const iso=seconds=>new Date(seconds*1000).toISOString();
const dayOf=seconds=>new Date((seconds+shanghaiOffset)*1000).toISOString().slice(0,10);

export function operationsAnalyticsPeriod(now,days=7){
 const start=Math.floor((now+shanghaiOffset)/daySeconds)*daySeconds-shanghaiOffset-(days-1)*daySeconds;
 return {days,period:{from:iso(start),to:iso(now),timeZone:'Asia/Shanghai'},start,
  dates:Array.from({length:days},(_,index)=>dayOf(start+index*daySeconds))};
}

export const uncollectedOperationsUsage=()=>({available:false,state:'not-collected',reason:'usage-events-not-collected',
 visitors:null,pageViews:null,activeAccounts:null,returnRate:null,dailyActivity:[],retention:[]});

// Keep the original permission/audience/governance methods and their current
// endpoint/provider configuration. Only the clock and read locks differ for
// this caller's repeatable-read snapshot; nothing survives the current read.
function activityForumReader(forum,now){
 const reader=Object.create(forum);
 if(forum.access){reader.access=Object.create(forum.access);reader.access.now=()=>now;}
 reader.clock=()=>now;
 // Hidden-content checks only need a reply's parent linkage. Preserve their
 // original rules without calling the full reply/body projection.
 reader.reply=async(db,id)=>(await db.query('SELECT id,post_id,post_version_id FROM forum_replies_v1 WHERE id=$1',[id])).rows[0];
 reader.permissions=Object.create(forum.permissions);
 if(reader.access)reader.permissions.access=reader.access;
 reader.permissions.statusWithin=(db,id,options)=>forum.permissions.statusWithin.call(reader.permissions,db,id,{...options,lock:false});
 if(forum.accessRules){
  reader.accessRules=Object.create(forum.accessRules);reader.accessRules.forum=reader;
  reader.permissions.contentAudience=reader.accessRules.contentWithin.bind(reader.accessRules);
 }
 if(forum.governance){
  reader.governance=Object.create(forum.governance);reader.governance.forum=reader;
  reader.governance.permissions=reader.permissions;if(reader.access)reader.governance.access=reader.access;
 }
 return reader;
}

// This is a projection of existing public forum facts, not a website activity
// collector or an interest model. No narrative, bookmark, private message,
// notice, case evidence or security log is loaded as an analytics source.
// Every candidate retains its original account attribution and is checked by
// the forum's current anonymous reader and governance eligibility rules.
export async function publicForumActivityWithin(db,{forum,endpoint,now,days=7,accountId=null}){
 const window=operationsAnalyticsPeriod(now,days),base={days,period:window.period,
  basis:'current-public-content-by-first-publication-time',sourceTypes:['public-post','public-reply']};
 const unavailable=reason=>({...base,available:false,state:'unavailable',reason,totals:{posts:null,replies:null},daily:[],lastActivityAt:null});
 if(!forum?.permissions?.statusWithin||!forum?.hiddenWithin)return unavailable('public-activity-reader-unavailable');
 const reader=activityForumReader(forum,now),daily=window.dates.map(date=>({date,posts:0,replies:0})),byDate=new Map(daily.map(row=>[row.date,row]));
 let after=null,lastActivityAt=null;
 for(;;){
 const rows=(await db.query(`SELECT sources.*,occurred_at::text AS cursor_at FROM (
  SELECT 'post' AS kind,p.id AS post_id,v.id AS source_id,v.permission_id,v.payload_hash,p.created_at AS occurred_at,
   NULL::uuid AS parent_source_id,NULL::uuid AS parent_permission_id,NULL::text AS parent_payload_hash
  FROM forum_posts_v1 p JOIN forum_versions_v1 v ON v.id=p.current_version_id
   JOIN forum_events_v1 e ON e.id=v.publication_event_id
  WHERE p.state='published' AND p.erased_at IS NULL AND v.state='published' AND v.erased_at IS NULL
   AND e.erased_at IS NULL AND e.payload_text IS NOT NULL AND v.published_until>$1
   AND p.created_at>=$2 AND p.created_at<=$1 AND ($3::uuid IS NULL OR p.account_id=$3)
  UNION ALL
  SELECT 'reply' AS kind,r.post_id,r.id,r.permission_id,r.payload_hash,r.created_at,
   v.id AS parent_source_id,v.permission_id AS parent_permission_id,v.payload_hash AS parent_payload_hash
  FROM forum_replies_v1 r JOIN forum_events_v1 e ON e.id=r.publication_event_id
   JOIN forum_versions_v1 v ON v.id=r.post_version_id JOIN forum_posts_v1 p ON p.id=r.post_id
   JOIN forum_events_v1 pe ON pe.id=v.publication_event_id
  WHERE r.state='published' AND r.erased_at IS NULL AND e.erased_at IS NULL AND e.payload_text IS NOT NULL AND r.published_until>$1
   AND p.state='published' AND p.erased_at IS NULL AND v.state='published' AND v.erased_at IS NULL
   AND pe.erased_at IS NULL AND pe.payload_text IS NOT NULL AND v.published_until>$1
   AND r.created_at>=$2 AND r.created_at<=$1 AND ($3::uuid IS NULL OR r.account_id=$3)
 ) sources WHERE $4::timestamptz IS NULL OR (occurred_at,kind,source_id)>($4::timestamptz,$5::text,$6::uuid)
 ORDER BY occurred_at,kind,source_id LIMIT $7`,[window.period.to,window.period.from,accountId,after?.at??null,after?.kind??null,after?.id??null,publicSourceWave])).rows;
 if(!rows.length)break;
 // At most one bounded wave of logical readers and bound-query reuse. A
 // parent's permission is shared only with its identical current binding.
 const batch=publicReadBatch(db,{reuseKnownBindings:true}),permissionChecks=new Map();
 const allowed=async(sourceId,permissionId,payloadHash,postId,kind)=>{
  const key=JSON.stringify([kind,sourceId,permissionId,payloadHash,postId]);
  if(!permissionChecks.has(key))permissionChecks.set(key,(async()=>{
   const status=await reader.permissions.statusWithin(batch,permissionId,{visibility:'Public',payloadHash,
    action:kind==='post'?'forum.post.publish':'forum.reply.publish',objectId:sourceId,viewerActor:null,lock:false});
   if(!status.allowed||status.row?.account_id&&(await batch.query('SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2',[status.row.account_id,endpoint])).rows.length===0)return false;
   return !await reader.hiddenWithin(batch,kind==='post'?{kind:'post-version',postId,versionId:sourceId}:{kind:'reply',replyId:sourceId,contentRevision:1});
  })());
  return permissionChecks.get(key);
 };
 const qualified=await Promise.all(rows.map(async row=>{
   if(!await allowed(row.source_id,row.permission_id,row.payload_hash,row.post_id,row.kind))return false;
   if(row.kind==='reply'){
    if(!await allowed(row.parent_source_id,row.parent_permission_id,row.parent_payload_hash,row.post_id,'post'))return false;
   }
   return true;
 }));
 for(let index=0;index<rows.length;index++){
   if(!qualified[index])continue;const row=rows[index];
   const at=new Date(row.occurred_at).toISOString(),date=byDate.get(dayOf(Date.parse(at)/1000));
   if(!date)return unavailable('public-activity-source-invalid');
   if(row.kind==='post')date.posts++;else date.replies++;
   if(!lastActivityAt||at>lastActivityAt)lastActivityAt=at;
 }
 // PG's original timestamp text retains sub-millisecond precision. A Date
 // cursor could repeat a partial millisecond and silently double-count it.
 const tail=rows.at(-1);
 if(typeof tail.cursor_at!=='string'||!tail.cursor_at)return unavailable('public-activity-source-invalid');
 after={at:tail.cursor_at,kind:tail.kind,id:tail.source_id};
 if(rows.length<publicSourceWave)break;
 }
 return {...base,available:true,state:'available',reason:null,daily,
  totals:daily.reduce((total,row)=>({posts:total.posts+row.posts,replies:total.replies+row.replies}),{posts:0,replies:0}),lastActivityAt};
}

// Only metadata from real business commands belongs in recent operations.
// It is separate from the public usage projection above and contains no case
// explanation, recipient list, private content or model-generated conclusion.
export async function recentOperationsWithin(db,endpoint){
 const rows=(await db.query(`SELECT id,action,operator_id,account_id,created_at,
  COALESCE(selection->>'resourceId',selection->>'id',selection->>'sectionId',selection->>'reportId',selection->>'projectId',
   selection->>'methodId',selection->>'fileId',selection->>'noticeId',selection->>'runId',selection->>'jobId') AS resource_id
  FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id IS NOT NULL ORDER BY sequence DESC LIMIT 12`,[endpoint])).rows;
 return rows.map(row=>({id:row.id,action:row.action,operatorId:row.operator_id,accountId:row.account_id??null,
  resourceId:row.resource_id??null,createdAt:new Date(row.created_at).toISOString()}));
}
