import {randomUUID} from 'node:crypto';
import * as z from 'zod/v4';
import {nativeResult} from '../../packages/galaxy-edge-mcp/src/native-v2/interaction/choice.mjs';

const id=z.uuid(),providerId=z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const nativeIdentityAccountReadSchema=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('providers')}),z.strictObject({action:z.literal('begin'),providerId}),
 z.strictObject({action:z.enum(['status','cancel']),id}),
 z.strictObject({action:z.literal('query'),id:id.optional(),after:id.optional(),limit:z.number().int().min(1).max(100).default(20)})
]);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const codeOf=error=>/^[a-z0-9_-]{1,100}$/.test(error?.code??error?.message??'')?error.code??error.message:'native_account_link_unavailable';
export function registerNativeIdentityAccountTools(server,{runtime,review,now=()=>Date.now()}){
 const previews=new Map();let closed=false;
 const client=()=>{if(closed||!runtime.identityAccounts)fail('native_account_link_unavailable');return runtime.identityAccounts;};
 const wrap=run=>async(input,ctx)=>{try{return await run(input,ctx);}catch(error){return{isError:true,...nativeResult({error:codeOf(error),originalOperationRetained:true})};}};
 const prune=()=>{for(const[key,value]of previews)if(value.state==='prepared'&&value.expiresAt<=now()){value.client.cancel(value.preview);previews.delete(key);}};
 server.registerTool('galaxy_identity_account_read',{inputSchema:nativeIdentityAccountReadSchema,
  description:'Use this installed local plugin to read configured official-account providers, begin the existing OIDC login, read its exact status or this identity’s existing links, or cancel a pending login. Login alone never associates the ID. Keep the returned loginId; never invent a provider, identity or replacement login after an unknown result.',annotations:{readOnlyHint:false}},wrap(async({action,...input})=>nativeResult(await client().read(action,input))));
 server.registerTool('galaxy_identity_account_prepare',{inputSchema:z.strictObject({action:z.enum(['link','unlink']),id}),
  description:'Prepare the exact existing OIDC account association or unlink preview for this current local identity. Return the verified account, issuer and Galaxy ID for actual user review. Does not sign or associate.',annotations:{readOnlyHint:true}},wrap(async({action,id})=>{
   prune();if(previews.size>=32)fail('native_account_preview_limit');await runtime.ensureConnection();const c=client(),lease=runtime.receiptStatus.captureLease();
   const preview=await c.prepare(action,{id});lease.assertCurrent();if(c!==client())fail('native_account_identity_changed');
   const content=JSON.parse(preview.previewJson),previewId=randomUUID(),expiresAt=Math.min(now()+300000,(content.target.expiresAt??Infinity)*1000);
   previews.set(previewId,{client:c,lease,preview,content,state:'prepared',expiresAt});
   return nativeResult({previewId,id,action,state:'prepared',preview:content,expiresAt,remoteSubmitted:false});
  }));
 server.registerTool('galaxy_identity_account_execute',{inputSchema:z.strictObject({previewId:id}),
  description:'Ask the actual user in the host form or temporary local review page to approve the shown official account and Galaxy ID, then sign the existing OIDC intent with this current Native control device. A model-provided confirmed field is never accepted. Reconcile an unknown original result before any exact-byte retry.',annotations:{readOnlyHint:false}},wrap(async({previewId},ctx)=>{
   prune();const op=previews.get(previewId);if(!op||op.client!==client())fail('native_account_preview_unavailable');op.lease.assertCurrent();
   if(op.state==='completed')return nativeResult(op.receipt);
   if(op.state==='unknown')return nativeResult(await op.client.recover(op.preview.id));
   if(op.state!=='prepared')return nativeResult({id:op.preview.id,state:op.state,originalOperationRetained:true});
   return review('galaxy_identity_account_execute',{previewId,preview:op.content,expiresAt:op.expiresAt},ctx,async()=>{
    op.lease.assertCurrent();if(op.client!==client()||op.state!=='prepared'||op.expiresAt<=now())fail('native_account_preview_expired_or_changed');op.state='running';
    try{op.receipt=await op.client.execute(op.preview,op.preview.confirmation);op.lease.assertCurrent();op.state='completed';return op.receipt;}
    catch(error){op.state=error?.outcome==='rejected'?'rejected':'unknown';op.lease.assertCurrent();if(op.state==='rejected')throw error;try{return await op.client.recover(op.preview.id);}catch{op.lease.assertCurrent();throw error;}}
   },{singleUse:true});
  }));
 server.registerTool('galaxy_identity_account_recover',{inputSchema:z.strictObject({id:id.optional()}),
  description:'Recover this local identity’s original already approved account operation. Omit id to list retained unfinished operations. Read the server’s durable association first; retry only the exact saved signed bytes on the same current binding, without a new login, ID or signature. Keys, bearers and signed packets are not returned.',annotations:{readOnlyHint:false}},wrap(async({id})=>nativeResult(id?await client().recover(id):await client().pending())));
 return{close(){closed=true;for(const op of previews.values())if(op.state==='prepared')op.client.cancel(op.preview);previews.clear();}};
}
