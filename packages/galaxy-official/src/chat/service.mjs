import {chatActorRef} from "../chat-actors.mjs";
import {ServiceError} from "../shared/service-error.mjs";
import {transaction} from "../database.mjs";
import {chatMessageOperationsBlockedWithin,chatMessageOperationsBlockedSql} from "../chat-message-operations-gate.mjs";
import {day,stamp,fail} from './helpers.mjs';
import {ChatMessages} from './messages.mjs';

// Formal ChatService plus existing body-free readiness, worker-only archive lifecycle and bounded original owner export.
export class ChatService extends ChatMessages{
 // Only the loopback maintenance adapter exposes this body-free check. It
 // cannot project a room, choose an identity or read the message archive.
 async maintenanceReadiness(){if(typeof this.transport?.probe!=='function')fail('chat_transport_unavailable',503);return this.transport.probe();}
 async purgeOne(messageId){const r=(await this.db.query('SELECT * FROM chat_message_refs WHERE message_id=$1 AND purge_pending=true',[messageId])).rows[0];if(!r)return;
  if(!this.transport)fail('chat_transport_unavailable',503);const acknowledgement=await this.transport.erase({roomId:r.room_id,messageId:r.message_id});
  // The actual Prosody erase contract returns this exact positive flag. A
  // resolved promise or a negative/missing flag cannot clear the retry target.
  if(acknowledgement?.archiveDeleted!==true)fail('chat_archive_receipt_invalid',502);
  await transaction(this.db,async db=>{
   await db.query('UPDATE chat_message_refs SET purge_pending=false,content_bytes=0 WHERE message_id=$1 AND state IN (\'retracted\',\'expired\')',[messageId]);
   await db.query("UPDATE chat_message_operations SET state='cancelled' WHERE message_id=$1 AND state='pending'",[messageId]);
  });
 }
 // Worker-only: never expose maintenance methods through a user HTTP route.
 async purgeExpired({limit=100}={}){if(!Number.isInteger(limit)||limit<1||limit>1000)fail('invalid_chat_request',400);
  await this.db.query("UPDATE chat_message_refs SET state='expired',purge_pending=true WHERE expires_at<=$1 AND state IN ('pending','accepted')",[stamp(this.now())]);
  await this.db.query("UPDATE chat_rooms SET state='archived',revision=revision+1 WHERE state='owner-succession' AND succession_expires_at<=$1",[stamp(this.now())]);
  const rows=(await this.db.query('SELECT message_id FROM chat_message_refs WHERE purge_pending=true ORDER BY expires_at LIMIT $1',[limit])).rows;
  let deleted=0;for(const r of rows){await this.purgeOne(r.message_id);deleted++;}return{archiveDeleted:deleted};
 }
 async eraseSubject(subjectId,{limit=100}={}){
  if(!/^GUID[A-Z0-9]{28}$/.test(subjectId)||!Number.isInteger(limit)||limit<1||limit>1000)fail('invalid_chat_request',400);
  await transaction(this.db,async db=>{
   const rooms=(await db.query(`SELECT r.* FROM chat_rooms r JOIN chat_memberships m USING(room_id)
    WHERE m.subject_id=$1 AND m.left_at IS NULL ORDER BY r.room_id FOR UPDATE OF r`,[subjectId])).rows;
   for(const r of rooms){await db.query('UPDATE chat_memberships SET left_at=$3 WHERE room_id=$1 AND subject_id=$2',[r.room_id,subjectId,stamp(this.now())]);
    const members=await this.members(db,r.room_id),parties=new Set(members.map(m=>m.controller_ref));
    const state=!parties.size?'archived':r.owner_subject_id===subjectId?'owner-succession':parties.size===1&&r.mode==='ownerless'&&r.had_multiple?'single-member-decision':r.state;
    await db.query(`UPDATE chat_rooms SET state=$2,revision=revision+1,member_revision=member_revision+1,updated_at=$3,
     administrator_ids=$5,succession_expires_at=CASE WHEN $2='owner-succession' AND state<>'owner-succession' THEN $4 ELSE succession_expires_at END WHERE room_id=$1`,[r.room_id,state,stamp(this.now()),stamp(this.now()+7*day),JSON.stringify((r.administrator_ids??[]).filter(id=>id!==subjectId))]);
   }
   await db.query('UPDATE chat_agent_grants SET revoked_at=$2 WHERE subject_id=$1 AND revoked_at IS NULL',[subjectId,stamp(this.now())]);
   await db.query("UPDATE chat_message_refs SET state='retracted',purge_pending=true,retracted_at=COALESCE(retracted_at,$2) WHERE subject_id=$1 AND state IN ('pending','accepted')",[subjectId,stamp(this.now())]);
  });
  const rows=(await this.db.query('SELECT message_id FROM chat_message_refs WHERE subject_id=$1 AND purge_pending=true ORDER BY sequence LIMIT $2',[subjectId,limit])).rows;
  let deleted=0;for(const r of rows){try{await this.purgeOne(r.message_id);deleted++;}catch(e){if(!(e instanceof ServiceError))throw e;break;}}
  const pending=Number((await this.db.query('SELECT count(*) AS n FROM chat_message_refs WHERE subject_id=$1 AND purge_pending=true',[subjectId])).rows[0].n);
  return{subjectId,archiveDeleted:deleted,pendingArchiveDeletes:pending,complete:pending===0,agentGrantsRevoked:true,membershipsLeft:true,othersMessagesDeleted:false};
 }
 exportOwned(actor,{after='0',limit=100}={}){if(!/^\d+$/.test(after)||!Number.isInteger(limit)||limit<1||limit>100)fail('invalid_chat_request',400);
  return this.run(actor,false,async db=>{const rows=(await db.query(`SELECT m.* FROM chat_message_refs m WHERE m.subject_id=$1 AND m.sequence>$2
   AND m.state='accepted' AND m.expires_at>$3 AND NOT ${chatMessageOperationsBlockedSql('m')} ORDER BY m.sequence LIMIT $4`,[chatActorRef(actor),after,stamp(this.now()),limit+1])).rows;
   const messages=[];for(const r of rows.slice(0,limit)){if(!this.transport)fail('chat_transport_unavailable',503);
    const contents=await this.transport.exportOwn({roomId:r.room_id,subjectId:chatActorRef(actor),ids:[r.archive_id]});
    const current=(await db.query('SELECT * FROM chat_message_refs WHERE message_id=$1 AND subject_id=$2',[r.message_id,chatActorRef(actor)])).rows[0];
    if(current?.state==='accepted'&&current.revision===r.revision&&Date.parse(current.expires_at)>this.now()*1000&&!await chatMessageOperationsBlockedWithin(db,{messageId:r.message_id})&&contents[0]
     &&(contents[0].revision===undefined||contents[0].revision===r.revision))messages.push({...this.receipt(current),roomId:r.room_id,sequence:String(r.sequence),text:contents[0].text});}
   return{messages,next:rows.length>limit?String(rows[limit-1].sequence):null,scope:'own-authored-retained-messages'};
  });
 }
}
