export const CONTRIBUTION_RISK_POLICY = Object.freeze({ id: 'contribution-risk', version: 4,
  bulkWindowSeconds: 60, bulkMinimumCollaborations: 20, relationshipScan:'all-current-visible-candidates-in-keyset-pages',
  effect: 'review-only', fraudDetermined: false, automaticPenalty: false });

// Input is already filtered by current source authorization. Never read hidden
// facts to explain a visible flag, persist allegations, or change Honor scoring.
export function assessContributionRisk(contributions, { complete, checkedAt, subjectId, network }) {
  const flags = [], byCase = new Map(), byEvidence = new Map(), bySource = new Map();
  const add = (code, items, evidenceIds = [], details = {}) => flags.push({ code, severity: 'review',
    assistanceIds: [...new Set(items.map(item => item.assistanceId))].sort((a,b)=>a.localeCompare(b)),
    caseIds: [...new Set(items.map(item => item.caseId))].sort((a,b)=>a.localeCompare(b)),
    eventIds: [...new Set(items.flatMap(item => item.sourceEvents.map(event => event.eventId)))].sort((a,b)=>a.localeCompare(b)),
    evidenceIds: [...new Set(evidenceIds)].sort((a,b)=>a.localeCompare(b)), ...details, fraudDetermined: false });
  for (const item of contributions) {
    if (!byCase.has(item.caseId)) byCase.set(item.caseId, []);
    byCase.get(item.caseId).push(item);
    for (const proof of item.proofs) {
      if (!byEvidence.has(proof.evidenceId)) byEvidence.set(proof.evidenceId, []);
      byEvidence.get(proof.evidenceId).push(item);
    }
    for(const proof of item.observations??item.proofs)if(proof.sourceKey){
      if(!bySource.has(proof.sourceKey))bySource.set(proof.sourceKey,[]);
      bySource.get(proof.sourceKey).push({item,proof});
    }
    if (item.independence === 'issuer-declared-related-party') add('declared-related-parties', [item]);
    if (item.sourceEvents.some(event => event.kind === 'accept') && ((item.correctionPending??item.corrected) || item.disputed || item.paused))
      add('accepted-work-under-review', [item]);
    if(item.correctionReview?.state==='participant-reaccepted')add('corrected-work-reaccepted',[item],[],{
      deliveredCaseReviewVersion:item.correctionReview.deliveredCaseReviewVersion,deliveryEventId:item.correctionReview.deliveryEventId,
      acceptanceEventId:item.correctionReview.acceptanceEventId,independenceVerified:false});
    const unsuccessful=(item.observations??[]).filter(proof=>proof.conclusion!==null&&proof.conclusion!=='success');
    if(item.accepted&&unsuccessful.length)add('accepted-work-ci-not-successful',[item],unsuccessful.map(proof=>proof.evidenceId),
      {sourceKeys:[...new Set(unsuccessful.map(proof=>proof.sourceKey))].sort((a,b)=>a.localeCompare(b)),taskFailureDetermined:false});
  }
  for (const items of byCase.values()) if (new Set(items.map(item => item.assistanceId)).size > 1) add('repeated-source-case', items);
  for (const [id, items] of byEvidence) if (new Set(items.map(item => item.caseId)).size > 1) add('evidence-reused-across-cases', items, [id]);
  for(const [key,records] of bySource){
    const items=records.map(record=>record.item),ids=records.map(record=>record.proof.evidenceId);
    if(new Set(items.map(item=>item.caseId)).size>1||new Set(ids).size>1)
      add('ci-source-reused',items,ids,{sourceKeys:[key]});
    if(new Set(records.map(record=>record.proof.commit)).size>1||new Set(records.map(record=>record.proof.conclusion)).size>1)
      add('ci-source-conflict',items,ids,{sourceKeys:[key]});
  }
  if(network&&subjectId){
    const cycle=reciprocalAcceptanceCycle(network.contributions,subjectId);
    if(cycle.length)add('reciprocal-acceptance-cycle',cycle,[],{
      subjectIds:[...new Set(cycle.flatMap(item=>[item.requesterId,item.subjectId]))].sort((a,b)=>a.localeCompare(b)),
      edges:cycle.map(item=>({requesterId:item.requesterId,providerId:item.subjectId,assistanceId:item.assistanceId,caseId:item.caseId,
        acceptanceEventIds:item.sourceEvents.filter(event=>event.kind==='accept').map(event=>event.eventId)})),
      independenceVerified:false,relationshipInferred:false});
  }
  const timeline = [...new Map(contributions.filter(item => Number.isSafeInteger(item.participatedAt))
    .map(item => [item.assistanceId, item])).values()].sort((a, b) => a.participatedAt - b.participatedAt || a.assistanceId.localeCompare(b.assistanceId));
  for (let start = 0; start < timeline.length;) {
    let end = start + 1;
    while (end < timeline.length && timeline[end].participatedAt - timeline[start].participatedAt < CONTRIBUTION_RISK_POLICY.bulkWindowSeconds) end++;
    if (end - start >= CONTRIBUTION_RISK_POLICY.bulkMinimumCollaborations) {
      add('concentrated-participation', timeline.slice(start, end)); start = end;
    } else start++;
  }
  const fullyScanned=complete&&(!network||network.complete);
  return { policy: CONTRIBUTION_RISK_POLICY, checkedAt, complete:fullyScanned,
    contributionScanComplete:complete,relationshipScanComplete:network?.complete??null,
    coverage: 'currently visible contributions in this capability, community and time window',
    status: !fullyScanned ? 'incomplete-source-scan' : flags.length ? 'review-suggested' : 'no-signals-in-visible-sources',
    flags, automaticPenalty: false, fraudDetermined: false,
    limitations: ['No hidden-source scan', 'Related parties are issuer-declared, not independently verified',
      'Visible acceptance cycles do not establish collusion or independent verification',
      'CI observations remain repository-controlled; no independent human verifier is inferred',
      'Bulk participation can be legitimate', 'Missing CI is not a false-success finding', 'No global trust or fraud score'] };
}

// A source may have many local Evidence/Proof IDs. Numeric upstream source keys
// come from the existing verified CI provenance reader, not requester input.
export function contributionProofs(contributions){
  const groups=new Map();
  const eligibleIds=new Set(contributions.flatMap(item=>item.proofs.map(proof=>proof.proofId)));
  for(const item of contributions)for(const proof of item.observations??item.proofs){
    const key=proof.sourceKey??proof.evidenceId;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(proof);
  }
  const result=[];
  for(const records of groups.values()){
    if(new Set(records.map(proof=>proof.commit)).size>1||new Set(records.map(proof=>proof.conclusion)).size>1)continue;
    const proof=records.filter(record=>eligibleIds.has(record.proofId)).sort((a,b)=>a.proofId.localeCompare(b.proofId))[0];
    if(proof)result.push(proof);
  }
  return result.sort((a,b)=>(a.sourceKey??a.evidenceId).localeCompare(b.sourceKey??b.evidenceId));
}

// The intersection of forward and reverse reachability is the strongly
// connected component containing this subject. Only current eligible visible
// acceptance edges are considered; a one-way chain is not reciprocal.
export function reciprocalAcceptanceCycle(contributions,subjectId){
  const edges=[...new Map(contributions.filter(item=>item.eligible&&item.accepted&&item.requesterId!==item.subjectId
    &&item.sourceEvents.some(event=>event.kind==='accept'&&event.actorId===item.requesterId))
    .map(item=>[item.assistanceId,item])).values()];
  const reachable=(reverse)=>{
    const graph=new Map();
    for(const edge of edges){const from=reverse?edge.subjectId:edge.requesterId,to=reverse?edge.requesterId:edge.subjectId;
      if(!graph.has(from))graph.set(from,[]);graph.get(from).push(to);}
    const found=new Set([subjectId]),queue=[subjectId];
    for(let i=0;i<queue.length;i++)for(const next of graph.get(queue[i])??[])if(!found.has(next)){found.add(next);queue.push(next);}
    return found;
  };
  const forward=reachable(false),reverse=reachable(true),component=new Set([...forward].filter(id=>reverse.has(id)));
  return component.size<2?[]:edges.filter(edge=>component.has(edge.requesterId)&&component.has(edge.subjectId))
    .sort((a,b)=>a.assistanceId.localeCompare(b.assistanceId));
}
