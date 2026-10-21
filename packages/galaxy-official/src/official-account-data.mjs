import {z} from 'zod';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {expirePrivateConversationsWithin} from './operations/private-conversation-retention.mjs';
import {archiveAfterSchema,archiveCursorFor,archiveCursorAfter} from './shared/account-archive-cursor.mjs';
import {accountUidPattern,ensureOfficialAccountProfileWithin} from './official-account-uid.mjs';
import {changeAccountTypeWithin} from './business-admin-domain.mjs';

const retention=z.number().int().min(1).max(36500).nullable();
const selection=z.strictObject({workspaceId:z.string().min(1).max(512).nullable(),sessionIds:z.array(z.string().min(1).max(256)).min(1).max(1000),scopeId:z.uuid().optional()});
const parse=(schema,value)=>{const result=schema.safeParse(value);if(!result.success)throw new ServiceError('invalid_account_data');return result.data;};
const iso=value=>new Date(value).toISOString();
const archiveView=row=>({id:row.id,title:row.title,selection:row.selection,state:row.state,originSubjectId:row.origin_subject_id??null,byteLength:Number(row.byte_length),chunkCount:row.chunk_count,
  createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),expiresAt:row.expires_at?iso(row.expires_at):null,visibility:'Private'});

// This store accepts verified account actors only. Galaxy identities keep their
// own signed operations and cannot acquire account settings through association.
export class OfficialAccountData {
  constructor({db,endpoint,now=()=>Math.floor(Date.now()/1000),inTransaction=false}){Object.assign(this,{db,endpoint,now,inTransaction});}
  run(operation){return this.inTransaction?operation(this.db):transaction(this.db,operation);}
  owner(actor){if(actor?.kind!=='official-account'||actor.endpoint!==this.endpoint||!z.uuid().safeParse(actor.accountId).success)throw new ServiceError('official_account_login_required',401);return actor.accountId;}
  archiveOwner(actor){if(actor?.kind==='linked-id'&&actor.accountAuthorized===true&&actor.endpoint===this.endpoint&&z.uuid().safeParse(actor.accountId).success&&/^GUID[0-9A-Z]{28}$/.test(actor.subjectId??''))return actor.accountId;return this.owner(actor);}
  archiveOrigin(actor){return actor?.kind==='linked-id'?actor.subjectId:null;}
  ensureWithin(db,accountId,{subjectType=null}={}){
    return ensureOfficialAccountProfileWithin(db,accountId,{subjectType,now:this.now()});
  }
  async settings(actor){const id=this.owner(actor),row=await this.ensureWithin(this.db,id);
    const history=(await this.db.query('SELECT previous_type,next_type,revision,reason,basis,created_at FROM official_account_type_history_v1 WHERE account_id=$1 ORDER BY revision DESC LIMIT 100',[id])).rows;
    return {accountId:id,uid:row.uid,subjectType:row.subject_type,displayName:row.display_name,revision:row.revision,
      publicQuery:{enabled:row.query_enabled,scope:row.query_scope,showLinkedIds:row.query_linked_ids===true,showExternalCredentials:row.query_external_credentials===true},archiveRetentionDays:row.archive_retention_days,
      typeHistory:history.map(v=>({previousType:v.previous_type,nextType:v.next_type,revision:v.revision,reason:v.reason,basis:v.basis,createdAt:iso(v.created_at)}))};}
  async updateSettings(actor,input){const id=this.owner(actor),data=parse(z.strictObject({expectedRevision:z.number().int().nonnegative(),displayName:z.string().trim().min(1).max(120).nullable(),
    publicQuery:z.strictObject({enabled:z.boolean(),scope:z.enum(['profile','profile-and-public-posts']),showLinkedIds:z.boolean().optional(),showExternalCredentials:z.boolean().optional()}),archiveRetentionDays:retention}),input);
    return this.run(async db=>{const profile=await this.ensureWithin(db,id),row=(await db.query('SELECT * FROM official_account_profiles_v1 WHERE account_id=$1 FOR UPDATE',[id])).rows[0];
      if(row.revision!==data.expectedRevision)throw new ServiceError('account_settings_changed',409);
      await db.query(`UPDATE official_account_profiles_v1 SET display_name=$2,query_enabled=$3,query_scope=$4,archive_retention_days=$5,revision=revision+1,updated_at=$6,
        query_linked_ids=$7,query_external_credentials=$8 WHERE account_id=$1`,
        [id,data.displayName??profile.uid,data.publicQuery.enabled,data.publicQuery.scope,data.archiveRetentionDays,iso(this.now()*1000),
          data.publicQuery.showLinkedIds??row.query_linked_ids??false,data.publicQuery.showExternalCredentials??row.query_external_credentials??false]);
      // A changed cleanup preference applies to the owner's existing archives
      // from their original creation time. Content already expired is not read.
      await db.query(`UPDATE private_conversation_archives_v1 SET expires_at=CASE WHEN $2::integer IS NULL THEN NULL ELSE created_at+($2::text||' days')::interval END WHERE account_id=$1`,[id,data.archiveRetentionDays]);
      return {accountId:id,revision:row.revision+1};});}
  async changeType(actor,input){const accountId=this.owner(actor);
    return this.run(db=>changeAccountTypeWithin(db,{accountId,endpoint:this.endpoint,now:this.now(),source:{kind:'account-owner',accountId},input}));}
  async publicProfileByUid(uid,options={}){
    if(typeof uid!=='string'||!accountUidPattern.test(uid.toUpperCase()))throw new ServiceError('not_found',404);
    const row=(await this.db.query(`SELECT a.id FROM community_accounts a JOIN official_account_profiles_v1 p ON p.account_id=a.id
      WHERE a.uid=$1 AND a.endpoint=$2 AND p.query_enabled=true`,[uid.toUpperCase(),this.endpoint])).rows[0];
    if(!row)throw new ServiceError('not_found',404);
    return this.publicProfile(row.id,options);
  }
  async publicProfile(accountId,{publicPosts}={}){parse(z.uuid(),accountId);const row=(await this.db.query(`SELECT p.*,a.uid,
    (SELECT h.actor_kind FROM official_account_type_history_v1 h WHERE h.account_id=p.account_id ORDER BY h.revision DESC LIMIT 1) AS type_actor
    FROM official_account_profiles_v1 p JOIN community_accounts a ON a.id=p.account_id
    WHERE p.account_id=$1 AND a.endpoint=$2 AND p.query_enabled=true`,[accountId,this.endpoint])).rows[0];
    if(!row)throw new ServiceError('not_found',404);
    return {accountId,uid:row.uid,displayName:row.display_name,subjectType:row.subject_type,typeSource:row.type_actor==='business-operator'?'operator-recorded-statement':'account-owner-statement',
      publicQuery:{scope:row.query_scope,showLinkedIds:row.query_linked_ids===true,showExternalCredentials:row.query_external_credentials===true},
      ...(row.query_scope==='profile-and-public-posts'&&publicPosts?{posts:await publicPosts(accountId)}:{})};}
  async cleanup(actor){const id=this.archiveOwner(actor);return this.run(async db=>({deleted:await expirePrivateConversationsWithin(db,this.now(),{accountId:id,originSubjectId:this.archiveOrigin(actor)})}));}
  async listArchives(actor,input={}){const id=this.archiveOwner(actor),data=parse(z.strictObject({after:archiveAfterSchema.optional(),limit:z.number().int().min(1).max(100).default(50)}),input),origin=this.archiveOrigin(actor);await this.cleanup(actor);
    const context={accountId:id,originSubjectId:origin};let cursor=archiveCursorFor(data.after,context);
    if(cursor?.legacy){cursor=(await this.db.query('SELECT created_at,id FROM private_conversation_archives_v1 WHERE id=$1 AND account_id=$2 AND ($3::text IS NULL OR origin_subject_id=$3)',[cursor.id,id,origin])).rows[0];if(!cursor)throw new ServiceError('invalid_archive_cursor');}
    const rows=(await this.db.query(`SELECT * FROM private_conversation_archives_v1 WHERE account_id=$1 AND (expires_at IS NULL OR expires_at>$2) AND ($3::text IS NULL OR origin_subject_id=$3)
      AND ($4::timestamptz IS NULL OR created_at<$4 OR (created_at=$4 AND id>$5::uuid)) ORDER BY created_at DESC,id LIMIT $6`,[id,iso(this.now()*1000),origin,cursor?.created_at??null,cursor?.id??null,data.limit+1])).rows;
    return {archives:rows.slice(0,data.limit).map(archiveView),nextAfter:rows.length>data.limit?archiveCursorAfter(rows[data.limit-1],context):null};}
  async archiveStatus(actor,input){const id=this.archiveOwner(actor),data=parse(z.strictObject({id:z.uuid()}),input);await this.cleanup(actor);
    const row=(await this.db.query('SELECT * FROM private_conversation_archives_v1 WHERE id=$1 AND account_id=$2 AND ($3::text IS NULL OR origin_subject_id=$3)',[data.id,id,this.archiveOrigin(actor)])).rows[0];
    if(row){if(row.expires_at&&Date.parse(row.expires_at)<=this.now()*1000)return {id:data.id,state:'expired',cleanupPending:true,storedSequences:[]};const chunks=(await this.db.query('SELECT sequence FROM private_conversation_chunks_v1 WHERE archive_id=$1 ORDER BY sequence',[data.id])).rows;return {id:data.id,state:row.state,archive:archiveView(row),storedSequences:chunks.map(v=>v.sequence)};}
    const deleted=(await this.db.query('SELECT reason,deleted_at,scope_id FROM private_conversation_deletions_v1 WHERE archive_id=$1 AND account_id=$2 AND ($3::text IS NULL OR origin_subject_id=$3)',[data.id,id,this.archiveOrigin(actor)])).rows[0];
    return deleted?{id:data.id,state:'deleted',reason:deleted.reason,scopeId:deleted.scope_id,deletedAt:iso(deleted.deleted_at),storedSequences:[]}:{id:data.id,state:'absent',storedSequences:[]};}
  async createArchive(actor,input){const id=this.archiveOwner(actor),data=parse(z.strictObject({id:z.uuid(),title:z.string().trim().min(1).max(240),selection,
    uploadLevel:z.literal('conversation-archive'),includeFullConversation:z.literal(true)}),input);
    if(new Set(data.selection.sessionIds).size!==data.selection.sessionIds.length)throw new ServiceError('invalid_archive_selection');
    return this.run(async db=>{
    await this.ensureWithin(db,id);const row=(await db.query('SELECT archive_retention_days FROM official_account_profiles_v1 WHERE account_id=$1 FOR UPDATE',[id])).rows[0];
    if((await db.query("SELECT 1 FROM private_conversation_deletions_v1 WHERE account_id=$1 AND (archive_id=$2 OR ($3::uuid IS NOT NULL AND scope_id=$3 AND reason='owner-deleted')) LIMIT 1",[id,data.id,data.selection.scopeId??null])).rows.length)throw new ServiceError('archive_deleted',409);
    const at=iso(this.now()*1000),expires=row.archive_retention_days?iso((this.now()+row.archive_retention_days*86400)*1000):null;
    const inserted=(await db.query(`INSERT INTO private_conversation_archives_v1(id,account_id,origin_subject_id,title,selection,created_at,updated_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING *`,[data.id,id,this.archiveOrigin(actor),data.title,JSON.stringify(data.selection),at,expires])).rows[0];
    if(inserted)return archiveView(inserted);
    const old=(await db.query('SELECT * FROM private_conversation_archives_v1 WHERE id=$1 AND account_id=$2',[data.id,id])).rows[0];
    if(!old||old.origin_subject_id!==this.archiveOrigin(actor)||old.title!==data.title||old.selection.workspaceId!==data.selection.workspaceId||old.selection.scopeId!==data.selection.scopeId||JSON.stringify(old.selection.sessionIds)!==JSON.stringify(data.selection.sessionIds))throw new ServiceError('archive_conflict',409);
    return archiveView(old);});}
  async archiveWithin(db,accountId,id,origin=null){const row=(await db.query('SELECT * FROM private_conversation_archives_v1 WHERE id=$1 AND account_id=$2 AND ($3::text IS NULL OR origin_subject_id=$3) FOR UPDATE',[id,accountId,origin])).rows[0];
    if(!row||row.expires_at&&Date.parse(row.expires_at)<=this.now()*1000)throw new ServiceError('not_found',404);return row;}
  async appendChunk(actor,input){const accountId=this.archiveOwner(actor),data=parse(z.strictObject({id:z.uuid(),sequence:z.number().int().min(0).max(65535),content:z.string().min(1)}),input),bytes=Buffer.byteLength(data.content,'utf8');
    if(bytes>262144)throw new ServiceError('archive_chunk_too_large',413);
    return this.run(async db=>{const row=await this.archiveWithin(db,accountId,data.id,this.archiveOrigin(actor));
      const old=(await db.query('SELECT content FROM private_conversation_chunks_v1 WHERE archive_id=$1 AND sequence=$2',[data.id,data.sequence])).rows[0];
      if(old){if(old.content!==data.content)throw new ServiceError('archive_chunk_conflict',409);return {id:data.id,sequence:data.sequence,stored:true};}
      if(row.state!=='uploading')throw new ServiceError('archive_already_complete',409);
      if(Number(row.byte_length)+bytes>67108864)throw new ServiceError('archive_too_large',413);
      await db.query('INSERT INTO private_conversation_chunks_v1(archive_id,sequence,content,byte_length) VALUES($1,$2,$3,$4)',[data.id,data.sequence,data.content,bytes]);
      await db.query('UPDATE private_conversation_archives_v1 SET byte_length=byte_length+$2,updated_at=$3 WHERE id=$1',[data.id,bytes,iso(this.now()*1000)]);
      return {id:data.id,sequence:data.sequence,stored:true};});}
  async completeArchive(actor,input){const accountId=this.archiveOwner(actor),data=parse(z.strictObject({id:z.uuid(),chunkCount:z.number().int().min(1).max(65536)}),input);
    return this.run(async db=>{const archive=await this.archiveWithin(db,accountId,data.id,this.archiveOrigin(actor));
      if(archive.state==='ready'){if(archive.chunk_count!==data.chunkCount)throw new ServiceError('archive_conflict',409);return archiveView(archive);}
      const chunks=(await db.query('SELECT sequence FROM private_conversation_chunks_v1 WHERE archive_id=$1 ORDER BY sequence',[data.id])).rows;
      if(chunks.length!==data.chunkCount||chunks.some((v,i)=>v.sequence!==i))throw new ServiceError('archive_incomplete',409);
      return archiveView((await db.query(`UPDATE private_conversation_archives_v1 SET state='ready',chunk_count=$2,updated_at=$3 WHERE id=$1 RETURNING *`,[data.id,data.chunkCount,iso(this.now()*1000)])).rows[0]);});}
  async exportChunk(actor,input){const accountId=this.archiveOwner(actor),data=parse(z.strictObject({id:z.uuid(),sequence:z.number().int().nonnegative()}),input);
    return this.run(async db=>{const archive=await this.archiveWithin(db,accountId,data.id,this.archiveOrigin(actor));
      if(archive.state!=='ready')throw new ServiceError('archive_incomplete',409);
      const chunk=(await db.query('SELECT content FROM private_conversation_chunks_v1 WHERE archive_id=$1 AND sequence=$2',[data.id,data.sequence])).rows[0];
      if(!chunk)throw new ServiceError('not_found',404);return {archive:archiveView(archive),sequence:data.sequence,content:chunk.content,nextSequence:data.sequence+1<archive.chunk_count?data.sequence+1:null};});}
  async deleteArchive(actor,input){const accountId=this.archiveOwner(actor),{id}=parse(z.strictObject({id:z.uuid()}),input);return this.run(async db=>{
    await this.ensureWithin(db,accountId);await db.query('SELECT account_id FROM official_account_profiles_v1 WHERE account_id=$1 FOR UPDATE',[accountId]);
    const row=(await db.query('DELETE FROM private_conversation_archives_v1 WHERE id=$1 AND account_id=$2 AND ($3::text IS NULL OR origin_subject_id=$3) RETURNING selection,origin_subject_id',[id,accountId,this.archiveOrigin(actor)])).rows[0];
    if(row)await db.query(`INSERT INTO private_conversation_deletions_v1(archive_id,account_id,scope_id,origin_subject_id,reason,deleted_at) VALUES($1,$2,$3,$4,'owner-deleted',$5) ON CONFLICT(archive_id) DO NOTHING`,[id,accountId,row.selection.scopeId??null,row.origin_subject_id,iso(this.now()*1000)]);
    return {id,deleted:!!row||(await db.query('SELECT 1 FROM private_conversation_deletions_v1 WHERE archive_id=$1 AND account_id=$2 AND ($3::text IS NULL OR origin_subject_id=$3)',[id,accountId,this.archiveOrigin(actor)])).rows.length>0};});}
}
