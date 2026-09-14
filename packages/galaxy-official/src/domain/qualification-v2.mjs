// Already authorized sources only. Different records from one Case or one
// stable external source do not create extra professional experience.
export function qualificationDecisionV2({policy,sources,proofs,effectiveRestrictions=[],includeSimulation=false}){
  const count=rows=>new Set(rows.filter(s=>s.usable).map(s=>s.group)).size;
  const usable=sources.filter(s=>s.synthetic===false),needed=Math.max(policy.collaboration==='basic-bounty'?1:0,policy.minAcceptedCollaborations);
  const currentCount=count(usable),missing=[];
  if(currentCount<needed)missing.push({condition:'relevant-reviewed-experience',required:needed,available:currentCount});
  if(proofs.length<policy.minProofs)missing.push({condition:'policy-matched-ci-observations',required:policy.minProofs,available:proofs.length});
  return {state:effectiveRestrictions.length?'not-satisfied':missing.length?'insufficient-evidence':'satisfied',missing,
    satisfiedBy:usable.filter(s=>s.usable),effectiveRestrictions,counts:{distinctRelevantExperiences:currentCount,policyMatchedCiSources:proofs.length},
    ...(includeSimulation?{simulation:{only:true,grantsParticipation:false,distinctRelevantExperiences:count(sources),
      state:effectiveRestrictions.length?'not-satisfied':count(sources)>=needed&&proofs.length>=policy.minProofs?'satisfied':'insufficient-evidence'}}:{}),
    capabilityVerified:false,expertiseCertified:false,automaticSelection:false};
}
