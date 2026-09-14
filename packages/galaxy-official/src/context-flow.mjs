import { randomUUID, createHash } from 'node:crypto';
import { contextGrantSchema, contextAcceptanceSchema, contextScopeEvent } from './shared/context-schema.mjs';
import { createConsentClient } from './consent-client.mjs';
import { createContextClient } from './context-client.mjs';
import { createAssistanceClient } from './assistance-client.mjs';
import { contextDraftSource, sameContextSource, grantFromDraft } from './shared/context-draft.mjs';
export function createContextFlow({ endpoint, sessions, signIntent, consentSend, contextSend, contextRead, assistanceSend, assistanceRead, journal,
  now = () => Math.floor(Date.now() / 1000) }) {
  const contexts = createContextClient({ endpoint, sessions, send: contextSend, read: contextRead });
  const assistance = createAssistanceClient({ endpoint, sessions, send: assistanceSend, read: assistanceRead });
  const consents = createConsentClient({ endpoint, readAuthorization: () => sessions.readAuthorization(endpoint), signIntent, send: consentSend, now });
  const operations = new WeakMap(), signing = new Set();
  async function prepare(input) {
    const authorization = await sessions.readAuthorization(endpoint);
    if (!authorization || !(input.kind === 'revoke' ? ['context'] : ['context', 'consent']).every(scope => authorization.scopes.includes(scope)))
      throw new Error('Context authorization required.');
    const consentPreview = null, intentJson = null;
    let actionPreview, payloadJson = '{}';
    if (input.kind === 'revoke') actionPreview = contexts.prepare({ kind: 'revoke', grantId: input.grantId });
    else {
      let payload, viewer, expiresAt;
      if (input.kind === 'grant') {
        const current = await assistance.get(input.assistanceId);
        const source=contextDraftSource(current);
        if(input.draftId){
          if(!journal)throw new Error('Local Context draft store required.');
          const draft=await journal.getDraft(input.draftId),hours=Number(draft.content.hours);
          if(draft.revision!==input.draftRevision||draft.status!=='editing'||!sameContextSource(draft.content.source,source))
            throw new Error('Context recipient or scope changed; review the saved materials.');
          if(!Number.isFinite(hours)||hours<=0||hours>24)throw new Error('Context validity must be over 0 and at most 24 hours.');
          expiresAt=Math.min(Math.floor(now()+hours*3600),authorization.bindingExpiresAt);
          payload=grantFromDraft(draft,expiresAt);
        }else{
          expiresAt = Math.min(input.expiresAt ?? now() + 3600, authorization.bindingExpiresAt);
          payload = contextGrantSchema.parse({ id: randomUUID(), assistanceId: input.assistanceId, caseId: current.request.caseId,
          participantId: current.selected.providerId, scope: current.agreedScope, scopeEventId: contextScopeEvent(current), expiresAt,
          materials: input.materials.map(item => ({ id: randomUUID(), mediaType: 'text/plain', ...item })) });
        }
        viewer = payload.participantId;
      } else if (input.kind === 'accept') {
        const current = await contexts.get(input.grantId);
        if (current.state !== 'pending' || current.participantId !== authorization.subjectId) throw new Error('Pending participant grant required.');
        payload = contextAcceptanceSchema.parse({ id: randomUUID(), grantId: input.grantId, assistanceId: current.assistanceId,
          scopeEventId: current.scopeEventId, materialsHash: current.materialsHash });
        viewer = current.ownerId; expiresAt = Math.min(current.expiresAt, authorization.bindingExpiresAt);
      } else throw new Error('Unknown Context operation.');
      payloadJson = JSON.stringify(payload); const issuedAt = now();
      const intent = { version: 1, id: randomUUID(), subjectId: authorization.subjectId, bindingId: authorization.bindingId,
        endpoint, objectId: payload.id, action: 'context.grant', purpose: 'operational', recipient: endpoint,
        fields: Object.keys(payload), visibility: 'Private', viewers: [viewer], payloadHash: createHash('sha256').update(payloadJson).digest('hex'),
        policyVersion: '0.1', issuedAt, expiresAt };
      return prepareExact(input.kind,payloadJson,intent,authorization,input.draftId,input.draftRevision);
    }
    return previewFor(input.kind,authorization,consentPreview,actionPreview,payloadJson,intentJson);
  }
  async function prepareExact(kind,payloadJson,intent,authorization,draftId,draftRevision){
    const consentPreview=consents.prepare(intent),intentJson=consentPreview.intentJson,actionPreview=contexts.prepare({consentId:intent.id,payloadJson});
    if(journal){
      const saved=await journal.save({subjectId:authorization.subjectId,payloadJson,intent:JSON.parse(intentJson),draftId,draftRevision});
      if(saved.status==='acknowledged')throw new Error('Context event already acknowledged.');
    }
    return previewFor(kind,authorization,consentPreview,actionPreview,payloadJson,intentJson);
  }
  function previewFor(kind,authorization,consentPreview,actionPreview,payloadJson,intentJson){
    const hash = createHash('sha256').update(JSON.stringify([endpoint, intentJson, actionPreview.bodyJson, actionPreview.path])).digest('hex');
    const preview = Object.freeze({ endpoint, kind, grantId: actionPreview.grantId, eventId:kind==='revoke'?null:JSON.parse(payloadJson).id,payloadJson,intentJson,
      confirmation: `CONFIRM MATERIALS ${actionPreview.grantId} ${hash}` });
    operations.set(preview, { authorization, consentPreview, actionPreview, state: 'prepared' }); return preview;
  }
  function cancel(preview) {
    const operation = operations.get(preview); if (!operation) throw new Error('Unknown Context preview.');
    operation.state = 'canceled'; signing.delete(preview.intentJson);
    if (operation.consentPreview) consents.cancel(operation.consentPreview); contexts.cancel(operation.actionPreview);
  }
  async function execute(preview, confirmation) {
    const operation = operations.get(preview);
    if (!operation || operation.state !== 'prepared' || confirmation !== preview.confirmation) throw new Error('Exact materials confirmation required.');
    operation.state = 'executing';
    const check = async () => {
      if (operation.state === 'canceled' || !await sessions.isAuthorizationCurrent(operation.authorization)
        || !sessions.matchesAuthorization(operation.authorization)) throw new Error('Context canceled or authorization changed.');
    };
    try {
      await check();
      if(journal&&preview.kind!=='revoke')await journal.mark(preview.eventId,operation.authorization.subjectId,'submitting');
      await check();
      if (operation.consentPreview) {
        signing.add(preview.intentJson); await consents.execute(operation.consentPreview, operation.consentPreview.confirmation);
        signing.delete(preview.intentJson); await check();
      }
      const receipt = await contexts.execute(operation.actionPreview, operation.actionPreview.confirmation);
      await check();
      if(journal&&preview.kind!=='revoke')await journal.mark(preview.eventId,operation.authorization.subjectId,'acknowledged',{
        grantId:preview.grantId,eventId:preview.eventId,kind:preview.kind,consentId:JSON.parse(preview.intentJson).id,
        payloadHash:createHash('sha256').update(preview.payloadJson).digest('hex')});
      operation.state = 'completed'; return receipt;
    } catch (error) { if (operation.state !== 'canceled') operation.state = 'failed';
      if(journal&&preview.kind!=='revoke')try{await journal.mark(preview.eventId,operation.authorization.subjectId,'unknown');}catch{}
      throw error; }
    finally { signing.delete(preview.intentJson); }
  }
  async function reconcile(eventId,{signal}={}){
    const row=await journal.get(eventId),authorization=await sessions.readAuthorization(endpoint);
    if(!row||!authorization||row.subjectId!==authorization.subjectId)throw new Error('Local Context operation unavailable.');
    const result=await contexts.receipt({kind:row.kind,grantId:row.grantId,eventId,payloadHash:row.payloadHash},{signal});
    signal?.throwIfAborted();
    if(result.state==='acknowledged')await journal.mark(eventId,row.subjectId,'acknowledged',result);
    else if(result.state==='conflict')await journal.mark(eventId,row.subjectId,'conflict');
    return result;
  }
  async function prepareRetry(eventId){
    const result=await reconcile(eventId);if(result.state!=='absent')throw new Error(`Context event ${result.state}; do not resubmit.`);
    const row=await journal.get(eventId),authorization=await sessions.readAuthorization(endpoint);
    if(!authorization||row.subjectId!==authorization.subjectId||!['context','consent'].every(scope=>authorization.scopes.includes(scope)))throw new Error('Context authorization required.');
    const payload=JSON.parse(row.payloadJson),issuedAt=now();let expiresAt;
    if(row.kind==='grant'){
      const source=contextDraftSource(await assistance.get(payload.assistanceId));
      if(source.caseId!==payload.caseId||source.participantId!==payload.participantId||source.scope!==payload.scope||source.scopeEventId!==payload.scopeEventId)
        throw new Error('Context collaboration changed; the saved grant is not reassigned.');
      expiresAt=payload.expiresAt;
    }else{
      const current=await contexts.get(row.grantId);
      if(current.state!=='pending'||current.participantId!==authorization.subjectId||current.scopeEventId!==payload.scopeEventId||current.materialsHash!==payload.materialsHash
        ||current.assistanceId!==payload.assistanceId||current.ownerId!==row.intents.at(-1).viewers[0])throw new Error('Context acceptance target changed.');
      expiresAt=current.expiresAt;
    }
    if(expiresAt<=issuedAt)throw new Error('Context grant expired; the saved deadline is not extended.');
    const previous=row.intents.at(-1),intent=previous.bindingId===authorization.bindingId&&previous.expiresAt>issuedAt?previous:
      {...previous,id:randomUUID(),bindingId:authorization.bindingId,issuedAt,expiresAt:Math.min(expiresAt,authorization.bindingExpiresAt)};
    return prepareExact(row.kind,row.payloadJson,intent,authorization);
  }
  return Object.freeze({ prepare, execute, cancel, isSigningIntent: payload => signing.has(payload),
    ...(journal?{list:()=>journal.list(),forget:id=>journal.forget(id),reconcile,prepareRetry}:{}) });
}
