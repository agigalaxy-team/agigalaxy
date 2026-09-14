import { readDeletionEventPayload } from '../shared/deletion-event-payload.mjs';
import { z } from 'zod';
import { transaction } from '../database.mjs';
import { digest } from '../shared/digest.mjs';
import { deletionReceipt } from '../deletion.mjs';
const basis = z.string().min(1).max(2000);
const plan = z.object({ policyId: z.string().min(1).max(100), policyVersion: z.string().min(1).max(80),
  primary: z.object({ action: z.literal('delete-owned-data'), notBefore: z.number().int().nonnegative(), basis }).strict(),
  audit: z.object({ action: z.literal('retain-minimum'), until: z.number().int().nonnegative(), basis }).strict(),
  backups: z.object({ action: z.literal('expire-snapshots-and-replay-deletions'), until: z.number().int().nonnegative(), basis }).strict(),
  externalCopies: z.literal('outside-service-control'),
}).strict().refine(value => value.audit.until >= value.primary.notBefore && value.backups.until >= value.primary.notBefore);
export const deletionReviewSchema = z.object({ version: z.literal(1), id: z.uuid(), requestId: z.uuid(),
  endpoint: z.url(), expectedRevision: z.number().int().positive(), reviewerRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  decision: z.enum(['needs-information','approve','reject']), explanation: basis, plan: plan.optional(),
}).strict().refine(value => (value.decision === 'approve') === Boolean(value.plan));

export async function reviewDeletionRequest(database, input) {
  const decision = deletionReviewSchema.parse(input), payloadJson = JSON.stringify(decision), hash = digest(payloadJson);
  return transaction(database, async db => {
    const row = (await db.query('SELECT * FROM deletion_requests WHERE id=$1 FOR UPDATE', [decision.requestId])).rows[0];
    if (!row || JSON.parse(row.payload_text).endpoint !== decision.endpoint) throw new Error('Deletion review target mismatch');
    const prior = (await db.query('SELECT request_id,payload_hash FROM deletion_events WHERE id=$1', [decision.id])).rows[0];
    if (prior) {
      if (prior.request_id !== row.id || prior.payload_hash !== hash) throw new Error('Deletion review conflict');
      return deletionReceipt(row, decision.endpoint);
    }
    if (row.revision !== decision.expectedRevision || !['requested','review-needed'].includes(row.state)) throw new Error('Deletion request changed');
    const state = { 'needs-information': 'review-needed', approve: 'approved', reject: 'rejected' }[decision.decision];
    const updated = (await db.query('UPDATE deletion_requests SET state=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *', [row.id,state])).rows[0];
    await db.query(`INSERT INTO deletion_events(id,request_id,revision,actor_kind,actor_ref,kind,payload_text,payload_hash)
      VALUES($1,$2,$3,'operator',$4,$5,$6,$7)`, [decision.id,row.id,updated.revision,decision.reviewerRef,decision.decision,payloadJson,hash]);
    return deletionReceipt(updated, decision.endpoint);
  });
}

const nonzero=value=>Object.fromEntries(Object.entries(value??{}).filter(([,count])=>count!==0));
function compactExecution(value,originalHash){
  const result=structuredClone(value);
  delete result.selectedCounts;delete result.revoked;delete result.passes;
  for(const name of ['deletedCounts','totalDeletedCounts','remainingCounts'])result[name]=nonzero(result[name]);
  result.primary.remaining=nonzero(result.primary.remaining);result.audit.remaining=nonzero(result.audit.remaining);
  result.minimized=true;result.originalResultSha256=originalHash;
  result.receiptLedger={state:'minimized',cleanupImplemented:true,scope:'operator-text-and-execution-detail',originalSignedIntentsRetained:true};
  return result;
}
export function retainedOperatorPayload(event){
  const value=structuredClone(readDeletionEventPayload(event));
  if(event.kind==='execute')return compactExecution(value,event.payload_hash);
  const review=deletionReviewSchema.parse(value);review.explanation='sha256:'+digest(review.explanation);
  if(review.plan)for(const name of ['primary','audit','backups'])review.plan[name].basis='sha256:'+digest(review.plan[name].basis);
  return review;
}
