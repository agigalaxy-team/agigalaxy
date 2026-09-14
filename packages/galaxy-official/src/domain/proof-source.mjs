import { proofRepository } from '../infrastructure/proofs-repository.mjs';
import { currentVerificationJob } from './verification-current.mjs';
import { ServiceError } from '../shared/service-error.mjs';

// Shared read-only source check; no signing or identity/session dependency.
export async function currentProofSource(db,evidenceId,subjectId,{evidence,now,lockEvidenceRead}){
  const row=(await proofRepository(db).evidence([evidenceId,subjectId])).rows[0];
  if(!row||row.state!=='observed')throw new ServiceError('proof_source_unavailable',409);
  await evidence.live(db,row);
  const current=(await (lockEvidenceRead?lockEvidenceRead(db,evidenceId,subjectId):proofRepository(db).lockEvidence([evidenceId]))).rows[0];
  if(!current||current.state!=='observed')throw new ServiceError('proof_source_unavailable',409);
  const latest=(await proofRepository(db).latestObservation([evidenceId])).rows[0];
  const job=await currentVerificationJob(db,evidenceId,evidence.source.jobKind);
  if(job&&(['pending','running'].includes(job.state)||latest?.job_id!==job.id))throw new ServiceError('proof_revalidation_pending_or_unavailable',409);
  const observation=latest?.observation;
  if(!observation||observation.status!=='observed'||observation.strength!=='ci-execution-fact'
    ||observation.capabilitiesVerified!==false||observation.completed!==true||observation.validUntil<=now())throw new ServiceError('proof_source_unavailable',409);
  return latest;
}
