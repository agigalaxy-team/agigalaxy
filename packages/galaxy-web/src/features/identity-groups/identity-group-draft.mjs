export const identityGroupDraftKey=(endpoint,subjectId,kind,id='new')=>'identity-group-input:v1:'+JSON.stringify([endpoint,subjectId,kind,id]);
export const sameIdentityGroupLocator=(left,right)=>!!left&&!!right&&['endpoint','ownerId','groupId','operationId','proofId','payloadHash'].every(key=>typeof left[key]==='string'&&left[key]===right[key]);
const draftKeys=(runtime,subjectId,locator)=>[identityGroupDraftKey(runtime.api.endpoint,subjectId,'create'),identityGroupDraftKey(runtime.api.endpoint,subjectId,'edit',locator.groupId),identityGroupDraftKey(runtime.api.endpoint,subjectId,'revoke',locator.groupId)];
function owner(runtime,subjectId,locator){const lease=runtime.receiptStatus.captureLease();lease.assertCurrent();if(lease.subjectId!==subjectId||lease.endpoint!==runtime.api.endpoint||locator.ownerId!==subjectId||locator.endpoint!==runtime.api.endpoint)throw Object.assign(Error('identity_group_identity_changed'),{code:'identity_group_identity_changed'});return lease;}

/** Only this proof's acknowledgment can retire the exact input revision attached to it. */
export async function settleIdentityGroupDrafts({runtime,subjectId,receipt,mounted=new Map(),receiptFor}){
 if(receipt.state!=='acknowledged'||!receipt.ownApprovalAcknowledged)return{clearedMounted:false,cleared:[]};
 const locator=receipt.locator,lease=owner(runtime,subjectId,locator),cleared=[];let clearedMounted=false;
 for(const key of draftKeys(runtime,subjectId,locator)){lease.assertCurrent();const old=await runtime.getLocal(key,subjectId);lease.assertCurrent();if(!sameIdentityGroupLocator(old?.attempt,locator))continue;const active=mounted.get(key);
  if(active){const removed=await active.current.settle(current=>sameIdentityGroupLocator(current,locator)?Promise.resolve(receipt):receiptFor(current));if(removed){clearedMounted=true;cleared.push(key);}}
  else await runtime.updateLocal(key,current=>{lease.assertCurrent();if(current?.revision===old.revision&&sameIdentityGroupLocator(current.attempt,locator)){cleared.push(key);return null;}return current;},subjectId);
  lease.assertCurrent();
 }
 return{clearedMounted,cleared};
}

/** Reauthorization changes the proof locator, never newer author input or the original deadline. */
export async function rebindIdentityGroupDrafts({runtime,subjectId,original,next,mounted=new Map()}){
 const lease=owner(runtime,subjectId,original);owner(runtime,subjectId,next);if(!['endpoint','ownerId','groupId','operationId','payloadHash'].every(key=>original[key]===next[key]))throw Object.assign(Error('identity_group_locator_mismatch'),{code:'identity_group_locator_mismatch'});
 for(const key of draftKeys(runtime,subjectId,original)){lease.assertCurrent();const old=await runtime.getLocal(key,subjectId);lease.assertCurrent();if(!sameIdentityGroupLocator(old?.attempt,original))continue;const active=mounted.get(key);
  if(active)await active.current.attach(next,old.revision);
  else await runtime.updateLocal(key,current=>{lease.assertCurrent();return current?.revision===old.revision&&sameIdentityGroupLocator(current.attempt,original)?{...current,attempt:next}:current;},subjectId);
  lease.assertCurrent();
 }
}
