import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
const rule=(v,c,s=409)=>{if(!v)throw new ServiceError(c,s);};
const one=async(db,sql,args)=>(await db.query(sql,args)).rows[0];

// Current reading is necessary, but this reader never grants reproduction.
// The permission service separately authorizes the caller, author, exact bytes
// and recipient before it invokes the author projection for a licensed copy.
export function createTrustSourceReader({cases,verificationRecords}) {
  return async function readWithin(db,actor,ref) {
    let row,view,authorId,sourceState='current',authority='participant-reported';
    if(ref.kind==='case-event') {
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
