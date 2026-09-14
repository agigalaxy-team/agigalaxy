import * as z from 'zod/v4';
import { assistanceEventSchema } from './assistance-schema.mjs';

export const eventDraftFields = Object.freeze({
  invite:['participantId','note'],offer:['proposal','scope'],'withdraw-offer':['reason'],
  shortlist:[],select:[],confirm:[],'change-scope':['scope','reason'],'confirm-scope':[],
  deliver:['attemptId','summary','evidenceIds'],accept:['summary'],cancel:['reason'],expire:[],
  dispute:['reason'],'propose-resolution':['summary'],'confirm-resolution':[],
  'requester-feedback':['descriptionClarity','scopeMatched','note'],
});
const subject=z.string().regex(/^GUID[0-9A-Z]{28}$/);
const sourceSchema=z.object({
  assistanceId:z.uuid(),version:z.number().int().positive(),title:z.string().max(160),state:z.string().max(50),
  view:z.enum(['requester','applicant','selected-provider']),requesterId:subject,
  selected:z.object({providerId:subject,offerId:z.uuid()}).strict().nullable(),
  agreedScope:z.string().max(1200).nullable(),pendingScope:z.string().max(1200).nullable(),
  collaboration:z.enum(['open-assistance','basic-bounty']),enrollmentExpiresAt:z.number().int().positive(),
  visibility:z.enum(['Private','Public']).default('Private'),
  caseReviewVersion:z.number().int().min(0).max(1000).optional(),resolutionOutcome:z.enum(['close','resume-work']).optional(),
  qualification:z.object({policyId:z.string().max(80),policyVersion:z.string().max(32)}).strict().nullable(),
}).strict();
export const assistanceEventDraftSchema=z.object({
  eventKind:z.enum(Object.keys(eventDraftFields)),source:sourceSchema,
  target:z.object({offerId:z.uuid().optional(),offerIds:z.array(z.uuid()).max(16).optional(),deliveryId:z.uuid().optional(),proposalId:z.uuid().optional(),outcome:z.enum(['close','resume-work']).optional()}).strict(),
  values:z.object(Object.fromEntries([...new Set([...Object.values(eventDraftFields).flat(),'proofIds','assistanceIds','amount','minimum','maximum','unit'])]
    .map(key=>[key,z.string().max(1200).optional()]))).strict(),
  step:z.enum(['fields','qualification','budget','budget-fields','review']),index:z.number().int().min(0).max(6),
  mode:z.enum(['open','fixed','range','quote']).nullable(),
}).strict();
export function assistanceDraftSource(record) {
  return sourceSchema.parse({assistanceId:record.request.id,version:record.version,title:record.request.title,state:record.state,view:record.view,
    requesterId:record.requesterId,selected:record.selected??null,agreedScope:record.agreedScope??null,pendingScope:record.pendingScope??null,
    collaboration:record.request.collaboration,enrollmentExpiresAt:record.request.enrollmentExpiresAt,visibility:record.request.visibility,qualification:record.request.qualification??null,
    ...(record.deliverySource?{caseReviewVersion:record.deliverySource.reviewVersion}:{}),...(record.resolution?.outcome?{resolutionOutcome:record.resolution.outcome}:{})});
}
export function checkEventDraftTarget(content,current) {
  if (current.request.id!==content.source.assistanceId || current.view!==content.source.view) throw new Error('Collaboration participant role changed; reopen the current request.');
  if (current.paused && content.eventKind!=='cancel') throw new Error('Collaboration paused; the draft remains local.');
  const {eventKind,target}=content,liveOffer=id=>current.offers.some(offer=>offer.id===id&&!offer.withdrawn);
  if (['select','withdraw-offer'].includes(eventKind)&&!liveOffer(target.offerId)
    ||eventKind==='shortlist'&&!(target.offerIds??[]).every(liveOffer)
    ||eventKind==='accept'&&target.deliveryId!==current.delivery?.id
    ||eventKind==='confirm-resolution'&&target.proposalId!==current.resolution?.id)
    throw new Error('Draft target changed; choose the target again in the current request.');
}
const ids=text=>(text??'').split(/[,，]/).map(s=>s.trim()).filter(Boolean);
export function eventFromDraft(row) {
  const content=assistanceEventDraftSchema.parse(row.content),{eventKind:kind,source,target,values,mode}=content;
  const event={id:row.id,expectedVersion:source.version,kind,...target,
    ...Object.fromEntries(eventDraftFields[kind].map(key=>[key,key==='evidenceIds'?ids(values[key]):key==='scopeMatched'?
      values[key]==='yes'?true:values[key]==='no'?false:values[key]:values[key]]))};
  if(kind==='deliver'&&source.caseReviewVersion!==undefined)event.caseReviewVersion=source.caseReviewVersion;
  if(kind==='offer'){
    if(source.qualification)event.qualificationEvidence={proofIds:ids(values.proofIds),assistanceIds:ids(values.assistanceIds)};
    if(mode&&mode!=='open')event.quote={mode,unit:values.unit,...(mode==='fixed'?{amount:values.amount}:mode==='range'?{minimum:values.minimum,maximum:values.maximum}:{})};
  }
  return assistanceEventSchema.parse(event);
}
