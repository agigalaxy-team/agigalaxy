import { randomUUID,createHash } from 'node:crypto';
import { builderEventSchema } from "../../shared/builders-schema.mjs";
import { createConsentClient } from "../consent.mjs";
import { createBuilderClient } from "../builder.mjs";
export function createBuilderFlow({endpoint,sessions,signIntent,consentSend,builderSend,journal,now=()=>Math.floor(Date.now()/1000)}) {
  const builders=createBuilderClient({endpoint,sessions,send:builderSend});
  const consents=createConsentClient({endpoint,readAuthorization:()=>sessions.readAuthorization(endpoint),signIntent,send:consentSend,now});
  const operations=new WeakMap(),signing=new Set();
  async function prepare(input){const authorization=await sessions.readAuthorization(endpoint);
    if(!authorization||!['builders','consent'].every(scope=>authorization.scopes.includes(scope)))throw new Error('Builder authorization required.');
    const {visibility:requestedVisibility='Private',viewers:requestedViewers=[],baseDeclarationId,baseRevision,management=false,...fields}=input;
    const current=input.builderId?await builders[management?'manage':'get']({builderId:input.builderId}):null;
    if(baseDeclarationId&&current?.declarationId!==baseDeclarationId)throw new Error('Builder declaration changed; reopen the current version.');
    if(baseRevision!==undefined&&baseRevision!==current?.revision)throw new Error('Builder revision changed; reopen management.');
    let visibility=requestedVisibility,viewers=requestedViewers;
    if(input.kind==='declare'){
      if(current&&current.ownerId!==authorization.subjectId)throw new Error('Builder owner required.');
    }else{
      if(!current)throw new Error('Current Builder declaration required.');
      if(input.declarationId&&input.declarationId!==current.declarationId)throw new Error('Builder declaration changed.');
      const disclosure=input.kind==='compatibility'?current.reportDisclosure:['node-control','work-evidence','probe-request'].includes(input.kind)?current.nodeControlDisclosure
        :['node-control-revoke','work-evidence-revoke'].includes(input.kind)?(current.disclosure??current.nodeControlDisclosure):current.disclosure;
      if(!disclosure){
        if(!management||current.ownerId!==authorization.subjectId||input.kind!=='maintenance'||!current.allowedActions.includes(input.action))throw new Error('Builder owner or configured assessor required.');
      }else{visibility=disclosure.visibility;viewers=disclosure.viewers;}
    }
    const issuedAt=now();
    const payload=builderEventSchema.parse({...fields,id:randomUUID(),builderId:input.builderId??randomUUID(),expectedRevision:current?.revision??0,
      ...(input.kind==='declare'?{}:{declarationId:current.declarationId}),
      ...(['compatibility','node-control','work-evidence','probe-request'].includes(input.kind)?{declarationHash:current.declarationHash}:{}),
      ...(['work-evidence','probe-request'].includes(input.kind)?{controlId:current.nodeControl?.controlId,nodeId:current.declaration.nodeId}:{}),
      ...(input.kind==='probe-request'?{target:current.declaration.a2a}:{}),
      ...(input.kind==='node-control'?{ownerId:current.ownerId,nodeId:current.declaration.nodeId,expiresAt:Math.min(input.expiresAt??issuedAt+86400,authorization.bindingExpiresAt)}:{}),
      ...(input.kind==='node-control-revoke'?{controlId:current.nodeControl?.controlId}:{})});
    const payloadJson=JSON.stringify(payload),action='builder.publish';
    const intent={version:1,id:randomUUID(),subjectId:authorization.subjectId,bindingId:authorization.bindingId,endpoint,objectId:payload.id,action,
      purpose:visibility==='Public'?'public-profile':'operational',recipient:endpoint,fields:Object.keys(payload),visibility,viewers,
      payloadHash:createHash('sha256').update(payloadJson).digest('hex'),policyVersion:'0.1',issuedAt,expiresAt:Math.min(issuedAt+2592000,authorization.bindingExpiresAt)};
    return prepareExact(payloadJson,intent,authorization);
  }
  async function prepareExact(payloadJson,intent,authorization){
    const payload=builderEventSchema.parse(JSON.parse(payloadJson));
    const consentPreview=consents.prepare(intent),intentJson=consentPreview.intentJson,actionPreview=builders.prepare({consentId:intent.id,payloadJson});
    if(journal){const saved=await journal.save({subjectId:authorization.subjectId,payloadJson,intent:JSON.parse(intentJson)});if(saved.status==='acknowledged')throw new Error('Builder event already acknowledged.');}
    const hash=createHash('sha256').update(JSON.stringify([endpoint,intentJson,payloadJson])).digest('hex');
    const preview=Object.freeze({endpoint,builderId:payload.builderId,eventId:payload.id,kind:payload.kind,payloadJson,intentJson,confirmation:`CONFIRM BUILDER ${payload.id} ${hash}`});
    operations.set(preview,{authorization,consentPreview,actionPreview,state:'prepared'});return preview;
  }
  function cancel(preview) {
    const operation = operations.get(preview); if (!operation) throw new Error('Unknown Builder preview.');
    operation.state = 'canceled'; signing.delete(preview.intentJson);
    if (operation.consentPreview) consents.cancel(operation.consentPreview); builders.cancel(operation.actionPreview);
  }
  async function execute(preview, confirmation) {
    const operation = operations.get(preview);
    if (!operation || operation.state !== 'prepared' || confirmation !== preview.confirmation) throw new Error('Exact Builder confirmation required.');
    operation.state = 'executing';
    const check = async () => {
      if (operation.state === 'canceled' || !await sessions.isAuthorizationCurrent(operation.authorization)
        || !sessions.matchesAuthorization(operation.authorization)) throw new Error('Builder canceled or authorization changed.');
    };
    try {
      await check();
      if(journal)await journal.mark(preview.eventId,operation.authorization.subjectId,'submitting');
      await check();
      if (operation.consentPreview) {
        signing.add(preview.intentJson); await consents.execute(operation.consentPreview, operation.consentPreview.confirmation);
        signing.delete(preview.intentJson); await check();
      }
      const receipt = await builders.execute(operation.actionPreview, operation.actionPreview.confirmation);
      await check();
      if(journal)await journal.mark(preview.eventId,operation.authorization.subjectId,'acknowledged',{...receipt,
        consentId:JSON.parse(preview.intentJson).id,payloadHash:createHash('sha256').update(preview.payloadJson).digest('hex')});
      operation.state = 'completed'; return receipt;
    } catch (error) { if (operation.state !== 'canceled') operation.state = 'failed';
      if(journal)try{await journal.mark(preview.eventId,operation.authorization.subjectId,'unknown');}catch{}
      throw error; }
    finally { signing.delete(preview.intentJson); }
  }
  async function reconcile(eventId,{signal}={}){
    const record=await journal.get(eventId);if(!record)throw new Error('Local Builder operation unavailable.');
    const authorization=await sessions.readAuthorization(endpoint);
    if(!authorization||authorization.subjectId!==record.subjectId)throw new Error('Builder identity changed.');
    const result=await builders.receipt({builderId:record.builderId,eventId,payloadHash:record.payloadHash},{signal});
    signal?.throwIfAborted();
    if(result.state==='acknowledged')await journal.mark(eventId,record.subjectId,'acknowledged',result);
    else if(result.state==='conflict')await journal.mark(eventId,record.subjectId,'conflict');
    return result;
  }
  async function prepareRetry(eventId){
    const result=await reconcile(eventId);if(result.state!=='absent')throw new Error(`Builder event ${result.state}; do not resubmit.`);
    const record=await journal.get(eventId),authorization=await sessions.readAuthorization(endpoint);
    if(!authorization||record.subjectId!==authorization.subjectId||!['consent','builders'].every(scope=>authorization.scopes.includes(scope)))throw new Error('Builder authorization required.');
    const previous=record.intents.at(-1),issuedAt=now();
    const intent=previous.bindingId===authorization.bindingId&&previous.expiresAt>issuedAt?previous:
      {...previous,id:randomUUID(),bindingId:authorization.bindingId,issuedAt,expiresAt:Math.min(issuedAt+2592000,authorization.bindingExpiresAt)};
    return prepareExact(record.payloadJson,intent,authorization);
  }
  return Object.freeze({ prepare, execute, cancel, isSigningIntent: payload => signing.has(payload),
    ...(journal?{list:()=>journal.list(),forget:eventId=>journal.forget(eventId),reconcile,prepareRetry}:{}) });
}
