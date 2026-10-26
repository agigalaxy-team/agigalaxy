import { randomUUID,createHash } from 'node:crypto';
import { capsuleEventSchema,capsuleUseSchema } from "../../shared/capsule-schema.mjs";
import { createConsentClient } from "../consent.mjs";
import { createCapsuleClient } from "../capsule.mjs";
import { createCaseClient } from "../case.mjs";
export function createCapsuleFlow({endpoint,sessions,signIntent,consentSend,capsuleSend,caseSend,caseRead,now=()=>Math.floor(Date.now()/1000)}) {
  const capsules=createCapsuleClient({endpoint,sessions,send:capsuleSend}),cases=createCaseClient({endpoint,sessions,send:caseSend,read:caseRead});
  const consents=createConsentClient({endpoint,readAuthorization:()=>sessions.readAuthorization(endpoint),signIntent,send:consentSend,now});
  const operations=new WeakMap(),signing=new Set();
  async function prepare(input){const authorization=await sessions.readAuthorization(endpoint);
    if(!authorization||!['capsules','consent'].every(scope=>authorization.scopes.includes(scope)))throw new Error('Capsule authorization required.');
    const {visibility:requestedVisibility='Private',viewers:requestedViewers=[],...fields}=input;
    let payload,visibility=requestedVisibility,viewers=requestedViewers;
    const isUse=['reference','apply','reverify'].includes(input.kind);
    if(isUse){const current=await capsules.get({capsuleId:input.capsuleId,versionId:input.versionId});
      const data={...fields,id:randomUUID(),versionId:current.versionId,attribution:current.authorId};
      if(input.kind!=='reference'){
        const record=await cases.get(input.caseId),attempt=record.events.find(e=>e.id===input.attemptId&&e.kind==='attempt'),result=record.events.find(e=>e.id===input.resultId&&e.kind==='result');
        if(!attempt||!result||result.attemptId!==attempt.id)throw new Error('Current Case result required.');
        data.environment={name:attempt.configuration.environment,version:attempt.configuration.version};data.outcome=result.outcome;
      }
      payload=capsuleUseSchema.parse(data);
    }else if(input.kind==='version'){
      const current=input.capsuleId?await capsules.get({capsuleId:input.capsuleId}):null;
      if(current&&current.authorId!==authorization.subjectId)throw new Error('Capsule author required.');
      payload=capsuleEventSchema.parse({...fields,id:randomUUID(),capsuleId:input.capsuleId??randomUUID(),expectedRevision:current?.revision??0,version:current?.nextVersion??1});
    }else{
      const current=await capsules.get({capsuleId:input.capsuleId,versionId:input.versionId});
      if(current.authorId!==authorization.subjectId||!current.disclosure)throw new Error('Capsule author required.');
      payload=capsuleEventSchema.parse({...fields,id:randomUUID(),versionId:current.versionId,expectedRevision:current.revision});
      visibility=current.disclosure.visibility;viewers=current.disclosure.viewers;
    }
    const payloadJson=JSON.stringify(payload),issuedAt=now(),action=isUse?'capsule.use':'capsule.publish';
    const intent={version:1,id:randomUUID(),subjectId:authorization.subjectId,bindingId:authorization.bindingId,endpoint,objectId:payload.id,action,
      purpose:visibility==='Public'?'public-profile':'operational',recipient:endpoint,fields:Object.keys(payload),visibility,viewers,
      payloadHash:createHash('sha256').update(payloadJson).digest('hex'),policyVersion:'0.1',issuedAt,expiresAt:Math.min(issuedAt+2592000,authorization.bindingExpiresAt)};
    const consentPreview=consents.prepare(intent),intentJson=consentPreview.intentJson,actionPreview=capsules.prepare({consentId:intent.id,payloadJson});
    const hash=createHash('sha256').update(JSON.stringify([endpoint,intentJson,payloadJson])).digest('hex');
    const preview=Object.freeze({endpoint,capsuleId:payload.capsuleId,eventId:payload.id,kind:payload.kind,payloadJson,intentJson,confirmation:`CONFIRM CAPSULE ${payload.id} ${hash}`});
    operations.set(preview,{authorization,consentPreview,actionPreview,state:'prepared'});return preview;
  }
  function cancel(preview) {
    const operation = operations.get(preview); if (!operation) throw new Error('Unknown Capsule preview.');
    operation.state = 'canceled'; signing.delete(preview.intentJson);
    if (operation.consentPreview) consents.cancel(operation.consentPreview); capsules.cancel(operation.actionPreview);
  }
  async function execute(preview, confirmation) {
    const operation = operations.get(preview);
    if (!operation || operation.state !== 'prepared' || confirmation !== preview.confirmation) throw new Error('Exact Capsule confirmation required.');
    operation.state = 'executing';
    const check = async () => {
      if (operation.state === 'canceled' || !await sessions.isAuthorizationCurrent(operation.authorization)
        || !sessions.matchesAuthorization(operation.authorization)) throw new Error('Capsule canceled or authorization changed.');
    };
    try {
      await check();
      if (operation.consentPreview) {
        signing.add(preview.intentJson); await consents.execute(operation.consentPreview, operation.consentPreview.confirmation);
        signing.delete(preview.intentJson); await check();
      }
      const receipt = await capsules.execute(operation.actionPreview, operation.actionPreview.confirmation);
      await check(); operation.state = 'completed'; return receipt;
    } catch (error) { if (operation.state !== 'canceled') operation.state = 'failed'; throw error; }
    finally { signing.delete(preview.intentJson); }
  }
  return Object.freeze({ prepare, execute, cancel, isSigningIntent: payload => signing.has(payload) });
}
