import * as z from 'zod/v4';
import { profileStatementSchema,profileReceiptLocatorSchema } from './shared/profile-schema.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
import { canReadProjection } from './domain/consent-policy.mjs';
import { recordObjectAudit } from './infrastructure/object-audit.mjs';
import { currentControlKey } from './infrastructure/identity-control-repository.mjs';
import {compactVerify,importSPKI} from 'jose';
import canonicalize from 'canonicalize';

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
      if(statement.sharing&&(statement.sharing.visibility!==grant.visibility||canonicalize(statement.sharing.viewers)!==canonicalize(grant.viewers)
        ||statement.sharing.expiresAt!==null&&statement.sharing.expiresAt<=this.access.now()))throw new ServiceError('profile_sharing_mismatch',403);
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
  async receipt(actor,input){
    const parsed=profileReceiptLocatorSchema.safeParse(input);
    if(!parsed.success)throw new ServiceError('invalid_profile_receipt');
    const {operationId,payloadHash}=parsed.data;
    return this.access.runAuthorized(actor,'history',async db=>{
      // A receipt establishes only whether this owner's exact statement was
      // recorded. It neither returns its text nor renews current reading.
      const row=(await db.query('SELECT revision,payload_hash FROM profile_statements WHERE id=$1 AND subject_id=$2',
        [operationId,actor.subjectId])).rows[0];
      if(!row)return{state:'absent',operationId,payloadHash};
      if(row.payload_hash!==payloadHash)return{state:'conflict',operationId,payloadHash};
      return{state:'acknowledged',operationId,payloadHash,id:operationId,revision:row.revision,classification:'self-declared',capabilityVerified:false};
    });
  }
  async ownerRead(actor){
    return this.access.runAuthorized(actor,'history',async db=>{
      const latest=(await db.query('SELECT * FROM profile_statements WHERE subject_id=$1 ORDER BY revision DESC LIMIT 1',[actor.subjectId])).rows[0];
      const erased=(await db.query("SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('partial','primary-erased') LIMIT 1",[actor.subjectId])).rows.length>0;
      if(!latest||erased)return{subjectId:actor.subjectId,revision:latest?.revision??0,selfDeclared:{},statement:null,sharing:null,readable:false,checkedAt:this.access.now()};
      const statement=profileStatementSchema.parse(JSON.parse(latest.payload_text));
      if(statement.id!==latest.id||statement.expectedRevision+1!==latest.revision||digest(latest.payload_text)!==latest.payload_hash)throw Error('Profile source mismatch');
      // The current owner's ordinary history authority permits editing their
      // last original declaration. This does not reopen it to any audience.
      return{subjectId:actor.subjectId,revision:latest.revision,selfDeclared:statement.selfDeclared,
        statement:{id:latest.id,revision:latest.revision,payloadHash:latest.payload_hash},
        sharing:await this.sharingWithin(db,actor.subjectId,latest),readable:true,checkedAt:this.access.now()};
    });
  }
  async durableGrantWithin(db,subjectId,statement){
    // Resolve the original signer before locking its binding/Consent, following
    // the identity-control lock order used by writes and explicit revocation.
    const proof=(await db.query(`SELECT c.signer_key_id,c.control_epoch,b.device_id,b.key_id,b.control_epoch AS binding_epoch
      FROM consents c JOIN bindings b ON b.id=c.binding_id WHERE c.id=$1 AND c.subject_id=$2`,[statement.consent_id,subjectId])).rows[0];
    if(!proof)throw new ServiceError('consent_required',403);
    const control=await currentControlKey(db,subjectId,{deviceId:proof.device_id??undefined,keyId:proof.signer_key_id??proof.key_id??undefined,
      epoch:proof.control_epoch??proof.binding_epoch??0,scope:'consent'});
    const row=(await db.query(`SELECT c.*,b.revoked_at AS binding_revoked FROM consents c JOIN bindings b ON b.id=c.binding_id
      WHERE c.id=$1 AND c.subject_id=$2 FOR SHARE OF c,b`,[statement.consent_id,subjectId])).rows[0];
    const intent=row?.intent;
    if(!row||row.revoked_at||row.binding_revoked||intent.subjectId!==subjectId||intent.bindingId!==row.binding_id
      ||intent.endpoint!==this.access.endpoint||intent.recipient!==this.access.endpoint||intent.action!=='profile.publish'
      ||intent.objectId!==statement.id||intent.payloadHash!==statement.payload_hash||digest(statement.payload_text)!==statement.payload_hash
      ||!row.signature_envelope||!row.signed_payload_text||digest(row.signature_envelope)!==row.signature_hash)
      throw new ServiceError('consent_required',403);
    const payload=profileStatementSchema.parse(JSON.parse(statement.payload_text));
    if(!payload.sharing||payload.id!==statement.id||payload.expectedRevision+1!==statement.revision
      ||canonicalize(Object.keys(payload).sort())!==canonicalize([...intent.fields].sort((a,b)=>a<b?-1:a>b?1:0))
      ||payload.sharing.visibility!==intent.visibility||canonicalize(payload.sharing.viewers)!==canonicalize(intent.viewers)
      ||intent.visibility==='Public'&&intent.purpose!=='public-profile')throw new ServiceError('profile_sharing_mismatch',403);
    try{
      const verified=await compactVerify(row.signature_envelope,await importSPKI(control.publicKey,'Ed25519'),{algorithms:['Ed25519']});
      if(Object.keys(verified.protectedHeader).sort().join(',')!=='alg,typ'||verified.protectedHeader.typ!=='galaxy-consent+jws'
        ||Buffer.from(verified.payload).toString('utf8')!==row.signed_payload_text
        ||canonicalize(JSON.parse(row.signed_payload_text))!==canonicalize(intent))throw Error();
    }catch{throw new ServiceError('profile_signature_unavailable',403);}
    if((await db.query("SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased') LIMIT 1",[subjectId])).rows.length)
      throw new ServiceError('profile_content_unavailable',403);
    const until=payload.sharing.expiresAt;
    if(until!==null&&until<=this.access.now())throw new ServiceError('profile_sharing_expired',403);
    return{...intent,expiresAt:until??Number.POSITIVE_INFINITY};
  }
  async sharingWithin(db,subjectId,statement){
    const row=(await db.query(`SELECT c.intent,c.revoked_at,b.revoked_at AS binding_revoked,
      c.expires_at,b.expires_at AS binding_expires FROM consents c JOIN bindings b ON b.id=c.binding_id
      WHERE c.id=$1 AND c.subject_id=$2`,[statement.consent_id,subjectId])).rows[0];
    if(!row)return null;
    const intent=row.intent;
    if(intent.action!=='profile.publish'||intent.objectId!==statement.id||intent.recipient!==this.access.endpoint
      ||intent.payloadHash!==statement.payload_hash||!['Private','Public'].includes(intent.visibility))return null;
    const payload=profileStatementSchema.parse(JSON.parse(statement.payload_text)),sharing=payload.sharing;
    const expiresAt=sharing?sharing.expiresAt:Math.min(Date.parse(row.expires_at),Date.parse(row.binding_expires))/1000;
    let status=row.revoked_at||row.binding_revoked?'revoked':expiresAt!==null&&expiresAt<=this.access.now()?'expired':'active';
    if(sharing&&status==='active')try{await this.durableGrantWithin(db,subjectId,statement);}catch(error){
      if(!(error instanceof ServiceError))throw error;status=error.code==='profile_sharing_expired'?'expired':'revoked';}
    return{visibility:sharing?.visibility??intent.visibility,viewers:[...(sharing?.viewers??intent.viewers)],expiresAt,
      readExpiresAt:Math.min(this.access.now()+60,expiresAt??Number.POSITIVE_INFINITY),status,
      authorizationExpiresAt:intent.expiresAt,bindingExpiresAt:Math.floor(Date.parse(row.binding_expires)/1000),
      mode:sharing?'declared-sharing':'legacy-consent'};
  }
  async readWithin(db,actor,subjectId){
    const owner=actor?.subjectId===subjectId;
    // Never fall back to an older public statement after replacement/revocation.
    const latest=(await db.query('SELECT * FROM profile_statements WHERE subject_id=$1 ORDER BY revision DESC LIMIT 1',[subjectId])).rows[0];
    const sharing=latest?await this.sharingWithin(db,subjectId,latest):null;
    const empty={selfDeclared:{},...(owner?{selfDeclaredRevision:latest?.revision??0,selfDeclaredSharing:sharing,
      selfDeclaredStatement:latest?{id:latest.id,revision:latest.revision,payloadHash:latest.payload_hash}:null}:{})};
    if(!latest)return empty;
    try{
      const statement=profileStatementSchema.parse(JSON.parse(latest.payload_text));
      const grant=statement.sharing?await this.durableGrantWithin(db,subjectId,latest):await this.grant(db,subjectId,latest.id,latest.consent_id,latest.payload_text);
      if(!canReadProjection(grant,{viewerId:actor?.subjectId??null,projection:'history',now:this.access.now()}))return empty;
      if(statement.id!==latest.id||statement.expectedRevision+1!==latest.revision)throw new Error('Profile source mismatch');
      return {...empty,selfDeclared:statement.selfDeclared,selfDeclaredReadExpiresAt:sharing?.readExpiresAt,
        selfDeclaredSource:{id:latest.id,classification:'self-declared',capabilityVerified:false}};
    }catch(error){if(error instanceof ServiceError&&[401,403,404,409].includes(error.status))return empty;throw error;}
  }
}
