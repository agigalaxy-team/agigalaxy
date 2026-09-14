import * as z from 'zod/v4';
import { randomUUID,createHash } from 'node:crypto';
import { caseEventSchema } from './shared/cases-schema.mjs';
import { assertCaseReview } from './domain/case-review.mjs';
import { createConsentClient } from './consent-client.mjs';
import { createCaseClient } from './case-client.mjs';

export function createCaseReviewFlow({endpoint,sessions,signIntent,consentSend,caseSend,caseRead,now=()=>Math.floor(Date.now()/1000)}){
  const cases=createCaseClient({endpoint,sessions,send:caseSend,read:caseRead});
  const consents=createConsentClient({endpoint,readAuthorization:()=>sessions.readAuthorization(endpoint),signIntent,send:consentSend,now});
  const operations=new WeakMap(),signing=new Set();
  async function prepare(input){
    const value=z.strictObject({caseId:z.uuid(),expectedVersion:z.number().int().positive(),targetEventId:z.uuid(),reason:z.string().trim().min(1).max(1200),summary:z.string().trim().min(1).max(1200),
      review:z.strictObject({threadId:z.uuid().optional(),type:z.enum(['correction','dispute']),state:z.enum(['opened','in-review','resolved','rejected','reopened'])}).optional(),
      visibility:z.enum(['Private','Public']).default('Private'),viewers:z.array(z.string().regex(/^GUID[0-9A-Z]{28}$/)).max(16).default([])}).parse(input);
    const authorization=await sessions.readAuthorization(endpoint);
    if(!authorization||!['case-teaser','consent'].every(scope=>authorization.scopes.includes(scope)))throw new Error('Case review authorization required.');
    const current=await cases.get(value.caseId);
    if(!sessions.matchesAuthorization(authorization)||!await sessions.isAuthorizationCurrent(authorization))throw new Error('Case review authorization changed.');
    if(current.version!==value.expectedVersion||current.state==='withdrawn')throw new Error('Case version changed; reload the history.');
    const events=current.events.map(({version:_version,...event})=>caseEventSchema.parse(event));
    if(!events.some(event=>event.id===value.targetEventId))throw new Error('Case review target missing.');
    const id=randomUUID(),event=caseEventSchema.parse({kind:'revision',id,caseId:value.caseId,expectedVersion:value.expectedVersion,
      correctsEventId:value.targetEventId,reason:value.reason,summary:value.summary,
      ...(value.review?{review:{...value.review,threadId:value.review.threadId??id}}:{})});
    assertCaseReview(event,events);
    const payloadJson=JSON.stringify(event),issuedAt=now();
    const intent={version:1,id:randomUUID(),subjectId:authorization.subjectId,bindingId:authorization.bindingId,endpoint,objectId:id,action:'case.teaser.publish',
      purpose:value.visibility==='Public'?'public-profile':'operational',recipient:endpoint,fields:Object.keys(event),visibility:value.visibility,viewers:value.viewers,
      payloadHash:createHash('sha256').update(payloadJson).digest('hex'),policyVersion:'0.1',issuedAt,expiresAt:Math.min(issuedAt+3600,authorization.bindingExpiresAt)};
    const consentPreview=consents.prepare(intent),intentJson=consentPreview.intentJson,actionPreview=cases.prepare({consentId:intent.id,payloadJson});
    const hash=createHash('sha256').update(JSON.stringify([endpoint,intentJson,payloadJson])).digest('hex');
    const preview=Object.freeze({endpoint,caseId:value.caseId,eventId:id,payloadJson,intentJson,confirmation:`CONFIRM CASE REVIEW ${id} ${hash}`});
    operations.set(preview,{authorization,consentPreview,actionPreview,state:'prepared'});return preview;
  }
  function cancel(preview){
    const operation=operations.get(preview);if(!operation)throw new Error('Unknown Case review preview.');
    operation.state='canceled';signing.delete(preview.intentJson);consents.cancel(operation.consentPreview);cases.cancel(operation.actionPreview);
  }
  async function execute(preview,confirmation){
    const operation=operations.get(preview);
    if(!operation||operation.state!=='prepared'||confirmation!==preview.confirmation)throw new Error('Exact Case review confirmation required.');
    operation.state='executing';
    const check=async()=>{if(operation.state==='canceled'||!sessions.matchesAuthorization(operation.authorization)||!await sessions.isAuthorizationCurrent(operation.authorization))throw new Error('Case review canceled or authorization changed.');};
    try{
      await check();signing.add(preview.intentJson);await consents.execute(operation.consentPreview,operation.consentPreview.confirmation);
      signing.delete(preview.intentJson);await check();
      const receipt=await cases.execute(operation.actionPreview,operation.actionPreview.confirmation);
      await check();operation.state='completed';return receipt;
    }catch(error){if(operation.state!=='canceled')operation.state='failed';throw error;}
    finally{signing.delete(preview.intentJson);}
  }
  return Object.freeze({prepare,execute,cancel,isSigningIntent:payload=>signing.has(payload)});
}
