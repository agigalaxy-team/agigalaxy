const normalize=result=>({...result,state:result.ownApprovalAcknowledged?'acknowledged':result.operationState??result.state,operationState:result.operationState??result.state});
export function createIdentityGroupsWebClient(runtime,{subjectId=/** @type {string|null} */(null),now=()=>Math.floor(Date.now()/1000),locks=globalThis.navigator?.locks}={}){
 const base=runtime.identityGroups;if(!base||!subjectId)throw Object.assign(Error('identity_group_connection_required'),{code:'identity_group_connection_required'});
 const capture=()=>{const lease=runtime.receiptStatus.captureLease();if(lease.subjectId!==subjectId||lease.endpoint!==runtime.api.endpoint)throw Object.assign(Error('identity_group_identity_changed'),{code:'identity_group_identity_changed'});return lease;};
 const client=base.withContinuity({captureLease:capture,updateLocal:(name,change)=>runtime.updateLocal(name,change,subjectId),now,locks});
 return Object.freeze({...client,execute:async(...args)=>normalize(await client.execute(...args)),retry:async(...args)=>normalize(await client.retry(...args)),reconcile:async(...args)=>normalize(await client.reconcile(...args)),
  contacts:async(input={})=>{const lease=capture();lease.assertCurrent();try{const result=await runtime.api.call('/v2/contacts/query',{direction:'both',limit:50,...input});lease.assertCurrent();return result;}catch(error){lease.assertCurrent();throw error;}}});
}
