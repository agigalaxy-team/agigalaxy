import * as z from 'zod/v4';
import {githubReference} from './github-evidence-schema.mjs';
import {evidenceVersionRef} from './verification-record-schema.mjs';
import {ciProofDataSchema,githubObservedSourceKey} from './ci-provenance.mjs';
export const ciRequestV2Schema=z.strictObject({id:z.uuid(),schemaVersion:z.literal(2),kind:z.literal('observe'),
  purpose:z.literal('observe-selected-ci-source-and-prepare-bounded-proof'),caseId:z.uuid(),
  evidenceRef:evidenceVersionRef,resultRef:evidenceVersionRef,source:githubReference});
export const ciIdSchema=z.strictObject({id:z.uuid()});
export const ciReceiptSchema=z.strictObject({id:z.uuid(),type:z.enum(['request','proof'])});
export const ciProofPreviewSchema=z.strictObject({id:z.uuid(),requestId:z.uuid()});
export const ciProofV2Schema=ciProofDataSchema.omit({evidenceId:true}).extend({version:z.literal(2),sourceProfile:z.literal('facts-v2'),
  bindingId:z.uuid(),synthetic:z.boolean()});
export function describeCiProofV2(input){const data=ciProofV2Schema.parse(input);
  if(data.sourceControl?.repositoryOwner&&data.sourceControl.repositoryOwner.login.toLowerCase()!==data.source.owner.toLowerCase())throw new Error('Repository owner mismatch');
  return{version:2,profile:'github-actions-provenance/2',sourceKey:githubObservedSourceKey(data.source),issuer:data.issuer,proofId:data.id,
    source:data.source,conclusion:data.conclusion,sourceControl:data.sourceControl??null,authority:'issuer-attested-github-api-observation',
    submitterControlVerified:false,independentExecutionVerified:false};}
export function ciSourceMetadata(source){return{originSystem:'github-actions',
  externalStableId:`github-actions:${source.owner.toLowerCase()}/${source.repository.toLowerCase()}:run:${source.runId}:attempt:${source.attempt}`,
  contentVersion:source.commit};}
