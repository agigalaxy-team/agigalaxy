const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const text=value=>typeof value==='string'?value.trim():'';
const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)?value:null;
const list=value=>Array.isArray(value)?value:[];
const unique=values=>[...new Set(values.filter(Boolean))];

// The view retains the rule's finite meaning; an accepted contribution is not
// a claim about the person's whole ability, current availability, or Case result.
export function recognitionReading(value){
 const response=object(value),card=object(response.card),rule=object(card.rule);
 const rows=list(response.items??response.contributions).map((raw,index)=>{
  const evidence=object(raw),projections=list(evidence.projections).map(row=>object(object(row).projection));
  const title=text(evidence.title)||text(object(evidence.case).title)||projections.map(row=>text(row.title)).find(Boolean)||'参与记录 '+(index+1);
  const summaries=unique([text(evidence.summary),...projections.flatMap(row=>[text(row.summary),text(row.description),text(row.note)])]).filter(summary=>summary!==title);
  const caseId=uuid(evidence.caseId),taskId=uuid(evidence.taskId);
  return {key:text(evidence.id)||text(evidence.assistanceId)||String(index),title,summaries,
   eligible:evidence.eligible===true,participatedAt:number(evidence.participatedAt),recordKey:caseId?'case:'+caseId:taskId?'task:'+taskId:null,
   synthetic:evidence.sourceStatus==='synthetic-excluded',
   sourceStatus:text(evidence.sourceStatus)};
 });
 return {title:text(rule.title),kind:text(rule.kind),version:text(rule.version),issuer:text(card.issuer),
  acceptedCases:number(card.acceptedCases),proofCount:Array.isArray(card.proofs)?card.proofs.length:null,
  minimumCases:number(rule.minAcceptedCases),minimumProofs:number(rule.minProofs),
  from:number(rule.windowFrom),until:number(rule.windowUntil),validFrom:number(rule.notBefore),validUntil:number(rule.notAfter),checkedAt:number(card.checkedAt),
  communityId:text(rule.communityId),capabilityId:text(rule.capabilityId),factsV2:rule.sourceProfile==='facts-v2',
  repositories:list(rule.repositories).flatMap(raw=>{const row=object(raw),owner=text(row.owner),repository=text(row.repository);return owner&&repository?[owner+'/'+repository]:[];}),rows};
}

// Exact-version navigation is available only from a currently readable use
// record. Metadata left after a withdrawn source is not treated as its body.
export function historyMethodPath(value){
 const item=object(value);if(item.record===null)return null;
 const record=object(item.record??item),capsuleId=uuid(item.capsuleId??record.capsuleId),versionId=uuid(item.versionId??record.versionId);
 return capsuleId&&versionId?'/app/capsules/'+capsuleId+'/versions/'+versionId:null;
}
