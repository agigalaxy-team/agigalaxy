import * as z from 'zod/v4';
import { digest } from './digest.mjs';

export const historyRebuildSchema=z.strictObject({
  rule:z.strictObject({id:z.literal('case-history'),version:z.number().int().positive()}),
  endpoint:z.url(),caseId:z.uuid(),sourceVersion:z.number().int().positive(),view:z.enum(['owner','authorized','public']),
  contentHash:z.string().regex(/^[a-f0-9]{64}$/),
  sources:z.strictObject({events:z.array(z.strictObject({id:z.uuid(),kind:z.enum(['case','attempt','result','revision','withdrawal']),version:z.number().int().positive()})).min(1).max(1000),
    proofIds:z.array(z.uuid()).max(20),capsuleUseIds:z.array(z.uuid()).max(20),assistanceIds:z.array(z.uuid()).max(20).optional()}),
});

// Only fields in the existing visible projection participate. Neither hidden
// payload hashes nor raw event/configuration bodies are added to public views.
const fields=['caseId','sourceVersion','title','summary','state','attempts','results','corrections','reviews','proofs',
  'capabilityVerified','verification','participants','source','registeredAt','capsuleReuse'];
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(key=>key!=='checkedAt'&&value[key]!==undefined).map(key=>[key,canonical(value[key])]));
  return value;
}
export function historyContentHash(item,ruleVersion=1){
  if(![1,2,3,4].includes(ruleVersion))throw new Error('Unsupported history projection rule.');
  const selected=ruleVersion===1?fields:ruleVersion===2?[...fields,'collaborationContext']:[...fields,'collaborationContext','reportedProgress','fieldPolicy',...(ruleVersion>=4?['moderationContext']:[])];
  const visible=Object.fromEntries(selected.filter(key=>item[key]!==undefined).map(key=>[key,item[key]]));
  return digest(JSON.stringify(canonical(visible)));
}
export function compareHistoryRebuilds(before,after){
  if(!before||!after)return {state:'incomparable',reasons:['versioned-baseline-unavailable']};
  const previous=historyRebuildSchema.parse(before),current=historyRebuildSchema.parse(after);
  const reasons=[];
  if(previous.endpoint!==current.endpoint||previous.caseId!==current.caseId)reasons.push('different-source');
  if(previous.view!==current.view)reasons.push('different-view');
  if(previous.rule.version!==current.rule.version)reasons.push('different-projection-rule');
  if(reasons.length)return {state:'incomparable',reasons};
  if(previous.sourceVersion!==current.sourceVersion)reasons.push('source-version-changed');
  if(previous.contentHash!==current.contentHash)reasons.push('visible-content-changed');
  const delta=key=>({added:(current.sources[key]??[]).filter(id=>!(previous.sources[key]??[]).includes(id)),removed:(previous.sources[key]??[]).filter(id=>!(current.sources[key]??[]).includes(id))});
  const oldIds=previous.sources.events.map(e=>e.id),newIds=current.sources.events.map(e=>e.id);
  const changes={events:{added:newIds.filter(id=>!oldIds.includes(id)),removed:oldIds.filter(id=>!newIds.includes(id))},proofs:delta('proofIds'),capsuleUses:delta('capsuleUseIds'),assistance:delta('assistanceIds')};
  if(Object.values(changes).some(change=>change.added.length||change.removed.length)&&!reasons.includes('visible-content-changed'))reasons.push('visible-sources-changed');
  return {state:reasons.length?'changed':'unchanged',reasons,changes};
}
