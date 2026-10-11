import { randomUUID, createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { assistanceRequestSchema, assistanceEventSchema,publicContributionEventKinds } from './shared/assistance-schema.mjs';
import { createConsentClient } from './consent-client.mjs';
import { createAssistanceClient } from './assistance-client.mjs';
import { checkEventDraftTarget, eventFromDraft } from './shared/assistance-event-draft.mjs';

// Trusted host composition: one explicit confirmation covers Consent + payload.
export function createAssistanceFlow({ endpoint, sessions, signIntent, consentSend, assistanceSend, assistanceRead, journal,
  now = () => Math.floor(Date.now() / 1000) }) {
  const consents = createConsentClient({ endpoint, readAuthorization: () => sessions.readAuthorization(endpoint), signIntent, send: consentSend, now });
  const assistance = createAssistanceClient({ endpoint, sessions, send: assistanceSend, read: assistanceRead });
  const operations = new WeakMap(), signing = new Set();
  async function prepare(input, {draftPreview=false} = {}) {
    const authorization = await sessions.readAuthorization(endpoint);
    if (!authorization || !['consent', 'assistance'].every(scope => authorization.scopes.includes(scope)))
      throw new Error('Assistance and Consent authorization required.');
    if (draftPreview) {
      if (!journal?.previewRequestDraft || input.request || input.assistanceId || input.event) throw new Error('Editable Assistance request draft required.');
      input = await journal.previewRequestDraft({subjectId:authorization.subjectId,id:input.draftId,expectedRevision:input.draftRevision,now:now()});
    }
    let payload, visibility = 'Private', viewers = [];
    if (input.request && !input.assistanceId && !input.event) {
      if(input.eventVisibility!==undefined)throw new Error('Event visibility applies only to a contribution event.');
      payload = assistanceRequestSchema.parse({ ...input.request, id: input.request.id ?? randomUUID() });
      if (payload.enrollmentExpiresAt <= now()) throw new Error('Enrollment deadline must be in the future.');
      visibility = payload.visibility; viewers = input.viewers ?? [];
    } else {
      z.uuid().parse(input.assistanceId);
      if (input.request || input.viewers) throw new Error('Event recipients come from the current collaboration.');
      const current = await assistance.get(input.assistanceId);
      let draft;
      if(input.draftId){
        if(!journal)throw new Error('Local Assistance draft store required.');
        draft=await journal.getDraft(input.draftId);
        if(draft.revision!==input.draftRevision||draft.status!=='editing'||!draft.content.eventKind||draft.content.source.version!==current.version
          ||draft.content.eventKind==='deliver'&&draft.content.source.caseReviewVersion!==current.deliverySource?.reviewVersion)
          throw new Error('Collaboration version or draft changed; review the current request before continuing.');
        checkEventDraftTarget(draft.content,current);
      }
      const event = draft ? eventFromDraft(draft) : assistanceEventSchema.parse({ ...input.event,
        ...(input.event?.kind==='deliver'&&input.event.caseReviewVersion===undefined&&current.deliverySource?{caseReviewVersion:current.deliverySource.reviewVersion}:{}),id: randomUUID(), expectedVersion: current.version });
      if(event.kind==='deliver'&&event.caseReviewVersion!==undefined&&event.caseReviewVersion!==current.deliverySource?.reviewVersion)
        throw new Error('Case source version changed or is not visible; review the source before delivery.');
      if(event.kind==='propose-resolution'&&event.outcome==='resume-work'&&current.eventFeatures?.resumeWorkResolution!==1)
        throw new Error('Resume-work resolution is not supported by this endpoint.');
      visibility=z.enum(['Private','Public']).parse(input.eventVisibility??'Private');
      if(visibility==='Public'&&event.kind==='requester-feedback'&&current.eventFeatures?.publicRequesterFeedback!==1)
        throw new Error('This endpoint does not support public requester feedback.');
      if(visibility==='Public'&&(current.request.visibility!=='Public'||!publicContributionEventKinds.includes(event.kind)))
        throw new Error('Public contribution requires a public request and an eligible contribution event.');
      payload = { assistanceId: input.assistanceId, event };
      viewers.push(current.requesterId);
      if (event.kind === 'invite') viewers.push(event.participantId);
      if (event.kind === 'select') {
        const offer = current.offers.find(offer => offer.id === event.offerId && !offer.withdrawn);
        if (!offer) throw new Error('Current offer required.');
        viewers.push(offer.providerId);
      } else if (event.kind !== 'shortlist' && current.selected) viewers.push(current.selected.providerId);
    }
    viewers = visibility==='Public'?[]:[...new Set(viewers)].filter(subjectId => subjectId !== authorization.subjectId);
    const payloadJson = JSON.stringify(payload), eventId = payload.event?.id ?? payload.id, issuedAt = now();
    const intent = { version: 1, id: randomUUID(), subjectId: authorization.subjectId, bindingId: authorization.bindingId,
      endpoint, objectId: eventId, action: 'assistance.publish', purpose: visibility === 'Public' ? 'public-profile' : 'operational',
      recipient: endpoint, fields: Object.keys(payload), visibility, viewers,
      payloadHash: createHash('sha256').update(payloadJson).digest('hex'), policyVersion: '0.1', issuedAt,
      expiresAt: Math.min(issuedAt + 2592000, authorization.bindingExpiresAt) };
    return prepareExact(payloadJson, intent, authorization, input.draftId, input.draftRevision, draftPreview);
  }
  async function prepareExact(payloadJson, intent, authorization, draftId, draftRevision, deferDraftCommit=false) {
    const payload = JSON.parse(payloadJson), eventId = payload.event?.id ?? payload.id;
    const consentPreview = consents.prepare(intent), request = { consentId: intent.id, payloadJson };
    const actionPreview = assistance.prepare(request);
    if (journal && !deferDraftCommit) {
      const saved = await journal.save({ subjectId: authorization.subjectId, payloadJson, intent: JSON.parse(consentPreview.intentJson), draftId, draftRevision });
      if (saved.status === 'acknowledged') throw new Error('Assistance event already acknowledged.');
    }
    const hash = createHash('sha256').update(JSON.stringify([endpoint, consentPreview.intentJson, payloadJson])).digest('hex');
    const preview = Object.freeze({ endpoint, assistanceId: payload.assistanceId ?? payload.id, eventId,
      payloadJson, intentJson: consentPreview.intentJson, confirmation: `CONFIRM COLLABORATION ${eventId} ${hash}` });
    operations.set(preview, { authorization, consentPreview, actionPreview, state: 'prepared',
      deferredDraft:deferDraftCommit?{draftId,draftRevision}:null, journalCommitted:!deferDraftCommit });
    return preview;
  }
  function cancel(preview) {
    const operation = operations.get(preview);
    if (!operation) throw new Error('Unknown collaboration preview.');
    operation.state = 'canceled'; signing.delete(preview.intentJson);
    consents.cancel(operation.consentPreview); assistance.cancel(operation.actionPreview);
  }
  async function execute(preview, confirmation) {
    const operation = operations.get(preview);
    if (!operation || operation.state !== 'prepared' || confirmation !== preview.confirmation)
      throw new Error('Exact collaboration confirmation required.');
    operation.state = 'executing';
    const check = async () => {
      if (operation.state === 'canceled' || !await sessions.isAuthorizationCurrent(operation.authorization)
        || !sessions.matchesAuthorization(operation.authorization)) throw new Error('Collaboration canceled or authorization changed.');
    };
    try {
      await check();
      if (operation.deferredDraft) {
        const saved = await journal.save({subjectId:operation.authorization.subjectId,payloadJson:preview.payloadJson,
          intent:JSON.parse(preview.intentJson),...operation.deferredDraft});
        if (saved.status === 'acknowledged') throw new Error('Assistance event already acknowledged.');
        operation.journalCommitted = true;
        await check();
      }
      if (journal) await journal.mark(preview.eventId, operation.authorization.subjectId, 'submitting');
      await check(); signing.add(preview.intentJson);
      await consents.execute(operation.consentPreview, operation.consentPreview.confirmation);
      signing.delete(preview.intentJson); await check();
      const receipt = await assistance.execute(operation.actionPreview, operation.actionPreview.confirmation);
      await check();
      if (journal) await journal.mark(preview.eventId, operation.authorization.subjectId, 'acknowledged', { ...receipt,
        consentId: JSON.parse(preview.intentJson).id, payloadHash: createHash('sha256').update(preview.payloadJson).digest('hex') });
      operation.state = 'completed'; return receipt;
    } catch (error) {
      if (operation.state !== 'canceled') operation.state = 'failed';
      if (journal && operation.journalCommitted) try { await journal.mark(preview.eventId, operation.authorization.subjectId, 'unknown'); } catch {}
      throw error;
    }
    finally { signing.delete(preview.intentJson); }
  }
  async function reconcile(eventId, {signal} = {}) {
    const record = await journal.get(eventId);
    if (!record) throw new Error('Local Assistance operation unavailable.');
    const authorization = await sessions.readAuthorization(endpoint);
    if (!authorization || authorization.subjectId !== record.subjectId) throw new Error('Assistance identity changed.');
    const result = await assistance.receipt({assistanceId:record.assistanceId,eventId,payloadHash:record.payloadHash}, {signal});
    signal?.throwIfAborted();
    if (result.state === 'acknowledged') await journal.mark(eventId, record.subjectId, 'acknowledged', result);
    else if (result.state === 'conflict') await journal.mark(eventId, record.subjectId, 'conflict');
    return result;
  }
  async function prepareRetry(eventId) {
    const result = await reconcile(eventId);
    if (result.state !== 'absent') throw new Error(`Assistance event ${result.state}; do not resubmit.`);
    const record = await journal.get(eventId), authorization = await sessions.readAuthorization(endpoint);
    if (!authorization || authorization.subjectId !== record.subjectId || !['consent','assistance'].every(scope => authorization.scopes.includes(scope)))
      throw new Error('Assistance and Consent authorization required.');
    const payload = JSON.parse(record.payloadJson), issuedAt = now();
    if (payload.event) {
      const current = await assistance.get(record.assistanceId);
      if (current.version !== payload.event.expectedVersion) throw new Error('Collaboration version changed; open the current request before a new action.');
      if(payload.event.kind==='deliver'&&payload.event.caseReviewVersion!==undefined&&payload.event.caseReviewVersion!==current.deliverySource?.reviewVersion)
        throw new Error('Case source version changed; review the current source before a new delivery.');
    } else if (payload.enrollmentExpiresAt <= issuedAt) throw new Error('Enrollment deadline expired; the saved request is not extended.');
    const previous = record.intents.at(-1);
    const intent = previous.bindingId === authorization.bindingId && previous.expiresAt > issuedAt ? previous :
      {...previous,id:randomUUID(),bindingId:authorization.bindingId,issuedAt,expiresAt:Math.min(issuedAt + 2592000, authorization.bindingExpiresAt)};
    return prepareExact(record.payloadJson, intent, authorization);
  }
  return Object.freeze({ prepare, ...(journal?.previewRequestDraft?{prepareDraft:input=>prepare(input,{draftPreview:true})}:{}), execute, cancel, isSigningIntent: payload => signing.has(payload),
    ...(journal ? { list: () => journal.list(), forget: id => journal.forget(id), reconcile, prepareRetry } : {}) });
}
