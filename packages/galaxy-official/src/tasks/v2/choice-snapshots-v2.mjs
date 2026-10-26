import canonicalize from 'canonicalize';
import {digest} from "../../shared/digest.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {transaction} from "../../infrastructure/database.mjs";
import {choicePreferenceSchema,choicePutSchema,choicePutIntent,choiceGetSchema,choicePageSchema,choiceDeleteSchema,choiceReceiptQuerySchema,choiceReceiptResultSchema} from "../../shared/choice-snapshot-schema-v2.mjs";
const stamp=n=>new Date(n*1000).toISOString(),day=86400,key=r=>`${r.type}:${r.id}:${r.version}`;
const contentDigest=content=>{const {localVersion:_localVersion,...effective}=content;return digest(canonicalize(effective));};
const fail=(code,status=409)=>{throw new ServiceError(code,status);};
function parse(schema,x){const p=schema.safeParse(x);if(!p.success)fail('invalid_choice_snapshot_request',400);return p.data;}
export class ChoiceSnapshotServiceV2 {
 constructor(access,{sourceReader}){Object.assign(this,{access,sourceReader,db:access.db,endpoint:access.endpoint});}
 now(){return this.access.now();}
 run(actor,write,fn){return write?this.access.runResourceWrite(actor,'binding',{},fn):this.access.runAuthorized(actor,'binding',fn);}
 async preferenceWithin(db,actor){const p=(await db.query('SELECT * FROM choice_snapshot_preferences WHERE subject_id=$1',[actor.subjectId])).rows[0];
  return{category:'choice-snapshot',revision:p?.revision??0,endpoint:this.endpoint,enabled:p?.enabled??false,snapshotIds:p?.snapshot_ids??[],audience:'owner-only',contentInactiveDays:30,personalSummaryPreferenceApplied:false};}
 preferences(actor){return this.run(actor,false,db=>this.preferenceWithin(db,actor));}
 savePreference(actor,input){const x=parse(choicePreferenceSchema,input);if(x.endpoint!==this.endpoint)fail('choice_endpoint_mismatch',400);return this.run(actor,true,async db=>{
  await db.query('INSERT INTO choice_snapshot_preferences(subject_id,endpoint,updated_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[actor.subjectId,this.endpoint,stamp(this.now())]);
  const p=(await db.query('SELECT * FROM choice_snapshot_preferences WHERE subject_id=$1 FOR UPDATE',[actor.subjectId])).rows[0];
  if(p.revision!==x.expectedRevision)fail('choice_preference_conflict');
  await db.query('UPDATE choice_snapshot_preferences SET enabled=$2,snapshot_ids=$3,revision=revision+1,updated_at=$4 WHERE subject_id=$1',[actor.subjectId,x.enabled,JSON.stringify(x.snapshotIds),stamp(this.now())]);
  return this.preferenceWithin(db,actor);
 });}
 async viewWithin(db,actor,row){
  if(!row)return null;let state=row.state,content=row.content;const statuses=[];
  if(['current','conflict','invalidated'].includes(state)&&Date.parse(row.expires_at)<=this.now()*1000){state='expired';content={};
   await db.query("UPDATE choice_snapshot_versions SET state='expired',content='{}',dependencies='[]' WHERE subject_id=$1 AND version_id=$2",[actor.subjectId,row.version_id]);}
  if(['current','conflict'].includes(state)){
   for(const dependency of row.dependencies)statuses.push(await this.sourceReader.statusWithin(db,actor,dependency));
   for(const ref of content.resultRefs??[]){try{await this.sourceReader.resultWithin(db,actor,ref);statuses.push({resultRef:ref,state:'current'});}catch(e){if(!(e instanceof ServiceError)||![403,404,409,422].includes(e.status))throw e;statuses.push({resultRef:ref,state:'unavailable'});}}
   if(statuses.some(s=>s.state!=='current'))content={...content,visibleRationale:null,rationaleUnavailable:true};
  }
  return{snapshotId:row.snapshot_id,versionId:row.version_id,revision:row.revision,baseRevision:row.base_revision,state,content,
   sourceStatus:statuses,priorRationaleCurrent:!content.rationaleUnavailable&&statuses.length>0&&statuses.every(s=>s.state==='current'),queryContextReevaluated:false,
   createdAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString(),selectionIsApplication:false};
 }
 async getWithin(db,actor,id){const h=(await db.query('SELECT * FROM choice_snapshot_heads WHERE subject_id=$1 AND snapshot_id=$2 FOR UPDATE',[actor.subjectId,id])).rows[0];
  if(!h)return{snapshotId:id,revision:0,current:null,conflicts:[],audience:'owner-only'};
  const rows=(await db.query("SELECT * FROM choice_snapshot_versions WHERE subject_id=$1 AND snapshot_id=$2 AND (version_id=$3 OR state='conflict') ORDER BY created_at,version_id",[actor.subjectId,id,h.current_version_id])).rows;
  let current=null;const conflicts=[];for(const r of rows){const v=await this.viewWithin(db,actor,r);if(r.version_id===h.current_version_id)current=v;else if(v.state==='conflict')conflicts.push(v);}
  return{snapshotId:id,revision:h.revision,current,conflicts,audience:'owner-only',shared:false,deleted:!!h.deleted_at};
 }
 get(actor,input){const x=parse(choiceGetSchema,input);return this.run(actor,false,db=>this.getWithin(db,actor,x.snapshotId));}
 receipt(actor,input){const x=parse(choiceReceiptQuerySchema,input);return this.run(actor,false,db=>this.receiptWithin(db,actor.subjectId,x));}
 async receiptWithin(db,subjectId,input){const x=parse(choiceReceiptQuerySchema,input);
  // Historical acceptance is independent from current synchronization and
  // source permission. SELECT only retained metadata; no head/body projection,
  // source lookup, expiry write or new receipt ledger after owner deletion.
  const row=(await db.query(`SELECT snapshot_id,version_id,request_hash,base_revision,revision,state,created_at,expires_at
   FROM choice_snapshot_versions WHERE subject_id=$1 AND version_id=$2`,[subjectId,x.versionId])).rows[0];
  const common={...x,authority:'accepted-operation-only',audience:'owner-only',currentAccessGranted:false,contentReturned:false,sourceAccessChecked:false};
  if(!row)return choiceReceiptResultSchema.parse({...common,state:'absent',absenceMeaning:'no-retained-owner-operation'});
  if(row.snapshot_id!==x.snapshotId||row.request_hash!==x.requestHash)return choiceReceiptResultSchema.parse({...common,state:'conflict',reason:'original-operation-mismatch'});
  return choiceReceiptResultSchema.parse({...common,state:'acknowledged',receipt:{snapshotId:row.snapshot_id,versionId:row.version_id,requestHash:row.request_hash,
   baseRevision:row.base_revision,revision:row.revision,storedState:row.state,acceptedAt:new Date(row.created_at).toISOString(),contentExpiresAt:new Date(row.expires_at).toISOString(),
   contentRetentionDue:Date.parse(row.expires_at)<=this.now()*1000}});
 }
 async exportOwnedWithin(db,actor,input={}){const x=parse(choicePageSchema,input),rows=(await db.query('SELECT snapshot_id FROM choice_snapshot_heads WHERE subject_id=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR snapshot_id>$2) ORDER BY snapshot_id LIMIT $3',[actor.subjectId,x.after??null,x.limit+1])).rows;
  const items=[];for(const r of rows.slice(0,x.limit))items.push(await this.getWithin(db,actor,r.snapshot_id));return{items,nextAfter:rows.length>x.limit?rows[x.limit-1].snapshot_id:null,audience:'owner-only'};}
 list(actor,input={}){return this.run(actor,false,db=>this.exportOwnedWithin(db,actor,input));}
 put(actor,input){const x=parse(choicePutSchema,input),witnesses=x.witnesses,hash=digest(canonicalize(choicePutIntent(x)));return this.run(actor,true,async db=>{
  const p=(await db.query('SELECT * FROM choice_snapshot_preferences WHERE subject_id=$1 FOR SHARE',[actor.subjectId])).rows[0];
  if(!p?.enabled||p.endpoint!==this.endpoint||p.revision!==x.preferenceRevision||!p.snapshot_ids.includes(x.snapshotId))fail('choice_sync_not_authorized',403);
  await db.query('INSERT INTO choice_snapshot_heads(subject_id,snapshot_id,created_at,updated_at) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING',[actor.subjectId,x.snapshotId,stamp(this.now())]);
  const h=(await db.query('SELECT * FROM choice_snapshot_heads WHERE subject_id=$1 AND snapshot_id=$2 FOR UPDATE',[actor.subjectId,x.snapshotId])).rows[0];
  const replay=(await db.query('SELECT * FROM choice_snapshot_versions WHERE subject_id=$1 AND version_id=$2',[actor.subjectId,x.versionId])).rows[0];
  if(replay){if(replay.snapshot_id!==x.snapshotId||replay.request_hash!==hash)fail('choice_operation_conflict');return{...await this.getWithin(db,actor,x.snapshotId),operationVersionId:x.versionId,replayed:true};}
  const byRef=new Map(witnesses.map(w=>[key({type:w.search.type,...w.ref}),w]));
  if(byRef.size!==x.content.candidateRefs.length||x.content.candidateRefs.some(r=>!byRef.has(key(r))))fail('choice_witness_mismatch',400);
  const dependencies=[];for(const ref of x.content.candidateRefs)dependencies.push(await this.sourceReader.witnessWithin(db,actor,byRef.get(key(ref))));
  for(const ref of x.content.resultRefs)await this.sourceReader.resultWithin(db,actor,ref);
  // Old or deleted heads do not silently overwrite a later device. The user's
  // retained alternative is independent and must be explicitly resolved.
  const conflict=x.baseRevision!==h.revision,revision=conflict?h.revision:h.revision+1;
  const previous=h.current_version_id?(await db.query('SELECT content,expires_at FROM choice_snapshot_versions WHERE subject_id=$1 AND version_id=$2',[actor.subjectId,h.current_version_id])).rows[0]:null;
  const unchanged=previous?.content?.candidateRefs&&contentDigest(previous.content)===contentDigest(x.content);
  const expiresAt=unchanged?new Date(previous.expires_at).toISOString():stamp(this.now()+30*day);
  if(unchanged&&Date.parse(expiresAt)<=this.now()*1000)fail('choice_expired_content_requires_new_choice');
  if(conflict&&x.resolveVersionIds.length)fail('choice_resolution_conflict');
  if(!conflict){for(const id of x.resolveVersionIds){const old=(await db.query('SELECT state FROM choice_snapshot_versions WHERE subject_id=$1 AND snapshot_id=$2 AND version_id=$3',[actor.subjectId,x.snapshotId,id])).rows[0];if(old?.state!=='conflict')fail('choice_resolution_conflict');}
   await db.query("UPDATE choice_snapshot_versions SET state='superseded',content='{}',dependencies='[]' WHERE subject_id=$1 AND snapshot_id=$2 AND (state='current' OR version_id=ANY($3::uuid[]))",[actor.subjectId,x.snapshotId,x.resolveVersionIds]);}
  await db.query('INSERT INTO choice_snapshot_versions(subject_id,snapshot_id,version_id,base_revision,revision,request_hash,state,content,dependencies,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
   [actor.subjectId,x.snapshotId,x.versionId,x.baseRevision,revision,hash,conflict?'conflict':'current',JSON.stringify(x.content),JSON.stringify(dependencies),stamp(this.now()),expiresAt]);
  if(!conflict)await db.query('UPDATE choice_snapshot_heads SET revision=$3,current_version_id=$4,deleted_at=NULL,updated_at=$5 WHERE subject_id=$1 AND snapshot_id=$2',[actor.subjectId,x.snapshotId,revision,x.versionId,stamp(this.now())]);
  return{...await this.getWithin(db,actor,x.snapshotId),operationVersionId:x.versionId,syncState:conflict?'conflict':'synced'};
 });}
 delete(actor,input){const x=parse(choiceDeleteSchema,input);return this.run(actor,false,async db=>{
  const h=(await db.query('SELECT * FROM choice_snapshot_heads WHERE subject_id=$1 AND snapshot_id=$2 FOR UPDATE',[actor.subjectId,x.snapshotId])).rows[0];
  if(!h)return{snapshotId:x.snapshotId,deleted:true,localDeleted:false};if(!h.deleted_at&&h.revision!==x.expectedRevision)fail('choice_revision_conflict');
  await db.query("UPDATE choice_snapshot_versions SET state='deleted',content='{}',dependencies='[]' WHERE subject_id=$1 AND snapshot_id=$2",[actor.subjectId,x.snapshotId]);
  if(!h.deleted_at)await db.query('UPDATE choice_snapshot_heads SET deleted_at=$3,revision=revision+1,updated_at=$3 WHERE subject_id=$1 AND snapshot_id=$2',[actor.subjectId,x.snapshotId,stamp(this.now())]);
  return{snapshotId:x.snapshotId,deleted:true,localDeleted:false};
 });}
 async purgeExpiredWithin(db){const r=await db.query("UPDATE choice_snapshot_versions SET state='expired',content='{}',dependencies='[]' WHERE (subject_id,version_id) IN (SELECT subject_id,version_id FROM choice_snapshot_versions WHERE state IN ('current','conflict','invalidated') AND expires_at<=$1 ORDER BY expires_at,version_id LIMIT 100)",[stamp(this.now())]);return{expiredChoiceVersions:r.rowCount};}
 purgeExpired(){return transaction(this.db,db=>this.purgeExpiredWithin(db));}
 async purgeInvalidSources({after=null,limit=20}={}){
  if(!Number.isInteger(limit)||limit<1||limit>20)fail('invalid_choice_cleanup',400);
  return transaction(this.db,async db=>{
   const cursor=after?JSON.parse(after):null;
   const rows=(await db.query("SELECT subject_id,snapshot_id,version_id FROM choice_snapshot_versions WHERE state IN ('current','conflict') AND NOT (content ? 'rationaleUnavailable') AND ($1::uuid IS NULL OR (version_id,subject_id)>($1::uuid,$2::text)) ORDER BY version_id,subject_id LIMIT $3",[cursor?.versionId??null,cursor?.subjectId??null,limit+1])).rows;let redacted=0;
   for(const selected of rows.slice(0,limit)){
    await db.query('SELECT snapshot_id FROM choice_snapshot_heads WHERE subject_id=$1 AND snapshot_id=$2 FOR UPDATE',[selected.subject_id,selected.snapshot_id]);
    const row=(await db.query('SELECT * FROM choice_snapshot_versions WHERE subject_id=$1 AND version_id=$2',[selected.subject_id,selected.version_id])).rows[0];
    if(!row||!['current','conflict'].includes(row.state))continue;
    // This internal erasure-only pass represents the actual stored replica
    // owner, never the source author. It exposes no data and creates no grant.
    const owner={subjectId:row.subject_id,scopes:['history','assistance','capsules','proof','builders']};
    const view=await this.viewWithin(db,owner,row);
    if(view.content.rationaleUnavailable&&view.sourceStatus.some(s=>['changed','unavailable'].includes(s.state))){await db.query("UPDATE choice_snapshot_versions SET content=(content-'visibleRationale')||'{\"rationaleUnavailable\":true,\"visibleRationale\":null}'::jsonb WHERE subject_id=$1 AND version_id=$2",[row.subject_id,row.version_id]);redacted++;}
   }
   return{checked:Math.min(rows.length,limit),redacted,nextAfter:rows.length>limit?JSON.stringify({versionId:rows[limit-1].version_id,subjectId:rows[limit-1].subject_id}):null};
  });
 }
}
