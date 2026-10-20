import {randomUUID,createHash} from 'node:crypto';
import canonicalize from 'canonicalize';
import {ServiceError} from './shared/service-error.mjs';
import {transaction} from './database.mjs';
import {readAttachmentPayload} from './infrastructure/attachment-payload.mjs';
import {attachmentPolicySchema,defaultAttachmentPolicy} from './shared/chat-attachments-schema.mjs';
import {forumAttachmentPrepareSchema,forumAttachmentReadSchema,forumAttachmentContentSchema,forumAttachmentQuerySchema,forumAttachmentReferencesSchema} from './shared/forum-attachments-v1-schema.mjs';
const stamp=n=>new Date(n*1000).toISOString(),hash=x=>createHash('sha256').update(x).digest('hex');
const fail=(code,status=409)=>{throw new ServiceError(code,status);};
const parse=(schema,input)=>{const r=schema.safeParse(input);if(!r.success)fail('invalid_attachment_request',400);return r.data;};
const sourceKey=source=>source.replyId?'reply:'+source.replyId:'post:'+source.versionId;

export class ForumAttachmentsV1Service{
 constructor({forum,db=forum?.access.db,now=forum?()=>forum.clock():()=>Math.floor(Date.now()/1000),accounts=forum?.accounts,store,scanner,policy=defaultAttachmentPolicy}){Object.assign(this,{forum,db,now,accounts,store,scanner});this.policy=attachmentPolicySchema.parse(policy);}
 specification(){return{supported:!!this.store&&!!this.scanner,maxFileBytes:this.policy.maxFileBytes,maxFilesPerMessage:4,purpose:'post-or-reply-attachment',draftRetentionDays:7,retention:'published-source-expiry',publicStorageUrls:false,automaticEvidence:false,scanGuaranteesSafety:false};}
 configured(){if(!this.store||!this.scanner)fail('attachment_service_unavailable',503);}
 expired(row){return Date.parse(row.expires_at??row.prepare_expires_at)<=this.now()*1000;}
 state(row){return row.purged_at?'erased':row.revoked_at?'revoked':this.expired(row)?'expired':row.state;}
 receipt(row){return{attachmentId:row.id,name:row.name,mediaType:row.media_type,size:Number(row.byte_size),sha256:row.sha256,state:this.state(row),createdAt:row.created_at,uploadedAt:row.uploaded_at,expiresAt:row.expires_at??row.prepare_expires_at,uploadRetryAt:row.lease_until??null,uploadRetryable:!row.published_at&&!row.revoked_at&&!row.purged_at&&!this.expired(row)&&['prepared','uploading'].includes(row.state)&&(!row.lease_until||Date.parse(row.lease_until)<=this.now()*1000),scan:row.scan_result,cleanupPending:row.purge_pending,objectRemoved:!!row.purged_at};}
 async row(db,id,lock='SHARE'){return(await db.query(`SELECT * FROM forum_attachments_v1 WHERE id=$1 FOR ${lock}`,[id])).rows[0];}
 run(actor,write,operation){if(!actor)fail('account_verification_required',401);return this.accounts.runAuthorized(actor,write?'assistance':'binding',async(db,_authorization,current)=>{const account=await this.accounts.resolveWithin(db,current,{lock:write});return operation(db,current,account);},{resourceWrite:write});}
 async owned(db,actor,account,id,lock='SHARE'){const row=await this.row(db,id,lock);if(!row||row.account_id!==account.id)fail('attachment_unavailable',404);return row;}
 async prepare(actor,input){const x=parse(forumAttachmentPrepareSchema,input);this.configured();if(x.size>this.policy.maxFileBytes)fail('attachment_too_large',413);
  return this.run(actor,true,async(db,current,account)=>{
   const requestHash=hash(canonicalize(x)),old=await this.row(db,x.attachmentId,'UPDATE');if(old){if(old.account_id!==account.id||old.request_hash!==requestHash)fail('attachment_operation_conflict');return this.receipt(old);}
   await db.query('SELECT pg_advisory_xact_lock(734912320,0)');
   const total=(await db.query(`SELECT COALESCE(sum(byte_size),0)::text AS all_bytes,COALESCE(sum(CASE WHEN owner=$1 THEN byte_size ELSE 0 END),0)::text AS owner_bytes FROM
    (SELECT byte_size,'account:'||account_id::text AS owner FROM forum_attachments_v1 WHERE purged_at IS NULL UNION ALL SELECT byte_size,subject_id AS owner FROM chat_attachments WHERE purged_at IS NULL) files`,['account:'+account.id])).rows[0];
   if(BigInt(total.all_bytes)+BigInt(x.size)>BigInt(this.policy.maxGlobalBytes)||BigInt(total.owner_bytes)+BigInt(x.size)>BigInt(this.policy.maxSubjectBytes))fail('attachment_storage_quota_exceeded');
   const row=(await db.query(`INSERT INTO forum_attachments_v1(id,account_id,subject_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,created_at,prepare_expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[x.attachmentId,account.id,current.subjectId??null,requestHash,x.name,x.mediaType,x.size,x.sha256,'forum-attachments/'+x.attachmentId,this.store.keyId,stamp(this.now()),stamp(this.now()+3600)])).rows[0];return this.receipt(row);
  });
 }
 get(actor,input){const x=parse(forumAttachmentReadSchema,input);return this.run(actor,false,async(db,current,account)=>this.receipt(await this.owned(db,current,account,x.attachmentId)));}
 queryOwn(actor,input){const x=parse(forumAttachmentQuerySchema,input);return this.run(actor,false,async(db,_current,account)=>{const rows=(await db.query('SELECT * FROM forum_attachments_v1 WHERE account_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[account.id,x.after??null,x.limit+1])).rows;return{items:rows.slice(0,x.limit).map(row=>this.receipt(row)),nextAfter:rows.length>x.limit?rows[x.limit-1].id:null};});}
 async upload(actor,id,stream,{contentLength,contentType='application/octet-stream',onBytes=()=>{}}={}){
  parse(forumAttachmentReadSchema,{attachmentId:id});this.configured();if(contentType!=='application/octet-stream')fail('attachment_media_type_required',415);const lease=randomUUID();
  const started=await this.run(actor,true,async(db,current,account)=>{const row=await this.owned(db,current,account,id,'UPDATE');
   if(['scan-pending','scanning','available'].includes(this.state(row)))return{done:true,row};
   if(this.expired(row)||row.revoked_at||row.purged_at||row.published_at||!['prepared','uploading'].includes(row.state))fail('attachment_upload_unavailable');
   if(contentLength!==Number(row.byte_size))fail('attachment_size_mismatch',400);if(row.lease_until&&Date.parse(row.lease_until)>this.now()*1000)fail('attachment_upload_in_progress');
   await db.query('SELECT pg_advisory_xact_lock(734912320,0)');
   const count=(await db.query("SELECT (SELECT count(*) FROM chat_attachments WHERE state='uploading' AND lease_until>$1)+(SELECT count(*) FROM forum_attachments_v1 WHERE state='uploading' AND lease_until>$1) AS n",[stamp(this.now())])).rows[0];if(Number(count.n)>=4)fail('attachment_upload_capacity',429);
   return{row:(await db.query("UPDATE forum_attachments_v1 SET state='uploading',lease_id=$2,lease_until=$3,uploaded_at=COALESCE(uploaded_at,$4),expires_at=COALESCE(expires_at,$5),last_error=NULL WHERE id=$1 RETURNING *",[id,lease,stamp(this.now()+120),stamp(this.now()),stamp(this.now()+7*86400)])).rows[0]};
  });if(started.done)return this.receipt(started.row);const r=started.row;let putAttempted=false;
  try{const bytes=await readAttachmentPayload(stream,{size:Number(r.byte_size),sha256:r.sha256,mediaType:r.media_type,maxFileBytes:this.policy.maxFileBytes,onBytes});putAttempted=true;await this.store.put({key:r.storage_key,bytes,sha256:r.sha256});
   return await this.run(actor,true,async(db,current,account)=>{const row=await this.owned(db,current,account,id,'UPDATE');if(row.lease_id!==lease||row.revoked_at||this.expired(row))fail('attachment_upload_no_longer_allowed');return this.receipt((await db.query("UPDATE forum_attachments_v1 SET state='scan-pending',lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 RETURNING *",[id])).rows[0]);});
  }catch(error){const invalid=['attachment_too_large','attachment_digest_mismatch','attachment_file_format_invalid','attachment_media_type_mismatch','attachment_media_type_unrecognized'].includes(error.code);
   await this.db.query("UPDATE forum_attachments_v1 SET lease_until=$3,last_error=$4,purge_pending=purge_pending OR revoked_at IS NOT NULL OR $5,state=CASE WHEN $5 THEN 'blocked' WHEN $6 THEN 'uploading' ELSE 'prepared' END WHERE id=$1 AND lease_id=$2",[id,lease,stamp(this.now()),error instanceof ServiceError?error.code:'attachment_upload_failed',invalid,putAttempted]).catch(()=>{});throw error;
  }
 }
 async bindWithin(db,actor,{references,postId,versionId,replyId=null,publishedUntil}){if(!references?.length)return;const refs=parse(forumAttachmentReferencesSchema,references),account=await this.accounts.resolveWithin(db,actor),source=replyId?{replyId}:{postId,versionId};
  for(const ref of [...refs].sort((a,b)=>a.id.localeCompare(b.id))){const row=await this.row(db,ref.id,'UPDATE');if(!row||row.account_id!==account.id||row.sha256!==ref.sha256||row.purge_pending||this.state(row)!=='available')fail('attachment_reference_unavailable');
   await db.query('INSERT INTO forum_attachment_links_v1(attachment_id,source_key,post_id,version_id,reply_id,published_until,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[row.id,sourceKey(source),postId,versionId,replyId,stamp(publishedUntil),stamp(this.now())]);
   await db.query('UPDATE forum_attachments_v1 SET published_at=COALESCE(published_at,$2),expires_at=(SELECT max(published_until) FROM forum_attachment_links_v1 WHERE attachment_id=$1) WHERE id=$1',[row.id,stamp(this.now())]);
  }
 }
 async metadataWithin(db,references){if(!references?.length)return[];const rows=(await db.query('SELECT * FROM forum_attachments_v1 WHERE id=ANY($1::uuid[])',[references.map(ref=>ref.id)])).rows,map=new Map(rows.map(row=>[row.id,row]));return references.map(ref=>{const row=map.get(ref.id);return row&&row.sha256===ref.sha256?this.receipt(row):{attachmentId:ref.id,state:'unavailable',contentAvailable:false};});}
 async readableWithin(db,actor,row,source){if(!row||this.state(row)!=='available')fail('attachment_content_unavailable',404);
  const view=source.replyId?await this.forum.readReplyWithin(db,source.replyId,{actor}):await this.forum.readVersionWithin(db,source.postId,source.versionId,{actor});
  if(view.availability!=='available'||source.replyId&&view.parentAvailability!=='available'||!view.payload?.attachments?.some(ref=>ref.id===row.id&&ref.sha256===row.sha256))fail('attachment_source_unavailable',404);
  const link=(await db.query('SELECT 1 FROM forum_attachment_links_v1 WHERE attachment_id=$1 AND source_key=$2 AND published_until>$3',[row.id,sourceKey(source),stamp(this.now())])).rows[0];if(!link)fail('attachment_source_unavailable',404);
 }
 content(actor,input){const x=parse(forumAttachmentContentSchema,input);this.configured();return this.forum.runRead(actor,async db=>{let row=await this.row(db,x.attachmentId);await this.readableWithin(db,actor,row,x.source);const bytes=await this.store.get({key:row.storage_key,keyId:row.encryption_key_id,size:Number(row.byte_size)});if(!bytes||hash(bytes)!==row.sha256)fail('attachment_storage_integrity_failed',502);row=await this.row(db,x.attachmentId);await this.readableWithin(db,actor,row,x.source);return{bytes,name:row.name,mediaType:row.media_type,sha256:row.sha256,attachmentId:row.id};});}
 revoke(actor,input){const x=parse(forumAttachmentReadSchema,input);return this.run(actor,true,async(db,current,account)=>{const row=await this.owned(db,current,account,x.attachmentId,'UPDATE');return this.receipt((await db.query('UPDATE forum_attachments_v1 SET revoked_at=COALESCE(revoked_at,$2),purge_pending=true WHERE id=$1 RETURNING *',[row.id,stamp(this.now())])).rows[0]);});}
 async scanPending({limit=1}={}){this.configured();if(!Number.isInteger(limit)||limit<1||limit>4)fail('invalid_attachment_scan_limit',400);let scanned=0;
  for(let i=0;i<limit;i++){const lease=randomUUID(),row=await transaction(this.db,async db=>{const row=(await db.query("SELECT * FROM forum_attachments_v1 WHERE state IN ('scan-pending','scanning') AND revoked_at IS NULL AND purge_pending=false AND expires_at>$1 AND (lease_until IS NULL OR lease_until<=$1) ORDER BY uploaded_at LIMIT 1 FOR UPDATE SKIP LOCKED",[stamp(this.now())])).rows[0];if(!row)return null;return(await db.query("UPDATE forum_attachments_v1 SET state='scanning',lease_id=$2,lease_until=$3,scan_attempts=scan_attempts+1 WHERE id=$1 RETURNING *",[row.id,lease,stamp(this.now()+120)])).rows[0];});if(!row)break;
   try{const bytes=await this.store.get({key:row.storage_key,keyId:row.encryption_key_id,size:Number(row.byte_size)});if(!bytes||hash(bytes)!==row.sha256)fail('attachment_storage_integrity_failed');const result=await this.scanner.scan(bytes);if(!['clean','blocked'].includes(result.state))fail('attachment_scan_incomplete',503);
    await transaction(this.db,async db=>{const current=await this.row(db,row.id,'UPDATE');if(current.lease_id!==lease)return;const invalid=current.revoked_at||this.expired(current);await db.query("UPDATE forum_attachments_v1 SET state=$2,scan_result=$3,lease_id=NULL,lease_until=NULL,last_error=NULL,purge_pending=$4 WHERE id=$1",[row.id,invalid||result.state==='blocked'?'blocked':'available',JSON.stringify(result),!!invalid||result.state==='blocked']);});scanned++;
   }catch(error){await this.db.query("UPDATE forum_attachments_v1 SET state='scan-pending',lease_id=NULL,lease_until=$3,last_error=$4 WHERE id=$1 AND lease_id=$2",[row.id,lease,stamp(this.now()+60),error instanceof ServiceError?error.code:'attachment_scan_failed']);}
  }return{scanned};
 }
 async purgeExpired({limit=20}={}){this.configured();if(!Number.isInteger(limit)||limit<1||limit>100)fail('invalid_attachment_cleanup_limit',400);
  await this.db.query(`UPDATE forum_attachments_v1 a SET purge_pending=true WHERE a.purged_at IS NULL AND (a.revoked_at IS NOT NULL OR COALESCE(a.expires_at,a.prepare_expires_at)<=$1 OR
   (a.published_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM forum_attachment_links_v1 l JOIN forum_posts_v1 p ON p.id=l.post_id JOIN forum_versions_v1 v ON v.id=l.version_id LEFT JOIN forum_replies_v1 r ON r.id=l.reply_id
    WHERE l.attachment_id=a.id AND l.published_until>$1 AND p.state='published' AND v.state='published' AND (l.reply_id IS NULL OR r.state='published'))))`,[stamp(this.now())]);
  const rows=(await this.db.query('SELECT id FROM forum_attachments_v1 WHERE purge_pending=true AND purged_at IS NULL AND (lease_until IS NULL OR lease_until<=$1) ORDER BY created_at LIMIT $2',[stamp(this.now()),limit])).rows;let removed=0;
  for(const {id} of rows){await transaction(this.db,async db=>{const row=await this.row(db,id,'UPDATE');if(!row.purge_pending||row.purged_at||row.lease_until&&Date.parse(row.lease_until)>this.now()*1000)return;await this.store.erase({key:row.storage_key});await db.query("UPDATE forum_attachments_v1 SET state='erased',name='',media_type='',purge_pending=false,purged_at=$2,lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1",[id,stamp(this.now())]);removed++;});}
  const result=await this.db.query('DELETE FROM forum_attachments_v1 WHERE purged_at<$1',[stamp(this.now()-180*86400)]);return{objectRemoved:removed,metadataRemoved:result.rowCount??0};
 }
}
