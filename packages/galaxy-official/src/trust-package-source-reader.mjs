import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
const rule=(v,c,s=409)=>{if(!v)throw new ServiceError(c,s);};
const one=async(db,sql,args)=>(await db.query(sql,args)).rows[0];

// Current reading is necessary, but this reader never grants reproduction.
// The permission service separately authorizes the caller, author, exact bytes
// and recipient before it invokes the author projection for a licensed copy.
export function createTrustSourceReader({cases,verificationRecords,ciV2}) {
  return async function readWithin(db,actor,ref) {
    let row,view,authorId,sourceState='current',authority='participant-reported';
    if(ref.kind==='ci-proof-v2') {
      // A publication is immutable at version 1. The data's version 2 denotes
      // the CI protocol, not a newer publication of this source ID.
      rule(ref.version===1&&!ref.caseId&&!ref.taskId,'trust_ci_reference_locator_invalid',422);
      rule(ciV2?.proofWithin&&ciV2.verifyEnvelope,'trust_issuer_source_profile_unavailable',409);
      row=await one(db,'SELECT subject_id,payload_text,payload_hash,signed FROM ci_proofs_v2 WHERE id=$1',[ref.id]);
      rule(row&&row.subject_id===actor?.subjectId,'trust_ci_associated_subject_required',403);
      let checked;
      try {checked=await ciV2.verifyEnvelope(row.signed,{type:'proof',issuer:ref.endpoint,audience:ref.endpoint,
        trustedKeys:ciV2.trustedKeys,now:ciV2.now(),maxAge:86400});}
      catch {throw new ServiceError('trust_ci_signature_unavailable',409);}
      rule(checked.id===ref.id,'trust_ci_reference_profile_mismatch',409);
      try {view=await ciV2.proofWithin(db,actor,ref.id);}
      catch(error){
        // Expiry can cross while canonical sources are being reread. Treat
        // known JOSE rejection as this item's unavailability, not an API-wide
        // failure; database/infrastructure failures still propagate.
        if(['ERR_JWT_EXPIRED','ERR_JWT_CLAIM_VALIDATION_FAILED','ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
          'ERR_JWS_INVALID','ERR_JWT_INVALID'].includes(error?.code))throw new ServiceError('trust_ci_signature_unavailable',409);
        throw error;
      }
      rule(view.data?.version===2&&view.data.sourceProfile==='facts-v2'&&view.data.id===ref.id
        &&view.data.subject===row.subject_id&&view.data.issuer===ref.endpoint&&ref.endpoint===ciV2.endpoint,
        'trust_ci_reference_profile_mismatch',409);
      rule(row.signed===view.signed&&row.payload_text===JSON.stringify(view.data)
        &&digest(row.payload_text)===row.payload_hash,'stored_integrity_mismatch',500);
      // Both verifications used the selected issuer pins, and proofWithin also
      // checked current source rights. Never copy this JWT or its payload.
      const signedExpiresAt=checked.expiresAt;
      rule(Number.isSafeInteger(signedExpiresAt)&&Number.isSafeInteger(view.data.expiresAt),
        'trust_ci_reference_expiry_invalid',500);
      const sourceExpiresAt=Math.min(signedExpiresAt,view.data.expiresAt);
      rule(sourceExpiresAt>ciV2.now(),'trust_source_not_currently_usable',409);
      return {ref,profile:'galaxy-ci-proof-v2-reference/1',issuer:view.data.issuer,
        associatedSubjectId:row.subject_id,sourceHash:row.payload_hash,sourceSignatureHash:digest(view.signed),
        sourceExpiresAt,sourceState:'current',authority:'ci-observation',copyEligible:false,
        limitations:['The issuer is the CI observation service; the associated subject is not its issuer or a reproduction license holder.',
          'Only exact publication coordinates and hashes are included; original CI Proof text and signed bytes are not copied.',
          'A CI observation does not certify task success, capability, source ownership or independent execution.',
          'Source availability and authorization were checked only at the recorded observation; offline reading grants no current access.']};
    } else if(ref.kind==='case-event') {
      rule(ref.caseId,'trust_case_id_required',422);
      row=await one(db,'SELECT * FROM case_events WHERE id=$1 AND case_id=$2 AND version=$3',[ref.id,ref.caseId,ref.version]);
      rule(row?.payload_text,'trust_source_unavailable',404);
      view=await cases.readV2Within(db,actor,ref.caseId,{taskId:ref.taskId??null});
      rule(view.events.some(e=>e.eventId===ref.id&&e.caseVersion===ref.version),'trust_source_unavailable',404);
      rule(row.payload?.actorId===row.subject_id,'trust_legacy_author_unknown',409);
      authorId=row.subject_id;
      const kind=row.payload.kind,field=kind.startsWith('attempt-')?'attempts':kind==='intervention'?'interventions':kind==='result-recorded'?'results':null;
      const selected=field?view[field]?.find(f=>f.eventId===ref.id):null;
      if(selected&&view[field].some(f=>f.id===selected.id&&f.version>selected.version))sourceState='superseded';
      if(['case-created','case-scope-revised'].includes(kind)&&view.scopes.at(-1)?.eventId!==ref.id)sourceState='superseded';
      if(kind==='resolution-recorded'&&view.resolutions.at(-1)?.eventId!==ref.id)sourceState='superseded';
    } else if(['evidence','verification'].includes(ref.kind)) {
      const object=await one(db,'SELECT * FROM verification_objects WHERE id=$1 AND object_type=$2',[ref.id,ref.kind]);
      rule(object,'trust_source_unavailable',404);
      row=await one(db,'SELECT * FROM verification_events WHERE object_id=$1 AND version=$2',[ref.id,ref.version]);
      rule(row?.payload_text&&(!ref.caseId||ref.caseId===object.case_id),'trust_source_unavailable',404);
      view=await verificationRecords.readWithin(db,actor,{type:ref.kind,id:ref.id,version:ref.version});
      rule(view.record,'trust_source_unavailable',404); authorId=object.subject_id;
      sourceState=view.referenceStatus;
      authority=ref.kind==='verification'?'verification-record':row.payload.evidenceType==='self-assertion'?'self-asserted':'participant-reported';
    } else {
      // Official-signed CI proofs have a different author and license holder.
      // Do not invent a user-authored license from the proof's subject field.
      throw new ServiceError('trust_issuer_source_profile_unavailable',409);
    }
    rule(digest(row.payload_text)===row.payload_hash,'stored_integrity_mismatch',500);
    rule(['current','superseded'].includes(sourceState),'trust_source_not_currently_usable',409);
    rule(!(await one(db,"SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased') LIMIT 1",[authorId])), 'trust_source_deletion_pending',409);
    const p=row.payload;
    // These sources need their own separate licenses; this first profile must
    // not silently reuse a chat, Capsule or qualification-purpose permission.
    const dependencies=[...(p.sourceRefs??[]),...(p.deliverableRefs??[]),...(p.evidenceRefs??[]),...(p.verificationRefs??[]),...(p.resultRefs??[])];
    if(p.origin)dependencies.push(p.origin);
    if(p.target)dependencies.push(p.target);
    let ownedReferenceMetadata=true;
    for(const dependency of dependencies){
      if(ref.kind==='case-event'&&['attempt','intervention','result'].includes(dependency.kind)){
        const event=view.events.find(e=>e.eventId===dependency.id&&e.actorId===authorId);
        if(!event)ownedReferenceMetadata=false;
      }else ownedReferenceMetadata=false;
    }
    const copyEligible=ownedReferenceMetadata&&!p.participationId&&row.payload_text.length<=48000;
    return {ref,authorId,sourceHash:row.payload_hash,bodyText:row.payload_text,sourceState,authority,
      copyEligible,copyLimitation:copyEligible?null:'linked-source-reproduction-permissions-not-yet-provided',
      limitations:['Source content is an authored report; its signature does not prove truth, success or capability.',
        'Original Consent JWS is not copied: its other recipients and bindings are outside this source-body permission.',
        ...(copyEligible?[]:['This source has linked materials; the ordinary license profile only supports a reference.'])]};
  };
}
