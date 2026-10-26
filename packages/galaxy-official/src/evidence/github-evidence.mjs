import * as z from 'zod/v4';
import { evidenceSource } from './evidence-source.mjs';
import { fetchPublicJson } from "../infrastructure/public-fetch.mjs";
import { digest } from "../shared/digest.mjs";

import { githubReference } from "../shared/github-evidence-schema.mjs";
import { githubControlSchema } from "../shared/ci-provenance.mjs";
export { githubReference } from "../shared/github-evidence-schema.mjs";

export function githubSourceKey(reference) {
  const r = githubReference.parse(reference);
  return `github-actions:${r.owner.toLowerCase()}/${r.repository.toLowerCase()}:${r.runId}:${r.attempt}:${r.commit}`;
}
export function inspectGithubRun(reference, run, now = Math.floor(Date.now() / 1000)) {
  const r = githubReference.parse(reference);
  if (!run || run.id !== r.runId || run.run_attempt !== r.attempt || run.head_sha !== r.commit
    || run.repository?.full_name?.toLowerCase() !== `${r.owner}/${r.repository}`.toLowerCase()
    || run.repository?.private !== false || !Number.isSafeInteger(run.repository?.id)
    || typeof run.updated_at !== 'string' || !Number.isFinite(Date.parse(run.updated_at))
    || Date.parse(run.updated_at) > (now + 300) * 1000) throw new Error('Source reference mismatch.');
  const completed = run.status === 'completed';
  const conclusion = typeof run.conclusion === 'string' ? run.conclusion : null;
  if (!['completed', 'queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status)
    || (conclusion !== null && !['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure'].includes(conclusion)))
    throw new Error('Unsupported source outcome.');
  const owner=run.repository.owner;
  const sourceControl=githubControlSchema.parse({version:1,observedVia:'github-rest-api',repositoryOwner:owner===undefined?null:{id:owner?.id,login:owner?.login,type:owner?.type},
    submitterControlVerified:false,independentExecutionVerified:false});
  if(sourceControl.repositoryOwner&&sourceControl.repositoryOwner.login.toLowerCase()!==r.owner.toLowerCase())throw new Error('Source owner metadata mismatch.');
  return { status: 'observed', strength: 'ci-execution-fact', independence: 'repository-controlled',sourceControl,
    attribution: 'submitter-asserted', capabilitiesVerified: false, completed, conclusion,
    source: { ...r, repositoryId: run.repository.id, sourceUpdatedAt: run.updated_at },
    collectedAt: now, validUntil: now + 3600, verifier: 'github-actions-api/0.1',
    responseHash: digest(JSON.stringify(run)),
    limitations: ['Repository workflows may be controlled by the submitter.', 'A CI conclusion does not prove task quality or individual contribution.'] };
}
export async function verifyGithubEvidence(reference, now = Math.floor(Date.now() / 1000)) {
  const r = githubReference.parse(reference);
  const url = `https://api.github.com/repos/${r.owner}/${r.repository}/actions/runs/${r.runId}/attempts/${r.attempt}`;
  const run = await fetchPublicJson(url, { maxBytes: 131072, timeoutMs: 5000 });
  return inspectGithubRun(r, run, now);
}

const githubObservation = z.strictObject({
  status: z.literal('observed'), strength: z.literal('ci-execution-fact'),
  independence: z.literal('repository-controlled'), attribution: z.literal('submitter-asserted'),
  capabilitiesVerified: z.literal(false), completed: z.boolean(),
  conclusion: z.enum(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out',
    'action_required', 'stale', 'startup_failure']).nullable(),
  source: githubReference.extend({ repositoryId: z.number().int().positive(), sourceUpdatedAt: z.iso.datetime() }),
  collectedAt: z.number().int(), validUntil: z.number().int(), verifier: z.literal('github-actions-api/0.1'),
  responseHash: z.string().regex(/^[a-f0-9]{64}$/), limitations: z.array(z.string().min(1)).min(1),
  sourceControl:githubControlSchema.optional(),
});
export const githubEvidenceSource = evidenceSource({
  jobKind: 'verify-github', verifier: 'github-actions-api/0.1', referenceSchema: githubReference,
  sourceKey: githubSourceKey, verify: verifyGithubEvidence,
  validateObservation(value, reference, now) {
    const observation = githubObservation.parse(value);
    if (githubSourceKey(Object.fromEntries(Object.keys(reference).map(key => [key, observation.source[key]]))) !== githubSourceKey(reference)
      || observation.validUntil > now + 3600 || observation.sourceControl?.repositoryOwner && observation.sourceControl.repositoryOwner.login.toLowerCase()!==reference.owner.toLowerCase()) throw new Error('Mismatched GitHub observation');
    return observation;
  },
});
