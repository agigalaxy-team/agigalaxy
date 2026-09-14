import canonicalize from 'canonicalize';
import * as z from 'zod/v4';
import {digest} from './shared/digest.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {transaction} from './database.mjs';
import {summaryPreferenceSchema,summaryPutSchema,summaryPageSchema} from './shared/personal-summary-schema.mjs';
const stamp=n=>new Date(n*1000).toISOString(),day=86400;
const fail=(c,s=409)=>{throw new ServiceError(c,s);};
function parse(schema,x){const v=schema.safeParse(x);if(!v.success)fail('invalid_personal_summary_request',400);return v.data;}

// Metadata authority for derived fragments. No model or full-history read occurs.
export function createSummarySourceReader(chat){return async(db,actor,{roomId,messageId,revision})=>{
 try{
  await chat.requireRoom(db,actor,roomId);
  if(!messageId)return{available:true};
  const r=(await db.query(`SELECT m.*, EXISTS(SELECT 1 FROM chat_message_operations o WHERE o.message_id=m.message_id AND o.state='pending') AS edit_pending,
   EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=m.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased')) AS author_pending
   FROM chat_message_refs m WHERE m.message_id=$1 AND m.room_id=$2 FOR SHARE OF m`,[messageId,roomId])).rows[0];
  if(!r||r.state!=='accepted'||r.revision!==revision||Date.parse(r.expires_at)<=chat.now()*1000)return {available:false};
  if(r.edit_pending||r.author_pending&&r.subject_id!==actor.subjectId)return {available:false,temporarilyUnavailable:true};
  return {available:true,expiresAt:new Date(r.expires_at).toISOString(),authorId:r.subject_id,revision:r.revision,sequence:String(r.sequence)};
 }catch(e){if(e instanceof ServiceError&&[403,404].includes(e.status))return {available:false};throw e;}
};}

export class PersonalSummaryService {
 constructor({db,access,endpoint=access.endpoint,sourceReader,now=()=>access.now()}){
  if(new URL(endpoint).origin!==endpoint||new URL(endpoint).protocol!=='https:')throw new Error('Invalid summary service origin');
  Object.assign(this,{db,access,endpoint,sourceReader,now});
 }
 run(actor,write,fn){return write?this.access.runResourceWrite(actor,'binding',{},fn):this.access.runAuthorized(actor,'binding',fn);}
 async preferenceWithin(db,actor){const r=(await db.query('SELECT * FROM personal_summary_preferences WHERE subject_id=$1',[actor.subjectId])).rows[0];
  return r?{revision:r.revision,endpoint:r.endpoint,enabled:r.enabled,roomIds:r.room_ids,includeExisting:r.include_existing,
   enabledSince:new Date(r.enabled_since).toISOString(),audience:'owner-only',expiresAfterInactiveDays:30}
   :{revision:0,endpoint:this.endpoint,enabled:false,roomIds:null,includeExisting:true,enabledSince:null,audience:'owner-only',expiresAfterInactiveDays:30};
 }
 preferences(actor){return this.run(actor,false,db=>this.preferenceWithin(db,actor));}
 savePreference(actor,input){const x=parse(summaryPreferenceSchema,input);if(x.endpoint!==this.endpoint)fail('summary_target_mismatch',400);
  if(x.roomIds&&new Set(x.roomIds).size!==x.roomIds.length)fail('invalid_personal_summary_request',400);
  return this.run(actor,true,async db=>{
   await db.query(`INSERT INTO personal_summary_preferences(subject_id,revision,endpoint,enabled,enabled_since,updated_at)
    VALUES($1,0,$2,false,$3,$3) ON CONFLICT DO NOTHING`,[actor.subjectId,this.endpoint,stamp(this.now())]);
   const r=(await db.query('SELECT * FROM personal_summary_preferences WHERE subject_id=$1 FOR UPDATE',[actor.subjectId])).rows[0];
   if(r.revision!==x.expectedRevision)fail('summary_preference_conflict');
   await db.query(`UPDATE personal_summary_preferences SET revision=revision+1,enabled=$2,room_ids=$3,include_existing=$4,
    enabled_since=$5,updated_at=$6 WHERE subject_id=$1`,[actor.subjectId,x.enabled,JSON.stringify(x.roomIds),x.includeExisting,
    r.enabled&&x.enabled?r.enabled_since:stamp(this.now()),stamp(this.now())]);
   return this.preferenceWithin(db,actor);
  });
 }
 async filterContentWithin(db,actor,roomId,content){
  if(!content?.fragments)return {content:{},invalidated:false};
  if(!this.sourceReader)fail('summary_source_adapter_unavailable',503);
  const cache=new Map();const check=async ref=>{const key=ref.messageId+':'+ref.revision;if(!cache.has(key))cache.set(key,await this.sourceReader(db,actor,{roomId,...ref}));return cache.get(key);};
  const result=structuredClone(content),persisted=structuredClone(content),fragments=[],refs=[],retainedFragments=[],retainedRefs=[];
  for(const f of result.fragments){let valid=true,permanent=false;for(const ref of f.sourceRefs){const status=await check(ref);if(!status.available){valid=false;if(!status.temporarilyUnavailable)permanent=true;}}
   if(valid)fragments.push(f);if(!permanent)retainedFragments.push(f);}
  for(const ref of result.keyMessageRefs){const status=await check(ref);if(status.available)refs.push(ref);if(status.available||status.temporarilyUnavailable)retainedRefs.push(ref);}
  const invalidated=fragments.length!==result.fragments.length||refs.length!==result.keyMessageRefs.length;
  result.fragments=fragments;result.keyMessageRefs=refs;if(invalidated)result.coverage.complete=false;
  const storageChanged=retainedFragments.length!==persisted.fragments.length||retainedRefs.length!==persisted.keyMessageRefs.length;
  persisted.fragments=retainedFragments;persisted.keyMessageRefs=retainedRefs;if(storageChanged)persisted.coverage.complete=false;
  return{content:result,persistedContent:persisted,invalidated,storageChanged,temporarilyUnavailable:fragments.length<retainedFragments.length||refs.length<retainedRefs.length};
 }
 async viewWithin(db,actor,row,roomId){
  if(!row)return null;
  if(['current','conflict'].includes(row.state)&&Date.parse(row.expires_at)<=this.now()*1000){
   await db.query(`UPDATE personal_summary_versions SET state='expired',content='{}'::jsonb WHERE subject_id=$1 AND version_id=$2`,[actor.subjectId,row.version_id]);row={...row,state:'expired',content:{}};
  }
  const filtered=await this.filterContentWithin(db,actor,roomId,row.content);
  if(filtered.storageChanged)await db.query('UPDATE personal_summary_versions SET content=$3 WHERE subject_id=$1 AND version_id=$2',[actor.subjectId,row.version_id,JSON.stringify(filtered.persistedContent)]);
  return{versionId:row.version_id,summaryId:row.summary_id,revision:row.revision,baseRevision:row.base_revision,state:row.state,
   content:filtered.content,sourceInvalidated:filtered.invalidated,sourcesTemporarilyUnavailable:filtered.temporarilyUnavailable===true,updatedAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString()};
 }
 async getWithin(db,actor,summaryId){
  const h=(await db.query('SELECT * FROM personal_summary_heads WHERE subject_id=$1 AND summary_id=$2 FOR UPDATE',[actor.subjectId,summaryId])).rows[0];
  if(!h)return {summaryId,revision:0,current:null,conflicts:[],audience:'owner-only',sharedToRoom:false};
  const rows=(await db.query(`SELECT * FROM personal_summary_versions WHERE subject_id=$1 AND summary_id=$2 AND (version_id=$3 OR state='conflict') ORDER BY created_at,version_id`,[actor.subjectId,summaryId,h.current_version_id])).rows;
  let current=null;const conflicts=[];for(const row of rows){const v=await this.viewWithin(db,actor,row,h.room_id);if(row.version_id===h.current_version_id)current=v;else if(v.state==='conflict')conflicts.push(v);}
  return {summaryId,roomId:h.room_id,revision:h.revision,current,conflicts,audience:'owner-only',sharedToRoom:false};
 }
 get(actor,{summaryId}){parse(z.uuid(),summaryId);return this.run(actor,false,db=>this.getWithin(db,actor,summaryId));}
 async exportOwnedWithin(db,actor,input={}){const x=parse(summaryPageSchema,input);
  const rows=(await db.query(`SELECT summary_id FROM personal_summary_heads WHERE subject_id=$1 AND deleted_at IS NULL
   AND ($2::uuid IS NULL OR summary_id>$2) ORDER BY summary_id LIMIT $3`,[actor.subjectId,x.after??null,x.limit+1])).rows;
  const items=[];for(const r of rows.slice(0,x.limit))items.push(await this.getWithin(db,actor,r.summary_id));
  return {items,nextAfter:rows.length>x.limit?rows[x.limit-1].summary_id:null,audience:'owner-only'};
 }
 list(actor,input={}){return this.run(actor,false,db=>this.exportOwnedWithin(db,actor,input));}
 put(actor,input){const x=parse(summaryPutSchema,input),{preferenceRevision,...intent}=x,requestHash=digest(canonicalize(intent));return this.run(actor,true,async db=>{
  const p=(await db.query('SELECT * FROM personal_summary_preferences WHERE subject_id=$1 FOR SHARE',[actor.subjectId])).rows[0];
  if(!p?.enabled||p.endpoint!==this.endpoint||p.revision!==x.preferenceRevision||p.room_ids&&!p.room_ids.includes(x.roomId))fail('summary_sync_not_authorized',403);
  if(!this.sourceReader||!(await this.sourceReader(db,actor,{roomId:x.roomId})).available)fail('summary_room_unavailable',403);
  await db.query(`INSERT INTO personal_summary_heads(subject_id,summary_id,room_id,created_at,updated_at) VALUES($1,$2,$3,$4,$4) ON CONFLICT DO NOTHING`,[actor.subjectId,x.summaryId,x.roomId,stamp(this.now())]);
  const h=(await db.query('SELECT * FROM personal_summary_heads WHERE subject_id=$1 AND summary_id=$2 FOR UPDATE',[actor.subjectId,x.summaryId])).rows[0];
  if(h.room_id!==x.roomId)fail('summary_room_conflict');
  const replay=(await db.query('SELECT * FROM personal_summary_versions WHERE subject_id=$1 AND version_id=$2',[actor.subjectId,x.versionId])).rows[0];
  if(replay){if(replay.request_hash!==requestHash||replay.summary_id!==x.summaryId)fail('summary_operation_conflict');return {...await this.getWithin(db,actor,x.summaryId),operationVersionId:x.versionId,replayed:true};}
  const filtered=await this.filterContentWithin(db,actor,x.roomId,x.content);
  if(filtered.invalidated)fail('summary_sources_changed',409);
  const conflict=x.baseRevision!==h.revision,revision=conflict?h.revision:h.revision+1;
  if(!conflict){for(const id of x.resolveVersionIds){const r=(await db.query('SELECT state FROM personal_summary_versions WHERE subject_id=$1 AND summary_id=$2 AND version_id=$3',[actor.subjectId,x.summaryId,id])).rows[0];
   if(!r||r.state!=='conflict')fail('summary_resolution_conflict');}
   await db.query(`UPDATE personal_summary_versions SET state='superseded',content='{}'::jsonb WHERE subject_id=$1 AND summary_id=$2 AND (state='current' OR version_id=ANY($3::uuid[]))`,[actor.subjectId,x.summaryId,x.resolveVersionIds]);
  }
  await db.query(`INSERT INTO personal_summary_versions(subject_id,summary_id,version_id,base_revision,revision,request_hash,state,content,created_at,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[actor.subjectId,x.summaryId,x.versionId,x.baseRevision,revision,requestHash,conflict?'conflict':'current',JSON.stringify(x.content),stamp(this.now()),stamp(this.now()+30*day)]);
  if(!conflict)await db.query(`UPDATE personal_summary_heads SET revision=$3,current_version_id=$4,deleted_at=NULL,updated_at=$5 WHERE subject_id=$1 AND summary_id=$2`,[actor.subjectId,x.summaryId,revision,x.versionId,stamp(this.now())]);
  return {...await this.getWithin(db,actor,x.summaryId),operationVersionId:x.versionId,syncState:conflict?'conflict':'synced'};
 });}
 delete(actor,{summaryId,expectedRevision}){parse(z.uuid(),summaryId);parse(z.number().int().nonnegative(),expectedRevision);return this.run(actor,false,async db=>{
  const h=(await db.query('SELECT * FROM personal_summary_heads WHERE subject_id=$1 AND summary_id=$2 FOR UPDATE',[actor.subjectId,summaryId])).rows[0];
  if(!h)return {summaryId,deleted:true,localDeleted:false};
  if(!h.deleted_at&&h.revision!==expectedRevision)fail('summary_version_conflict');
  await db.query(`UPDATE personal_summary_versions SET state='deleted',content='{}'::jsonb WHERE subject_id=$1 AND summary_id=$2`,[actor.subjectId,summaryId]);
  if(!h.deleted_at)await db.query('UPDATE personal_summary_heads SET deleted_at=$3,revision=revision+1,updated_at=$3 WHERE subject_id=$1 AND summary_id=$2',[actor.subjectId,summaryId,stamp(this.now())]);
  return{summaryId,deleted:true,localDeleted:false};
 });}
 exportOwned(actor,input={}){return this.list(actor,input);}
 sources(actor,input){const x=parse(z.strictObject({roomId:z.uuid(),refs:z.array(z.strictObject({messageId:z.uuid(),revision:z.number().int().positive()})).max(100)}),input);
  return this.run(actor,false,async db=>{if(!this.sourceReader)fail('summary_source_adapter_unavailable',503);const items=[];
   for(const ref of x.refs)items.push({...ref,...await this.sourceReader(db,actor,{roomId:x.roomId,...ref})});return{items,checkedAt:stamp(this.now())};});}
 async eraseSubjectWithin(db,subjectId){
  await db.query(`UPDATE personal_summary_preferences SET enabled=false,room_ids=NULL,revision=revision+1 WHERE subject_id=$1`,[subjectId]);
  const r=await db.query(`UPDATE personal_summary_versions SET state='deleted',content='{}'::jsonb WHERE subject_id=$1 AND state IN ('current','conflict') RETURNING version_id`,[subjectId]);
  await db.query('UPDATE personal_summary_heads SET deleted_at=$2,revision=revision+1 WHERE subject_id=$1 AND deleted_at IS NULL',[subjectId,stamp(this.now())]);
  return {erasedVersions:r.rows.length,localDeleted:false,remainingMetadata:true};
 }
 eraseSubject(subjectId){return transaction(this.db,db=>this.eraseSubjectWithin(db,subjectId));}
 async purgeExpired(){return transaction(this.db,async db=>{const r=await db.query(`UPDATE personal_summary_versions SET state='expired',content='{}'::jsonb
  WHERE state IN ('current','conflict') AND expires_at<=$1 RETURNING version_id`,[stamp(this.now())]);return {expiredVersions:r.rows.length};});}
 async purgeInvalidSources({after=null,limit=20}={}){if(after)parse(z.uuid(),after);parse(z.number().int().min(1).max(100),limit);
  return transaction(this.db,async db=>{const rows=(await db.query(`SELECT v.*,h.room_id FROM personal_summary_versions v JOIN personal_summary_heads h
   ON h.subject_id=v.subject_id AND h.summary_id=v.summary_id WHERE v.state IN ('current','conflict') AND ($1::uuid IS NULL OR v.version_id>$1)
   ORDER BY v.version_id LIMIT $2`,[after,limit+1])).rows;let changed=0;
   for(const selected of rows.slice(0,limit)){
    // Same head-before-version order as put/delete; a concurrent supersede may
    // have erased this version after the scan and must never be overwritten.
    await db.query('SELECT summary_id FROM personal_summary_heads WHERE subject_id=$1 AND summary_id=$2 FOR UPDATE',[selected.subject_id,selected.summary_id]);
    const row=(await db.query('SELECT * FROM personal_summary_versions WHERE subject_id=$1 AND version_id=$2',[selected.subject_id,selected.version_id])).rows[0];
    if(!row||!['current','conflict'].includes(row.state))continue;
    const before=JSON.stringify(row.content);await this.viewWithin(db,{subjectId:row.subject_id},row,selected.room_id);
    const stored=(await db.query('SELECT content,state FROM personal_summary_versions WHERE subject_id=$1 AND version_id=$2',[row.subject_id,row.version_id])).rows[0];
    if(stored.state!==row.state||JSON.stringify(stored.content)!==before)changed++;}
   return{checked:Math.min(rows.length,limit),changed,nextAfter:rows.length>limit?rows[limit-1].version_id:null};});}
}
