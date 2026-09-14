import canonicalize from 'canonicalize';
import {experienceReviewerSchema} from '../shared/experience-review-schema.mjs';
import {digest} from '../shared/digest.mjs';
import {ServiceError} from '../shared/service-error.mjs';
export function experienceReviewerHash(input){const p=experienceReviewerSchema.parse(input);return digest(canonicalize({...p,capabilityIds:[...new Set(p.capabilityIds)].sort(),kinds:[...new Set(p.kinds)].sort()}));}
export function experienceReviewerRegistry(reviewers){return{version:1,reviewers:reviewers.map(r=>({subjectId:r.subjectId,definitionHash:experienceReviewerHash(r)})).sort((a,b)=>a.subjectId.localeCompare(b.subjectId))};}
export async function currentExperienceReviewerRegistry(db,endpoint){
  const row=(await db.query("SELECT id,payload FROM runtime_config_events WHERE endpoint=$1 AND component='api' ORDER BY sequence DESC LIMIT 1",[endpoint])).rows[0];
  const registry=row?.payload?.snapshot?.experienceReviewerRegistry;
  if(registry?.version!==1||!Array.isArray(registry.reviewers))throw new ServiceError('experience_reviewer_registry_unavailable',503);
  return{configurationEventId:row.id,...registry};
}
