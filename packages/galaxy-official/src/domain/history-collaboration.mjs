import { ServiceError } from '../shared/service-error.mjs';
import { assistanceRequestSchema,assistanceEnvelopeSchema } from '../shared/assistance-schema.mjs';

// Reuse Assistance's current Case/Consent checks. This view describes the
// requested capability and signed participation, never a proficiency award.
export async function historyCollaborationContext(db,actor,parent,assistance){
  const rows=(await db.query(`SELECT a.id,r.consent_id,r.payload_text,a.requester_id FROM assistance_requests a
    JOIN assistance_events r ON r.id=a.id JOIN consents c ON c.id=r.consent_id JOIN bindings b ON b.id=c.binding_id
    WHERE a.case_id=$1 AND c.revoked_at IS NULL AND b.revoked_at IS NULL AND c.expires_at>$3 AND b.expires_at>$3
      AND c.subject_id=a.requester_id AND b.subject_id=a.requester_id AND c.intent->>'recipient'=$4
      AND c.intent->>'action'='assistance.publish' AND c.intent->>'objectId'=r.id::text AND c.intent->>'payloadHash'=r.payload_hash
      AND (a.requester_id=$2 OR c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile'
        OR c.intent->>'visibility'='Private' AND c.intent->'viewers' ? COALESCE($2,''))
    ORDER BY a.id LIMIT 200`,[parent.id,actor?.subjectId??null,new Date(assistance.access.now()*1000).toISOString(),assistance.access.endpoint])).rows;
  const items=[],viewer=actor?.subjectId??null,owner=viewer===parent.subject_id;
  for(const candidate of rows){
    try{
      const root=await assistance.grant(db,candidate.requester_id,candidate.consent_id,candidate.id,candidate.payload_text);
      if(!assistance.visible(root,viewer))continue;
      const request=assistanceRequestSchema.parse(JSON.parse(candidate.payload_text));
      if(request.id!==candidate.id||request.caseId!==parent.id)throw new Error('History assistance source mismatch');
      const participantLinks=[];
      if(owner||viewer===candidate.requester_id)participantLinks.push({subjectId:candidate.requester_id,role:'requester',eventId:candidate.id,authority:'signed-request'});
      if(viewer){
        const confirmations=(await db.query(`SELECT id,subject_id,consent_id,payload_text FROM assistance_events WHERE assistance_id=$1
          AND ($2::boolean OR subject_id=$3) AND payload_text::jsonb->'event'->>'kind'='confirm' ORDER BY version LIMIT 1000`,[candidate.id,owner,viewer])).rows;
        for(const entry of confirmations){
          try{
            const grant=await assistance.grant(db,entry.subject_id,entry.consent_id,entry.id,entry.payload_text);
            if(!assistance.visible(grant,viewer))continue;
            const envelope=assistanceEnvelopeSchema.parse(JSON.parse(entry.payload_text));
            if(envelope.assistanceId!==candidate.id||envelope.event.id!==entry.id||envelope.event.kind!=='confirm')throw new Error('History participation source mismatch');
            participantLinks.push({subjectId:entry.subject_id,role:'provider',eventId:entry.id,authority:'signed-participation-confirmation'});
          }catch(error){if(!(error instanceof ServiceError))throw error;}
        }
      }
      items.push({assistanceId:candidate.id,requestVersion:1,requestEventId:candidate.id,
        capabilityId:request.capabilityId??null,requestedScope:request.scope,collaboration:request.collaboration,
        attribution:'requester-declared-requirement',participantLinks,capabilityVerified:false});
      if(items.length===20)break;
    }catch(error){if(!(error instanceof ServiceError))throw error;}
  }
  return {version:1,coverage:'up-to-20-visible-links-from-200-candidates',
    capabilityIds:[...new Set(items.map(item=>item.capabilityId).filter(Boolean))].sort((a,b)=>a<b?-1:a>b?1:0),items,capabilityVerified:false};
}
