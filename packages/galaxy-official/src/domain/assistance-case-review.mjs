import { canReadProjection } from './consent-policy.mjs';
import { ServiceError } from '../shared/service-error.mjs';
import { projectCaseReviews } from './case-review.mjs';

// The caller already holds the Case lock and has checked its live source chain.
// Only correction/review events are acknowledged; unrelated private attempts
// are neither disclosed nor made a prerequisite for contribution recovery.
export async function readAssistanceReviewEvents(db,{caseId,viewerId,consents,endpoint,now}){
  const rows=(await db.query("SELECT * FROM case_events WHERE case_id=$1 AND kind='revision' ORDER BY version",[caseId])).rows;
  for(const row of rows){
    const grant=await consents.require(db,{id:row.consent_id,subjectId:row.subject_id,action:'case.teaser.publish',objectId:row.id,recipient:endpoint,payloadJson:row.payload_text});
    if(!canReadProjection(grant,{viewerId,projection:'history',now}))throw new ServiceError('assistance_case_review_unavailable',404);
  }
  return rows;
}
export async function readAssistanceCaseReview(db,input){
  const rows=await readAssistanceReviewEvents(db,input);
  return {caseId:input.caseId,reviewVersion:rows.at(-1)?.version??0,correctionCount:rows.filter(row=>!row.payload.review).length,
    scope:'case-correction-and-review-events-only',authority:'case-owner-reported'};
}

// Shared by Honor and participation eligibility: old acceptance is not current
// after a correction or a new delivery, even when the original event remains.
export function projectAssistanceReview(revisions,state){
  const pendingReviews=projectCaseReviews(revisions.map(row=>row.payload)).filter(review=>!['resolved','rejected'].includes(review.state));
  const textCorrections=revisions.filter(row=>!row.payload.review);
  const corrected=textCorrections.length>0||pendingReviews.some(review=>review.type==='correction');
  const correctionPending=textCorrections.some(row=>row.version>(state.delivery?.caseReviewVersion??0))||pendingReviews.some(review=>review.type==='correction');
  const disputed=pendingReviews.some(review=>review.type==='dispute')||['disputed','awaiting-resolution-confirmation'].includes(state.state);
  const acceptance=state.events.findLast(item=>item.event.kind==='accept'&&item.event.deliveryId===state.delivery?.id);
  return {textCorrections,corrected,correctionPending,disputed,acceptance,accepted:state.state==='accepted'&&Boolean(acceptance)};
}
