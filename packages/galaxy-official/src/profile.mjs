import * as z from 'zod/v4';
import { profileStatementSchema } from './shared/profile-schema.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
import { canReadProjection } from './domain/consent-policy.mjs';
import { recordObjectAudit } from './infrastructure/object-audit.mjs';

export class ProfileService{
  constructor(access,consents){Object.assign(this,{access,consents});}
  async grant(db,subjectId,id,consentId,payloadJson){
    return this.consents.require(db,{id:consentId,subjectId,action:'profile.publish',objectId:id,recipient:this.access.endpoint,payloadJson});
  }
  async publish(actor,input){
    const envelope=z.strictObject({consentId:z.uuid(),payloadJson:z.string().max(12000)}).safeParse(input);
    if(!envelope.success)throw new ServiceError('invalid_profile_statement');
    let statement;try{statement=profileStatementSchema.parse(JSON.parse(input.payloadJson));}
    catch{throw new ServiceError('invalid_profile_statement');}
    return this.access.runAuthorized(actor,'history',async (db,authorization)=>{
      const grant=await this.grant(db,actor.subjectId,statement.id,input.consentId,input.payloadJson);
      if(!['Private','Public'].includes(grant.visibility))throw new ServiceError('profile_visibility_unsupported',403);
      // Serialize revisions across bindings for one subject without mutating identity.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912307))',[actor.subjectId]);
      const hash=digest(input.payloadJson);
      const existing=(await db.query('SELECT subject_id,revision,payload_hash,consent_id FROM profile_statements WHERE id=$1',[statement.id])).rows[0];
      if(existing){
        if(existing.subject_id!==actor.subjectId||existing.payload_hash!==hash||existing.consent_id!==input.consentId)throw new ServiceError('profile_statement_conflict',409);
        return {id:statement.id,revision:existing.revision,classification:'self-declared',capabilityVerified:false};
      }
      const latest=(await db.query('SELECT revision FROM profile_statements WHERE subject_id=$1 ORDER BY revision DESC LIMIT 1',[actor.subjectId])).rows[0];
      if((latest?.revision??0)!==statement.expectedRevision)throw new ServiceError('profile_revision_conflict',409);
      const revision=statement.expectedRevision+1;
      await db.query('INSERT INTO profile_statements(id,subject_id,revision,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6)',
        [statement.id,actor.subjectId,revision,input.consentId,input.payloadJson,hash]);
      await recordObjectAudit(db,{subjectId:actor.subjectId,objectId:statement.id,action:'profile.publish',httpRequestId:actor.httpRequestId??null,...authorization});
      return {id:statement.id,revision,classification:'self-declared',capabilityVerified:false};
    });
  }
  async readWithin(db,actor,subjectId){
    const owner=actor?.subjectId===subjectId;
    // Never fall back to an older public statement after replacement/revocation.
    const latest=(await db.query('SELECT * FROM profile_statements WHERE subject_id=$1 ORDER BY revision DESC LIMIT 1',[subjectId])).rows[0];
    const empty={selfDeclared:{},...(owner?{selfDeclaredRevision:latest?.revision??0}:{})};
    if(!latest)return empty;
    try{
      const grant=await this.grant(db,subjectId,latest.id,latest.consent_id,latest.payload_text);
      if(!canReadProjection(grant,{viewerId:actor?.subjectId??null,projection:'history',now:this.access.now()}))return empty;
      const statement=profileStatementSchema.parse(JSON.parse(latest.payload_text));
      if(statement.id!==latest.id||statement.expectedRevision+1!==latest.revision)throw new Error('Profile source mismatch');
      return {...empty,selfDeclared:statement.selfDeclared,selfDeclaredSource:{id:latest.id,classification:'self-declared',capabilityVerified:false}};
    }catch(error){if(error instanceof ServiceError&&[403,404].includes(error.status))return empty;throw error;}
  }
}
