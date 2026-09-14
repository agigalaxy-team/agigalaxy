const common=['caseId','sourceVersion','title','summary','state','attempts','results','corrections','reviews','proofs','capabilityVerified',
  'verification','projectionHash','capsuleReuse','collaborationContext','reportedProgress','fieldPolicy','moderationContext'];
// Separate view policies even where the current authorized/public fields agree.
const policies=Object.freeze({
  owner:Object.freeze({fields:Object.freeze([...common,'participants','source','registeredAt']),attempt:Object.freeze(['id','sequence','approach','configuration'])}),
  authorized:Object.freeze({fields:Object.freeze([...common]),attempt:Object.freeze(['id','sequence'])}),
  public:Object.freeze({fields:Object.freeze([...common]),attempt:Object.freeze(['id','sequence'])}),
});
const pick=(value,fields)=>Object.fromEntries(Object.entries(value).filter(([key])=>fields.includes(key)));
export function applyHistoryFieldPolicy(item,view){
  if(!Object.hasOwn(policies,view))throw new Error('Unsupported history view');
  const policy=policies[view],selected=pick(item,policy.fields);
  selected.attempts=item.attempts.map(attempt=>{
    const result=pick(attempt,policy.attempt);
    if(result.configuration)result.configuration=pick(result.configuration,['environment','version','tools']);
    return result;
  });
  selected.results=item.results.map(result=>pick(result,['id','attemptId','outcome','summary','failureReason','limitations','corrected']));
  selected.corrections=item.corrections.map(correction=>pick(correction,['id','correctsEventId','reason','summary']));
  selected.reviews=item.reviews.map(review=>({...pick(review,['threadId','type','targetEventId','authority','independentDecision','state']),
    changes:review.changes.map(change=>pick(change,['eventId','state','reason','summary']))}));
  if(selected.source)selected.source=pick(selected.source,['kind','reference']);
  if(selected.participants)selected.participants=selected.participants.map(person=>pick(person,['subjectId','role']));
  // Proof/Capsule/Assistance views are produced by their own authorized readers.
  selected.fieldPolicy={id:'history-fields',version:1,view};
  return selected;
}
