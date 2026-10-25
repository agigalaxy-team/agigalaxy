import {randomUUID} from 'node:crypto';
import * as z from 'zod/v4';
import {identityGroupIntentSchema} from '../../packages/galaxy-official/src/shared/identity-group-v2-schema.mjs';
import {nativeResult} from '../../packages/galaxy-edge-mcp/src/native-v2/interaction/choice.mjs';
export const nativeIdentityGroupPrepareSchema=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('intent'),input:identityGroupIntentSchema}),
 z.strictObject({action:z.literal('response'),operationId:z.uuid(),decision:z.enum(['approve','decline','cancel']).default('approve')}),
 z.strictObject({action:z.literal('renew'),proofId:z.uuid()}),
]);
// The real existing user-choice surface receives the entire exact preview.
// A model-supplied `confirmed` field is not an approval mechanism.
export function registerNativeIdentityGroupTools(server,{runtime,review,now=()=>Date.now()}){
 const previews=new Map();let closed=false;
 const subject=async()=>{if(closed)throw Error('identity_group_native_closed');const id=(await runtime.status()).identity;if(!id)throw Error('native_identity_required');return id;};
 const client=()=>{const c=runtime.identityGroups;if(!c)throw Error('identity_group_connection_required');return c;};
 const prune=()=>{for(const [id,p]of previews)if(p.expiresAt<=now())previews.delete(id);};
 const output=async(fn)=>{try{return nativeResult(await fn());}catch(e){return{isError:true,...nativeResult({error:e.code??e.message??'identity_group_native_incomplete',originalOperationRetained:true})};}};
 const register=(name,inputSchema,description,run,write=false)=>server.registerTool(name,{inputSchema,description,annotations:{readOnlyHint:!write}},(input,ctx)=>output(()=>run(input,ctx)));
 register('galaxy_identity_group_native_prepare',nativeIdentityGroupPrepareSchema,
  'Read the complete original proposal or preview a new exact group intent. Show affected identities, source references/hash, correction, recipients and scope. This does not sign, publish or establish common control.',async input=>{
   prune();if(previews.size>=32)throw Error('identity_group_preview_limit');const owner=await subject(),c=client();
   const preview=input.action==='intent'?await c.prepare(input.input):input.action==='response'?await c.prepareResponse(input.operationId,input.decision):await c.reviewPending(input.proofId);
   if(owner!==await subject()||c!==client())throw Error('identity_group_identity_changed');
   const previewId=randomUUID();previews.set(previewId,{owner,client:c,preview,state:'prepared',expiresAt:now()+300000});
   return{previewId,operationId:preview.payload.operationId,state:'prepared',preview,remoteSubmitted:false,privateKeyExported:false};
  },true);
 server.registerTool('galaxy_identity_group_native_execute',{inputSchema:z.strictObject({previewId:z.uuid()}),annotations:{readOnlyHint:false},
  description:'Ask the actual user to approve the full previously prepared identity-group scope, then sign with this current device. A reference number alone is insufficient consent. No signature or private key is returned.'},async(input,ctx)=>{
  try{prune();const op=previews.get(input.previewId);if(!op||op.owner!==await subject()||op.client!==client())throw Error('identity_group_preview_expired_or_identity_changed');
   if(op.state!=='prepared')return nativeResult({state:op.state,operationId:op.preview.payload.operationId,receipt:op.receipt??null,recoverWith:'galaxy_identity_group_native_recover'});
   return await review('galaxy_identity_group_native_execute',{previewId:input.previewId,operationId:op.preview.payload.operationId,preview:op.preview},ctx,async()=>{
    if(op.state!=='prepared'||op.owner!==await subject()||op.client!==client())throw Error('identity_group_operation_changed');op.state='running';
    try{op.receipt=await op.client.execute(op.preview,{confirmed:true});op.state='completed';return op.receipt;}
    catch(e){op.state='original-operation-needs-reconciliation';throw e;}
   });
  }catch(e){return output(()=>{throw e;});}
 });
 register('galaxy_identity_group_native_cancel_preview',z.strictObject({previewId:z.uuid()}),'Cancel only an unsigned local preview; retain the journal for signed/unknown operations. This does not revoke or cancel a server-side group.',async({previewId})=>{
  const p=previews.get(previewId);if(!p||p.owner!==await subject())throw Error('identity_group_preview_unavailable');
  if(p.state!=='prepared')return{state:p.state,serverCancellationConfirmed:false,recoverWith:'galaxy_identity_group_native_recover'};
  previews.delete(previewId);return{state:'canceled-before-signing',remoteSubmitted:false};
 },true);
 register('galaxy_identity_group_native_recover',z.strictObject({action:z.enum(['pending','reconcile','retry','stop-local-retry']),proofId:z.uuid().optional()}),
  'Inspect exact original pending IDs, reconcile without new signatures, retry original signed bytes, or stop only local retry. Changed control needs an explicit prepare renew and actual user review. Never equate absent with confirmed cancellation.',async input=>{
   await subject();const c=client();if(input.action==='pending')return c.pending();if(!input.proofId)throw Error('identity_group_proof_id_required');
   if(input.action==='stop-local-retry')return c.stopLocalRetry(input.proofId,{confirmed:true});
   return c[input.action](input.proofId);
  },true);
 return{close(){closed=true;previews.clear();}};
}
