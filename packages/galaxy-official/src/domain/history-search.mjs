// Match only values already disclosed by the authorized projection readers.
// The Capability is a request's declared requirement, not a person's ability.
export function explainHistoryMatch(item,options,terms,checkedAt){
  const links=(item.collaborationContext?.items??[]).filter(link=>!options.capabilityId||link.capabilityId===options.capabilityId);
  if(options.capabilityId&&!links.length)return null;
  const strength=item.proofs.length?'ci-execution-fact':'reported-only';
  if(options.verificationStrength&&options.verificationStrength!==strength)return null;
  const textMatches=terms.map(term=>({term,fields:['title','summary'].filter(field=>String(item[field]).toLocaleLowerCase('en-US').includes(term))}));
  return {rule:{id:'visible-history-rules',version:1},sourceType:'case-history',caseId:item.caseId,
    order:'case-id',scope:'current-authorized-view',checkedAt,
    ...(item.registeredAt?{registeredAt:item.registeredAt}:{}),
    textMatches,capabilityMatches:options.capabilityId?links.map(link=>({capabilityId:link.capabilityId,assistanceId:link.assistanceId,authority:'requester-declared-requirement'})):[],
    verification:{strength,proofIds:item.proofs.map(proof=>proof.proofId),capabilityVerified:false,
      meaning:strength==='ci-execution-fact'?'At least one current visible limited CI execution Proof.':'No current visible CI Proof in this bounded projection; not a claim that no other evidence exists.'},
    sources:[{kind:'case',id:item.caseId},{kind:'history',id:item.caseId},...item.proofs.map(proof=>({kind:'proof',id:proof.proofId}))],
    limitations:['Text terms match the disclosed Case title and summary.','Capability associations describe requested work, not verified proficiency.',
      'UUID ordering is stable pagination, not a ranking of experts.','CI observations do not independently verify task outcome or individual capability.']};
}
