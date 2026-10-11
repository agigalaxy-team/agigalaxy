import {summaryContentSchema} from '../../galaxy-official/src/shared/personal-summary-schema.mjs';

/** This revision fences local text only; it is never a sharing or synchronization operation ID. */
export function checkedSummaryDraft(value){
 if(value==null)return null;
 if(typeof value!=='object'||typeof value.summaryId!=='string'||!Number.isSafeInteger(value.baseRevision)||value.baseRevision<0
  ||typeof value.note!=='string'||value.note.length>8000||typeof value.dirty!=='boolean'
  ||value.draftRevision!==undefined&&typeof value.draftRevision!=='string'||!summaryContentSchema.safeParse(value.content).success)
  throw Error('summary_draft_unavailable');
 return value;
}
export function summaryDraftHead(value){return checkedSummaryDraft(value)?.draftRevision??null;}
function conflict(){return Error('summary_draft_conflict');}
/** @param {unknown} current @param {unknown} value @param {string|null} expectedRevision */
export function replaceSummaryDraft(current,value,expectedRevision){
 const prior=checkedSummaryDraft(current),next=checkedSummaryDraft(value);
 if(!next){if(!prior)return null;if(summaryDraftHead(prior)!==expectedRevision)throw conflict();return null;}
 const input=structuredClone(next);delete input.draftRevision;delete input.blockedSources;delete input.sourcesTemporarilyUnavailable;
 if(prior){const previous=structuredClone(prior);delete previous.draftRevision;delete previous.blockedSources;delete previous.sourcesTemporarilyUnavailable;if(JSON.stringify(previous)===JSON.stringify(input))return prior;}
 if(summaryDraftHead(prior)!==expectedRevision)throw conflict();
 return {...input,draftRevision:crypto.randomUUID()};
}
/** Source rechecks must not replace a newer page's input with an older filtered copy. */
export function retainFilteredSummaryDraft(current,original,retained){
 const prior=checkedSummaryDraft(current);
 if(JSON.stringify(prior)!==JSON.stringify(original))return {changed:false,value:prior};
 return {changed:true,value:replaceSummaryDraft(prior,retained,summaryDraftHead(original))};
}
