import * as z from 'zod/v4';
import canonicalize from 'canonicalize';
import { qualificationPolicySchema } from '../shared/qualification-schema.mjs';
import { digest } from '../shared/digest.mjs';
import { ServiceError } from '../shared/service-error.mjs';

export const qualificationRegistrySchema=z.strictObject({version:z.literal(1),policies:z.array(z.strictObject({
  policyId:z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),policyVersion:z.string().regex(/^[0-9]+(?:\.[0-9]+){0,2}$/),definitionHash:z.string().regex(/^[a-f0-9]{64}$/)
})).max(64)});
export function qualificationDefinitionHash(input){
  const policy=qualificationPolicySchema.parse(input);
  const repositories=[...new Map(policy.repositories.map(row=>{const value={owner:row.owner.toLowerCase(),repository:row.repository.toLowerCase()};return [canonicalize(value),value];})).entries()]
    .sort(([a],[b])=>a.localeCompare(b)).map(([,row])=>row);
  return digest(canonicalize({...policy,repositories}));
}
export function qualificationRegistryManifest(policies){
  const rows=policies.map(policy=>({policyId:policy.id,policyVersion:policy.version,definitionHash:qualificationDefinitionHash(policy)}));
  if(new Set(rows.map(row=>row.policyId+'@'+row.policyVersion)).size!==rows.length)throw new Error('Duplicate qualification policy version');
  return qualificationRegistrySchema.parse({version:1,policies:rows.sort((a,b)=>(a.policyId+'@'+a.policyVersion).localeCompare(b.policyId+'@'+b.policyVersion))});
}
// Reuse the immutable, operator-owned runtime history and its transaction lock.
// Older records without per-policy hashes remain explicitly unregistered.
export async function assertQualificationVersions(db,endpoint,registry){
  const rows=(await db.query(`SELECT DISTINCT p.value AS policy FROM runtime_config_events r
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.payload->'snapshot'->'qualificationRegistry'->'policies','[]'::jsonb)) p(value)
    WHERE r.endpoint=$1 AND r.component='api' AND p.value->>'policyId'=ANY($2::text[])`,[endpoint,registry.policies.map(row=>row.policyId)])).rows;
  for(const next of registry.policies)if(rows.some(({policy})=>policy.policyId===next.policyId&&policy.policyVersion===next.policyVersion&&policy.definitionHash!==next.definitionHash))
    throw new Error('Qualification policy version conflict: publish a new version');
}
export async function currentQualificationRegistry(db,endpoint){
  const row=(await db.query("SELECT id,payload FROM runtime_config_events WHERE endpoint=$1 AND component='api' ORDER BY sequence DESC LIMIT 1",[endpoint])).rows[0];
  const parsed=qualificationRegistrySchema.safeParse(row?.payload?.snapshot?.qualificationRegistry);
  if(!parsed.success)throw new ServiceError('qualification_registry_unavailable',503);
  return {configurationEventId:row.id,...parsed.data};
}
