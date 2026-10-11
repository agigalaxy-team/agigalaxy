import { ServiceError } from '../shared/service-error.mjs';

export const verifierEventKinds=new Set(['invite-verifier','accept-verifier','decline-verifier','withdraw-verifier','verification-response']);
export const verifierTarget=report=>report.caseId?{caseId:report.caseId,caseVersion:report.caseVersion,targetEventId:report.targetEventId,
  ...(report.evidenceId?{evidenceId:report.evidenceId}:{})}:{assistanceId:report.assistanceId};

// The immutable signed moderation events are the source of participation.
// Original Case participant assertions and invitations alone grant no party role.
export function projectModerationVerifiers(events){
  const members=new Map();
  for(const row of events){const event=row.payload??JSON.parse(row.payload_text);
    if(event.kind==='invite-verifier'){
      const prior=members.get(event.verifierId);
      members.set(event.verifierId,{subjectId:event.verifierId,invitationId:event.id,inviterId:row.subject_id,
        expiresAt:event.expiresAt,status:'invited',participated:prior?.participated??false});
    }else if(verifierEventKinds.has(event.kind)){
      let member=members.get(row.subject_id);
      if(!member&&['accept-verifier','withdraw-verifier','verification-response'].includes(event.kind)){
        // These surviving subject-authored facts were accepted against an exact
        // invitation at submission. Another author's erasure cannot erase that
        // historical process role; unavailable scope and expiry stay unknown.
        member={subjectId:row.subject_id,invitationId:event.invitationId,inviterId:null,
          expiresAt:null,status:'accepted',participated:true,invitationAvailable:false};
        members.set(row.subject_id,member);
      }
      if(!member||member.invitationId!==event.invitationId)continue;
      if(event.kind==='accept-verifier'){member.status='accepted';member.participated=true;}
      if(event.kind==='decline-verifier')member.status='declined';
      if(event.kind==='withdraw-verifier')member.status='withdrawn';
      if(event.kind==='verification-response')member.responseEventId=event.id;
    }
  }
  return [...members.values()];
}
export const moderationParties=row=>[...new Set([row.reporter_id,...row.participant_ids,...(row.verifiers??[]).filter(v=>v.participated).map(v=>v.subjectId)])];
export function verifierTransition(row,actorId,event,now,independentModerator){
  const own=row.verifiers.find(v=>v.subjectId===actorId);
  if(event.kind==='invite-verifier'){
    const prior=row.verifiers.find(v=>v.subjectId===event.verifierId);
    if(!independentModerator||event.verifierId===actorId||moderationParties(row).includes(event.verifierId)&&!prior?.participated)
      throw new ServiceError('moderation_role_denied',403);
    if(prior&&(prior.status==='accepted'||prior.status==='invited'&&prior.expiresAt>now))throw new ServiceError('verifier_already_invited',409);
    if(!prior&&row.verifiers.length>=4)throw new ServiceError('verifier_invitation_limit',429);
    if(event.expiresAt<=now||event.expiresAt>now+604800)throw new ServiceError('verifier_invitation_expiry',409);
    const report=row.reportData===undefined?JSON.parse(row.payload_text):row.reportData;
    if(!report)throw new ServiceError('moderation_source_unavailable',409);
    if(JSON.stringify(event.target)!==JSON.stringify(verifierTarget(report)))throw new ServiceError('verifier_target_mismatch',409);
    return;
  }
  if(!own||own.invitationId!==event.invitationId)throw new ServiceError('verifier_invitation_required',403);
  const expected=['accept-verifier','decline-verifier'].includes(event.kind)?'invited':'accepted';
  if(own.status!==expected)throw new ServiceError('verifier_transition_denied',409);
  if(event.kind==='accept-verifier'&&own.expiresAt<=now)throw new ServiceError('verifier_invitation_expired',409);
}
