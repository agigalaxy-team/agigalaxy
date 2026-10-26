import * as z from 'zod/v4';
import { randomUUID,createHash } from 'node:crypto';
import { selfDeclaredProfileSchema,profileStatementSchema } from "../../shared/profile-schema.mjs";
import { createConsentClient } from "../consent.mjs";
import { createHistoryClient } from "../history.mjs";

export function createProfileFlow({endpoint,sessions,signIntent,consentSend,historySend,now=()=>Math.floor(Date.now()/1000)}){
  const history=createHistoryClient({endpoint,sessions,send:historySend});
  const consents=createConsentClient({endpoint,readAuthorization:()=>sessions.readAuthorization(endpoint),signIntent,send:consentSend,now});
  const operations=new WeakMap(),signing=new Set();
  async function prepare(input){
    const value=z.strictObject({expectedRevision:z.number().int().nonnegative(),selfDeclared:selfDeclaredProfileSchema,
      visibility:z.enum(['Private','Public']).default('Private'),viewers:z.array(z.string().regex(/^GUID[0-9A-Z]{28}$/)).max(16).default([])}).parse(input);
    const authorization=await sessions.readAuthorization(endpoint);
    if(!authorization||!['history','consent'].every(scope=>authorization.scopes.includes(scope)))throw new Error('Profile authorization required.');
    const current=await history.profile(authorization.subjectId);
    if(!sessions.matchesAuthorization(authorization)||!await sessions.isAuthorizationCurrent(authorization))throw new Error('Profile authorization changed.');
    if(current.selfDeclaredRevision!==value.expectedRevision)throw new Error('Profile revision changed; reload before editing.');
    const payload=profileStatementSchema.parse({id:randomUUID(),expectedRevision:value.expectedRevision,selfDeclared:value.selfDeclared});
    const payloadJson=JSON.stringify(payload),issuedAt=now();
    if (payloadJson.length > 12000) throw new Error('Profile exceeds 12000 characters; shorten the selected descriptions before publishing.');
    const intent={version:1,id:randomUUID(),subjectId:authorization.subjectId,bindingId:authorization.bindingId,endpoint,objectId:payload.id,action:'profile.publish',
      purpose:value.visibility==='Public'?'public-profile':'operational',recipient:endpoint,fields:Object.keys(payload),visibility:value.visibility,viewers:value.viewers,
      payloadHash:createHash('sha256').update(payloadJson).digest('hex'),policyVersion:'0.1',issuedAt,expiresAt:Math.min(issuedAt+3600,authorization.bindingExpiresAt)};
    const consentPreview=consents.prepare(intent),intentJson=consentPreview.intentJson;
    const hash=createHash('sha256').update(JSON.stringify([endpoint,intentJson,payloadJson])).digest('hex');
    const preview=Object.freeze({endpoint,subjectId:authorization.subjectId,eventId:payload.id,payloadJson,intentJson,confirmation:`CONFIRM PROFILE ${payload.id} ${hash}`});
    operations.set(preview,{authorization,consentPreview,state:'prepared',abort:new AbortController(),input:{consentId:intent.id,payloadJson}});
    return preview;
  }
  function cancel(preview){
    const operation=operations.get(preview);if(!operation)throw new Error('Unknown Profile preview.');
    operation.state='canceled';operation.abort.abort();signing.delete(preview.intentJson);consents.cancel(operation.consentPreview);
  }
  async function execute(preview,confirmation){
    const operation=operations.get(preview);
    if(!operation||operation.state!=='prepared'||confirmation!==preview.confirmation)throw new Error('Exact Profile confirmation required.');
    operation.state='executing';
    const check=async()=>{
      operation.abort.signal.throwIfAborted();
      if(!sessions.matchesAuthorization(operation.authorization)||!await sessions.isAuthorizationCurrent(operation.authorization))throw new Error('Profile authorization changed.');
      operation.abort.signal.throwIfAborted();
    };
    try{
      await check();signing.add(preview.intentJson);
      await consents.execute(operation.consentPreview,operation.consentPreview.confirmation);
      signing.delete(preview.intentJson);await check();
      const receipt=await history.publishProfile(operation.input,{signal:operation.abort.signal});
      await check();operation.state='completed';return receipt;
    }catch(error){if(operation.state!=='canceled')operation.state='failed';throw error;}
    finally{signing.delete(preview.intentJson);}
  }
  return Object.freeze({prepare,execute,cancel,isSigningIntent:payload=>signing.has(payload)});
}
