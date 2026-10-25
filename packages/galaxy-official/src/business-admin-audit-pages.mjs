import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {businessAuditActionCodes,businessAuditMetadata} from './business-admin-audit-view.mjs';
import {withPermissionAuditLinks} from './business-admin-permission-audit-links.mjs';
import {withBusinessAuditAttribution} from './business-admin-audit-attribution.mjs';
import {hasOperationsPermission} from './operations-permission-catalog.mjs';

export const businessAuditReadActions=Object.freeze(['users-query','user-read','audit-read','chat-reports-query','chat-report-read','chat-report-attachment',
 'operations-summary-read','community-posts-query','community-post-read','community-sections-query','community-section-read',
 'community-reports-query','community-report-read','resources-query','resource-read','files-query','file-read','feedback-query','feedback-read',
 'community-content-query','community-content-read','community-content-batch-preview','community-tags-query','maintenance-query','maintenance-logs-query',
 'file-cleanup-read','file-access-read','smtp-query','smtp-dns-check']);
export const businessAuditBusinessActions=Object.freeze(businessAuditActionCodes.filter(action=>!businessAuditReadActions.includes(action)));
const known=new Set(businessAuditActionCodes),resourceKeys=['resourceId','id','sectionId','reportId','projectId','methodId','fileId','feedbackId','noticeId','runId','jobId','planId','modelRecordId','registrationId','roleId','versionId'];
const scalarValues=value=>Array.isArray(value)?value.flatMap(scalarValues):value&&typeof value==='object'?Object.values(value).flatMap(scalarValues):
 ['string','number','boolean'].includes(typeof value)?[String(value)]:[];
const fail=(code,status=409)=>{throw new ServiceError(code,status);};
const scopeOf=query=>({accountId:query.accountId??null,resourceId:query.resourceId?.toLowerCase()??null,kind:query.kind,
 action:query.action??null,day:query.day??null,query:query.query,sort:query.sort??'newest'});
const ownerOf=actor=>JSON.stringify([actor.kind,actor.operatorId,actor.executionId??null]);
const safeRow=(row,names)=>businessAuditMetadata({...row,action:known.has(row.action)?row.action:'unknown',operator_display_name:names.get(row.operator_id)??null});
const conditions=`a.endpoint=$1 AND ($2::uuid IS NULL OR a.account_id=$2)
 AND ($3::text IS NULL OR a.action=$3) AND ($4::text[] IS NULL OR a.action=ANY($4))
 AND ($5::date IS NULL OR (a.created_at>=($5::date::timestamp AT TIME ZONE 'Asia/Shanghai')
 AND a.created_at<(($5::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')))`;

// These are process capacity limits, not a retention policy or a truncated
// result total. A range that cannot fit returns narrow-required with no pages.
const CANDIDATES=100000,BATCH=1000,SNAPSHOT_SECONDS=300,CACHE_BYTES=24*1024*1024,CACHE_ENTRIES=16;
export class BusinessAuditPages {
 constructor({db,endpoint,now}){Object.assign(this,{db,endpoint,now});this.entries=new Map();}
 drop(id){const entry=this.entries.get(id);if(entry){clearTimeout(entry.timer);this.entries.delete(id);}}
 close(){for(const id of this.entries.keys())this.drop(id);}
 forget(actor){const owner=ownerOf(actor);for(const[id,entry]of this.entries)if(entry.owner===owner)this.drop(id);}
 prune(){for(const[id,entry]of this.entries)if(entry.expiresAt<=this.now())this.drop(id);}
 bytes(){let bytes=0;for(const entry of this.entries.values())bytes+=entry.bytes;return bytes;}
 async create(actor,scope){
  this.prune();
  const kinds=scope.kind==='reads'?businessAuditReadActions:scope.kind==='business'?businessAuditBusinessActions:null;
  const captured=await transaction(this.db,async db=>{
   // One MVCC view freezes the actual visible identities, including gaps left
   // by an uncommitted lower sequence. A numeric high-water mark alone cannot.
   const rows=(await db.query(`SELECT a.sequence,a.operator_id,
    CASE WHEN a.actor_kind='business-operator' THEN NULLIF(BTRIM(p.display_name),'') ELSE NULL END AS operator_display_name,
    count(*) OVER() AS candidate_count FROM business_admin_audit_v1 a
    LEFT JOIN operations_operator_principals_v1 p ON p.endpoint=a.endpoint AND p.operator_id=a.operator_id AND a.actor_kind='business-operator'
    WHERE ${conditions} ORDER BY a.created_at ${scope.sort==='oldest'?'ASC':'DESC'},a.sequence ${scope.sort==='oldest'?'ASC':'DESC'} LIMIT $6`,
    [this.endpoint,scope.accountId,scope.action,kinds,scope.day,CANDIDATES+1])).rows;
   const actions=(await db.query('SELECT DISTINCT action FROM business_admin_audit_v1 WHERE endpoint=$1 AND action=ANY($2::text[]) ORDER BY action',
    [this.endpoint,businessAuditActionCodes])).rows.map(row=>row.action);
   return {rows,actions};
  },{isolation:'repeatable read'});
  const count=Number(captured.rows[0]?.candidate_count??0);if(!Number.isSafeInteger(count)||count<0)fail('audit_query_unavailable',503);
  const id=randomUUID(),at=this.now(),names=new Map(),projecting=!!(scope.resourceId||scope.query);
  let bytes=512,state=count>CANDIDATES?'narrow-required':projecting&&count?'scanning':'ready',reason=count>CANDIDATES?'candidate-limit':null;
  let ids=new BigInt64Array(state==='narrow-required'?0:count),matches=projecting&&state!=='narrow-required'?new Uint32Array(count):null;
  if(state!=='narrow-required')for(let i=0;i<captured.rows.length;i++){
   const row=captured.rows[i];ids[i]=BigInt(row.sequence);
   if(!names.has(row.operator_id)){names.set(row.operator_id,row.operator_display_name??null);bytes+=Buffer.byteLength(row.operator_id)+Buffer.byteLength(row.operator_display_name??'')+64;}
  }
  bytes+=ids.byteLength+(matches?.byteLength??0);
  if(bytes>CACHE_BYTES){ids=new BigInt64Array();matches=null;names.clear();bytes=512;state='narrow-required';reason='cache-capacity';}
  // Expiration is fixed at creation. Reading a snapshot never renews it.
  const entry={id,owner:ownerOf(actor),canReadTasks:hasOperationsPermission(actor,'autonomy.read'),scope,createdAt:at,expiresAt:at+SNAPSHOT_SECONDS,usedAt:at,
   ids,matches,names,bytes,candidates:count,inspected:projecting?0:count,matched:projecting?0:count,state,reason,actions:captured.actions,scan:null,timer:null};
  if(state==='narrow-required'){entry.inspected=0;entry.matched=0;}
  while(this.entries.size>=CACHE_ENTRIES||this.bytes()+bytes>CACHE_BYTES){const oldest=[...this.entries.values()].sort((a,b)=>a.usedAt-b.usedAt)[0];if(!oldest)break;this.drop(oldest.id);}
  this.entries.set(id,entry);entry.timer=setTimeout(()=>this.drop(id),SNAPSHOT_SECONDS*1000);entry.timer.unref?.();
  return entry;
 }
 async rows(entry,ids){
  if(!ids.length)return new Map();
  const linkedRows=await withPermissionAuditLinks(this.db,{endpoint:this.endpoint,rows:(await this.db.query('SELECT * FROM business_admin_audit_v1 WHERE endpoint=$1 AND sequence=ANY($2::bigint[])',[this.endpoint,ids])).rows});
  const rows=await withBusinessAuditAttribution(this.db,{endpoint:this.endpoint,rows:linkedRows,canReadTasks:entry.canReadTasks});
  const bySequence=new Map(rows.map(row=>[String(row.sequence),row]));
  if(bySequence.size!==ids.length){this.drop(entry.id);fail('audit_snapshot_expired');}
  return bySequence;
 }
 async advance(entry){
  if(entry.state!=='scanning')return;
  if(entry.scan){await entry.scan;return;}
  entry.scan=(async()=>{
   const start=entry.inspected,end=Math.min(entry.ids.length,start+BATCH),ids=Array.from(entry.ids.subarray(start,end),String),rows=await this.rows(entry,ids),needle=entry.scope.query.toLocaleLowerCase('zh-CN');
   // Only the already permitted, schema-closed projection is matched. Never
   // search raw selection/result JSON, including via a hidden boolean match.
   const found=[];
   for(let index=start;index<end;index++){
    const item=safeRow(rows.get(String(entry.ids[index])),entry.names);
    if(entry.scope.resourceId&&![...resourceKeys.map(key=>item.selection[key]),item.attribution?.taskId,item.attribution?.cardId].some(id=>typeof id==='string'&&id.toLowerCase()===entry.scope.resourceId))continue;
    if(needle&&!scalarValues(item).some(value=>value.toLocaleLowerCase('zh-CN').includes(needle)))continue;
    found.push(index);
   }
   for(const index of found)entry.matches[entry.matched++]=index;
   entry.inspected=end;if(end===entry.ids.length)entry.state='ready';
  })();
  try{await entry.scan;}finally{entry.scan=null;}
 }
 async read(actor,query){
  if(query.action&&!known.has(query.action))fail('invalid_business_admin_request',400);
  this.prune();const scope=scopeOf(query);let entry;
  if(query.snapshot){
   entry=this.entries.get(query.snapshot);if(!entry)fail('audit_snapshot_expired');
   if(entry.owner!==ownerOf(actor))fail('audit_snapshot_unavailable',404);
   if(!isDeepStrictEqual(entry.scope,scope))fail('audit_snapshot_mismatch');
  }else entry=await this.create(actor,scope);
  entry.canReadTasks=hasOperationsPermission(actor,'autonomy.read');entry.usedAt=this.now();await this.advance(entry);
  if(!this.entries.has(entry.id)||entry.expiresAt<=this.now()){this.drop(entry.id);fail('audit_snapshot_expired');}
  const page=query.page??1,pageSize=query.pageSize??30,ready=entry.state==='ready',total=ready?entry.matched:null,totalPages=ready?Math.ceil(total/pageSize):null;
  const first=(page-1)*pageSize,last=ready?Math.min(entry.matched,first+pageSize):0,ids=[];
  if(ready)for(let index=first;index<last;index++)ids.push(String(entry.ids[entry.matches?entry.matches[index]:index]));
  const rows=await this.rows(entry,ids),items=ids.map(id=>safeRow(rows.get(id),entry.names)),at=this.now();
  return {items,nextAfter:null,scanLimited:entry.state==='scanning',checkedAt:at,readExpiresAt:at+30,metadataOnly:true,actions:[...entry.actions],
   pagination:{page,pageSize,total,totalPages,hasPrevious:page>1,hasNext:ready?page<totalPages:null,snapshot:entry.id,snapshotCreatedAt:entry.createdAt,snapshotExpiresAt:entry.expiresAt,sort:scope.sort},
   search:{state:entry.state,inspected:entry.inspected,candidates:entry.candidates,matched:entry.matched,complete:ready,reasonCode:entry.reason}};
 }
}
