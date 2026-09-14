import * as z from 'zod/v4';
import { digest } from './digest.mjs';
import { searchSourceTypes } from './search-schema.mjs';

export const feedbackSourceType=z.enum(searchSourceTypes);
export const feedbackVerdictSchema=z.strictObject({relevance:z.enum(['relevant','not-relevant','unsure']),helpedSelection:z.boolean().nullable()});
export const feedbackItemSchema=z.strictObject({sourceType:feedbackSourceType,sourceId:z.uuid(),
  sourceVersion:z.union([z.number().int().positive(),z.uuid()]),snapshotHash:z.string().regex(/^[a-f0-9]{64}$/),
  caseId:z.uuid().optional(),projectionHash:z.string().regex(/^[a-f0-9]{64}$/).optional()});
export const feedbackListSchema=z.strictObject({sourceType:feedbackSourceType.optional(),after:z.string().regex(/^[a-f0-9]{64}$/).optional(),limit:z.number().int().min(1).max(100).default(20)});
export const feedbackEditSchema=z.strictObject({id:z.string().regex(/^[a-f0-9]{64}$/),revision:z.number().int().positive(),verdict:feedbackVerdictSchema.nullable()});

export function captureSearchFeedbackItem(type,item){
  if(item.type!==type||item.source?.kind!==type||item.source?.id!==item.id)throw new Error('Search feedback source mismatch');
  const history=type==='case'||type==='history';
  const sourceVersion=history?z.number().int().positive().parse(item.source.sourceVersion)
    :z.uuid().parse(type==='proof'?item.source.observationId:type==='capsule'?item.source.versionId:item.source.declarationId);
  return feedbackItemSchema.parse({sourceType:type,sourceId:item.id,sourceVersion,
    snapshotHash:digest(JSON.stringify({source:item.source,record:item.record})),
    ...(history?{caseId:item.id,projectionHash:item.record.projectionHash}:{})});
}
export function legacyFeedbackItem(item){return feedbackItemSchema.parse({sourceType:'history',sourceId:item.caseId,caseId:item.caseId,
  sourceVersion:item.sourceVersion,snapshotHash:item.projectionHash,projectionHash:item.projectionHash});}
