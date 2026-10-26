import canonicalize from 'canonicalize';
import { digest } from "../shared/digest.mjs";
import { ServiceError } from "../shared/service-error.mjs";

// M12-approved internal seam. Contact owns both signed choices; M12 owns room
// semantics. No nested transaction, task fabrication, or network projection.
export function createChatContactAdapter(chat) {
  return async (db,{contactId,roomId,initiatorId,recipientId,title})=>{
    const contact=(await db.query('SELECT * FROM contacts_v2 WHERE id=$1 FOR UPDATE',[contactId])).rows[0];
    if(!contact||contact.state!=='accepted'||!contact.response_event_id||contact.initiator_id!==initiatorId||contact.recipient_id!==recipientId)
      throw new ServiceError('contact_room_authorization_required',403);
    const requestHash=digest(canonicalize({kind:'contact-room',contactId,roomId,initiatorId,recipientId,title}));
    const old=(await db.query('SELECT * FROM chat_rooms WHERE room_id=$1 OR (creator_subject_id=$2 AND operation_id=$3) FOR UPDATE',[roomId,initiatorId,contactId])).rows;
    if(old.length){
      if(old.length!==1||old[0].room_id!==roomId||old[0].operation_id!==contactId||old[0].creator_subject_id!==initiatorId||old[0].request_hash!==requestHash)
        throw new ServiceError('contact_room_conflict',409);
      return {roomId,replayed:true};
    }
    for(const subjectId of [initiatorId,recipientId])await chat.requireAccount(db,{subjectId});
    const memberships=[];
    for(const subjectId of [initiatorId,recipientId]) {
      const controller=await chat.resolveControlParty(db,subjectId);
      if(typeof controller!=='string'||!controller)throw new ServiceError('chat_control_relationship_unavailable',503);
      memberships.push({subjectId,controller});
    }
    const independent=new Set(memberships.map(m=>m.controller)).size,multiple=independent>1,at=new Date(chat.now()*1000).toISOString();
    await db.query(`INSERT INTO chat_rooms(room_id,creator_subject_id,operation_id,request_hash,title,state,mode,retention_days,revision,member_revision,had_multiple,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'ownerless',90,2,2,$7,$8,$8)`,[roomId,initiatorId,contactId,requestHash,title,multiple?'active':'waiting-members',multiple,at]);
    for(const member of memberships)await db.query('INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$3,$4)',[roomId,member.subjectId,member.controller,at]);
    const view=chat.view(await chat.requireRoom(db,{subjectId:recipientId},roomId));
    return {roomId,independentMemberCount:view.independentMemberCount,replayed:false};
  };
}
