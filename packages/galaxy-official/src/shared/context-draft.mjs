import * as z from 'zod/v4';
import { selectedTextSchema, contextGrantSchema, contextScopeEvent } from './context-schema.mjs';
const subject=z.string().regex(/^GUID[0-9A-Z]{28}$/);
export const contextDraftSourceSchema=z.object({assistanceId:z.uuid(),caseId:z.uuid(),ownerId:subject,participantId:subject,
  title:z.string().max(160),scope:z.string().min(1).max(1200),scopeEventId:z.uuid()}).strict();
export function contextDraftSource(record){
  if(record.view!=='requester'||record.state!=='active'||record.paused||!record.selected)throw new Error('Confirmed active collaboration required.');
  return contextDraftSourceSchema.parse({assistanceId:record.request.id,caseId:record.request.caseId,ownerId:record.requesterId,
    participantId:record.selected.providerId,title:record.request.title,scope:record.agreedScope,scopeEventId:contextScopeEvent(record)});
}
export function sameContextSource(left,right){
  return ['assistanceId','caseId','ownerId','participantId','scope','scopeEventId'].every(key=>left[key]===right[key]);
}
export const contextDraftContentSchema=z.object({
  source:contextDraftSourceSchema,materials:z.array(z.object({id:z.uuid(),label:z.string().max(160),content:selectedTextSchema}).strict()).min(1).max(8),
  hours:z.string().max(16),step:z.enum(['label','content','overview','expiry']),index:z.number().int().min(0).max(7),
}).strict().refine(value=>new Set(value.materials.map(item=>item.id)).size===value.materials.length&&value.index<value.materials.length);
export function grantFromDraft(row,expiresAt){
  const {source,materials}=contextDraftContentSchema.parse(row.content);
  return contextGrantSchema.parse({id:row.id,assistanceId:source.assistanceId,caseId:source.caseId,participantId:source.participantId,
    scope:source.scope,scopeEventId:source.scopeEventId,expiresAt,materials:materials.map(item=>({id:item.id,label:item.label,mediaType:'text/plain',content:item.content}))});
}

