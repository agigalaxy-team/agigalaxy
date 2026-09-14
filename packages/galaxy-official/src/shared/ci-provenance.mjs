import * as z from 'zod/v4';
import { githubReference } from './github-evidence-schema.mjs';

const integer=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const githubControlSchema=z.strictObject({version:z.literal(1),observedVia:z.literal('github-rest-api'),
  repositoryOwner:z.strictObject({id:integer,login:z.string().min(1).max(100),type:z.enum(['User','Organization','Bot'])}).nullable(),
  submitterControlVerified:z.literal(false),independentExecutionVerified:z.literal(false)});
export const observedGithubSourceSchema=githubReference.extend({repositoryId:integer,sourceUpdatedAt:z.iso.datetime()});
export const ciProofDataSchema=z.strictObject({version:z.literal(1),type:z.literal('ci-execution-observation'),id:z.uuid(),subject:z.string().min(1).max(240),issuer:z.url(),
  evidenceId:z.uuid(),observationId:z.uuid(),scope:z.literal('referenced-ci-run-only'),strength:z.literal('ci-execution-fact'),independence:z.literal('repository-controlled'),
  attribution:z.literal('submitter-asserted'),source:observedGithubSourceSchema,sourceControl:githubControlSchema.optional(),
  conclusion:z.enum(['success','failure','neutral','cancelled','skipped','timed_out','action_required','stale','startup_failure']).nullable(),
  taskOutcomeVerification:z.literal('not-independently-verified'),capabilityVerified:z.literal(false),preparedAt:timestamp,observedAt:timestamp,expiresAt:timestamp,
  limitations:z.array(z.string().min(1).max(2000)).min(1).max(30),statusPath:z.string()});

// Names can change; relays, local IDs, issuer IDs and commits do not create a
// second source for the same numbered repository/run/attempt. A differing
// commit or conclusion is reported as a conflict within that source group.
export function githubObservedSourceKey(source){const s=observedGithubSourceSchema.parse(source);
  return `github-actions:repository:${s.repositoryId}:run:${s.runId}:attempt:${s.attempt}`;}
export function describeCiProof(input){const data=ciProofDataSchema.parse(input);
  if(data.sourceControl?.repositoryOwner&&data.sourceControl.repositoryOwner.login.toLowerCase()!==data.source.owner.toLowerCase())throw new Error('Repository owner metadata mismatch.');
  return {version:1,profile:'github-actions-provenance/1',sourceKey:githubObservedSourceKey(data.source),issuer:data.issuer,proofId:data.id,
    source:data.source,conclusion:data.conclusion,sourceControl:data.sourceControl??null,
    authority:'issuer-attested-github-api-observation',submitterControlVerified:false,independentExecutionVerified:false};
}
export function summarizeCiProofViews(views){
  if(!Array.isArray(views)||views.length>1000)throw new Error('CI source summary exceeds the bounded view.');
  const groups=new Map();let proofRecordCount=0;
  for(const view of views){
    const p=view.provenance;if(!p)continue;
    if(p.sourceKey!==githubObservedSourceKey(p.source)||p.profile!=='github-actions-provenance/1'||p.independentExecutionVerified!==false)throw new Error('Invalid CI provenance view.');
    proofRecordCount++;
    let group=groups.get(p.sourceKey);
    if(!group){group={sourceKey:p.sourceKey,repositoryId:p.source.repositoryId,runId:p.source.runId,attempt:p.source.attempt,records:[],commits:new Set(),conclusions:new Set()};groups.set(p.sourceKey,group);}
    group.records.push({issuer:p.issuer,proofId:p.proofId});group.commits.add(p.source.commit);group.conclusions.add(p.conclusion);
  }
  const items=[...groups.values()].sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey)).map(group=>({
    sourceKey:group.sourceKey,repositoryId:group.repositoryId,runId:group.runId,attempt:group.attempt,records:group.records,
    conflicts:[...(group.commits.size>1?['commit']:[]),...(group.conclusions.size>1?['conclusion']:[])]}));
  return {version:1,scope:'provided-visible-ci-proofs-only',proofRecordCount,sourceGroupCount:items.length,
    duplicateProofRecordCount:proofRecordCount-items.length,conflictingSourceGroupCount:items.filter(item=>item.conflicts.length).length,
    independentlyVerifiedSourceCount:0,globalCountProvided:false,groups:items};
}

// Reference mapping for the existing built-in adapter. Registration does not
// install code or prove the registrant controls the upstream repository.
export const githubBridgeMapping=Object.freeze({sourceSystem:'GitHub Actions REST API',sourceObjects:['workflow-run-attempt'],targetObjects:['Evidence','Proof'],
  rules:'Preserve repository ID, run ID, attempt and commit; retain CI conclusion and repository-controlled limitations.',strengthCeiling:'execution-observation',
  authorization:'Anonymous public GitHub reads; exact Galaxy Consent is separately required for Evidence and Proof publication.',version:'github-actions-api/0.1',
  deduplication:'Group observed sources by numeric repository ID, run ID and attempt; copied Hub/Proof IDs do not add sources; differing commits or conclusions remain conflicts.',
  revocation:'Current source, Consent, binding, revalidation and Proof revocation affect authorized reads; offline signatures alone cannot establish current revocation.',
  provenance:'Repository owner metadata is an API observation; submitter repository control and independent execution are not certified.'});
