import { contactEnvelopeV2Schema,contactEventV2Schema } from "../shared/contacts-schema-v2.mjs";
import { canReadProjection } from "../domain/consent-policy.mjs";
import { recordObjectAudit } from "../infrastructure/object-audit.mjs";
import { digest } from "../shared/digest.mjs";
import { ServiceError } from "../shared/service-error.mjs";
import { sameOpportunityRef } from "../shared/discovery-schema-v2.mjs";

const day=86400,at=now=>new Date(now*1000).toISOString();
const fail=(code,status=409)=>{throw new ServiceError(code,status);};
const parse=(schema,value)=>{const result=schema.safeParse(value);if(!result.success)fail('invalid_contact_request',400);return result.data;};
const unavailable=e=>e instanceof ServiceError&&[403,404].includes(e.status);

export class ContactV2Service {
  constructor(access,{consents,discovery,inbox,publicWrites,requireAccountWithin,createRoomWithin}={}){Object.assign(this,{access,consents,discovery,inbox,publicWrites,requireAccountWithin,createRoomWithin});}
  state(row){return row.state==='sent'&&Date.parse(row.expires_at)<=this.access.now()*1000?'expired':row.state;}
  async grantWithin(db,row){if(!row?.payload_text)fail('contact_source_unavailable',404);
    return this.consents.require(db,{id:row.consent_id,subjectId:row.subject_id,action:'contact.write',objectId:row.operation_id,recipient:this.access.endpoint,payloadJson:row.payload_text});}
  async requireWithin(db,actor,id,{write=false}={}){
    const row=(await db.query(`SELECT * FROM contacts_v2 WHERE id=$1 ${write?'FOR UPDATE':'FOR SHARE'}`,[id])).rows[0];
    if(!row||![row.initiator_id,row.recipient_id].includes(actor.subjectId))fail('contact_not_found',404);return row;
  }
  receipt(row){return {schemaVersion:2,contactId:row.id,initiatorId:row.initiator_id,recipientId:row.recipient_id,purpose:row.purpose,state:this.state(row),revision:row.revision,
    roomId:row.room_id,expiresAt:at(Date.parse(row.expires_at)/1000),sentMeaning:'accepted-by-galaxy-service; recipient-response-is-separate',taskId:null};}
  async readWithin(db,actor,id){
    const row=await this.requireWithin(db,actor,id),events=[];
    for(const event of (await db.query('SELECT * FROM contact_events_v2 WHERE contact_id=$1 ORDER BY revision',[id])).rows){
      const metadata={operationId:event.operation_id,subjectId:event.subject_id,kind:event.kind,revision:event.revision,recordedAt:new Date(event.created_at).toISOString()};
      try{
        if(Date.parse(event.created_at)+90*day*1000<=this.access.now()*1000)throw new ServiceError('contact_source_unavailable',404);
        const grant=await this.grantWithin(db,event);
        if(!canReadProjection(grant,{viewerId:actor.subjectId,projection:'history',now:this.access.now()}))throw new ServiceError('contact_source_unavailable',404);
        const payload=parse(contactEventV2Schema,JSON.parse(event.payload_text));
        events.push({...metadata,note:payload.note,...(payload.kind==='send'?{opportunityRef:payload.opportunityRef,context:payload.context,roomTitle:payload.roomTitle}:{})});
      }catch(error){if(!unavailable(error))throw error;events.push({...metadata,contentUnavailable:true});}
    }
    return {...this.receipt(row),events};
  }
  get(actor,id){return this.access.runAuthorized(actor,'history',db=>this.readWithin(db,actor,id));}
  query(actor,{after='',limit=50,direction='both'}={}) {
    if(!Number.isInteger(limit)||limit<1||limit>100||!['both','incoming','outgoing'].includes(direction)||after&&!/^[a-f0-9-]{36}$/i.test(after))fail('invalid_contact_request',400);
    return this.access.runAuthorized(actor,'history',async db=>{
      const rows=(await db.query(`SELECT id FROM contacts_v2 WHERE
        (($2 IN ('both','incoming') AND recipient_id=$1) OR ($2 IN ('both','outgoing') AND initiator_id=$1))
        AND ($3='' OR id::text>$3) ORDER BY id LIMIT $4`,[actor.subjectId,direction,after,limit+1])).rows;
      const items=[];for(const row of rows.slice(0,limit))items.push(await this.readWithin(db,actor,row.id));
      return {items,nextAfter:rows.length>limit?rows[limit-1].id:null};
    });
  }
  async currentOpportunityWithin(db,initiatorId,payload){
    if(payload.recipientId!==payload.opportunityRef.subjectId)fail('contact_recipient_mismatch',400);
    const actor={subjectId:initiatorId},context=await this.discovery.contextWithin(db,actor,{context:payload.context,purposes:[payload.purpose]});
    if(!context.wish.enabled)fail('contact_willingness_unavailable',403);
    const items=await this.discovery.opportunityWithin(db,actor,{subject_id:payload.recipientId},context);
    const ref=payload.opportunityRef,item=items.find(item=>sameOpportunityRef(item.opportunityRef,ref));
    if(!item)fail('contact_willingness_unavailable',403);return item;
  }
  async submit(actor,input){
    const envelope=parse(contactEnvelopeV2Schema,input);let event;try{event=parse(contactEventV2Schema,JSON.parse(envelope.payloadJson));}catch{fail('invalid_contact_request',400);}
    return this.access.runResourceWrite(actor,'history',{},async(db,authorization)=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912360))',[event.contactId]);
      const prior=(await db.query('SELECT * FROM contact_events_v2 WHERE operation_id=$1',[event.operationId])).rows[0];
      if(prior){if(prior.subject_id!==actor.subjectId||prior.contact_id!==event.contactId||prior.consent_id!==envelope.consentId||prior.payload_hash!==digest(envelope.payloadJson))fail('contact_operation_conflict');
        return {...this.receipt(await this.requireWithin(db,actor,event.contactId)),operationId:event.operationId,appliedRevision:prior.revision,replayed:true};}
      const grant=await this.grantWithin(db,{operation_id:event.operationId,subject_id:actor.subjectId,consent_id:envelope.consentId,payload_text:envelope.payloadJson});
      if(grant.visibility!=='Private'||grant.currentVisibility?.deletionPending)fail('contact_private_consent_required',403);
      let row,source,counterparty;
      if(event.kind==='send'){
        if(event.expectedRevision!==0||event.recipientId===actor.subjectId)fail('invalid_contact_request',400);
        if((await db.query('SELECT id FROM contacts_v2 WHERE id=$1',[event.contactId])).rows.length)fail('contact_id_conflict');
        counterparty=event.recipientId;
        await this.currentOpportunityWithin(db,actor.subjectId,event);
        if(!this.publicWrites)fail('contact_account_adapter_unavailable',503);
      }else{
        row=await this.requireWithin(db,actor,event.contactId,{write:true});counterparty=row.initiator_id===actor.subjectId?row.recipient_id:row.initiator_id;
        if(row.revision!==event.expectedRevision)fail('contact_revision_conflict');
        if(this.state(row)!=='sent')fail('contact_not_awaiting_response');
        if(event.kind==='withdraw'&&actor.subjectId!==row.initiator_id||event.kind!=='withdraw'&&actor.subjectId!==row.recipient_id)fail('contact_response_actor_denied',403);
        if(event.kind==='accept'){
          source=(await db.query('SELECT * FROM contact_events_v2 WHERE operation_id=$1',[row.create_event_id])).rows[0];
          const originalGrant=await this.grantWithin(db,source);
          if(!canReadProjection(originalGrant,{viewerId:row.recipient_id,projection:'history',now:this.access.now()}))fail('contact_source_unavailable',403);
          const payload=parse(contactEventV2Schema,JSON.parse(source.payload_text));await this.currentOpportunityWithin(db,row.initiator_id,payload);
          if(!this.requireAccountWithin||!this.createRoomWithin)fail('contact_room_adapter_unavailable',503);
          for(const subjectId of [row.initiator_id,row.recipient_id])await this.requireAccountWithin(db,{subjectId});
        }
      }
      if(!canReadProjection(grant,{viewerId:counterparty,projection:'history',now:this.access.now()}))fail('contact_recipient_consent_required',403);
      if(event.kind==='send')await this.publicWrites.consumeWithin(db,actor,{kind:'invitation',operationId:event.operationId,payloadHash:digest(envelope.payloadJson),contactId:event.contactId,recipientId:event.recipientId});
      const revision=event.expectedRevision+1,createdAt=at(this.access.now());
      if(event.kind==='send')await db.query(`INSERT INTO contacts_v2(id,initiator_id,recipient_id,purpose,state,revision,create_event_id,expires_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,'sent',1,$5,$6,$7,$7)`,[event.contactId,actor.subjectId,event.recipientId,event.purpose,event.operationId,at(this.access.now()+7*day),createdAt]);
      await db.query(`INSERT INTO contact_events_v2(operation_id,contact_id,subject_id,revision,kind,consent_id,payload_text,payload_hash,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[event.operationId,event.contactId,actor.subjectId,revision,event.kind,envelope.consentId,envelope.payloadJson,digest(envelope.payloadJson),createdAt]);
      if(row)await db.query('UPDATE contacts_v2 SET state=$2,revision=$3,response_event_id=$4,updated_at=$5 WHERE id=$1',[event.contactId,{accept:'accepted',decline:'declined',withdraw:'withdrawn'}[event.kind],revision,event.operationId,createdAt]);
      if(event.kind==='accept'){
        const payload=parse(contactEventV2Schema,JSON.parse(source.payload_text));
        const room=await this.createRoomWithin(db,{contactId:event.contactId,roomId:event.contactId,initiatorId:row.initiator_id,recipientId:row.recipient_id,title:payload.roomTitle});
        await db.query('UPDATE contacts_v2 SET room_id=$2 WHERE id=$1',[event.contactId,room.roomId]);
      }
      if(['accept','decline'].includes(event.kind)){
        if(!this.publicWrites)fail('contact_account_adapter_unavailable',503);
        await this.publicWrites.markInvitationRespondedWithin(db,{contactId:event.contactId,recipientId:row.recipient_id});
      }
      await recordObjectAudit(db,{subjectId:actor.subjectId,objectId:event.operationId,action:'contact.event',httpRequestId:actor.httpRequestId??null,...authorization});
      return {...this.receipt(await this.requireWithin(db,actor,event.contactId)),operationId:event.operationId,appliedRevision:revision,replayed:false};
    });
  }
}
