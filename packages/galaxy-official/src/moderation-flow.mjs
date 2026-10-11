import { randomUUID, createHash } from 'node:crypto';
import { moderationReportSchema, moderationEventSchema } from './shared/moderation-schema.mjs';
import { createConsentClient } from './consent-client.mjs';
import { createModerationClient } from './moderation-client.mjs';
export function createModerationFlow({ endpoint, sessions, signIntent, consentSend, moderationSend, now = () => Math.floor(Date.now()/1000) }) {
  const moderation = createModerationClient({ endpoint, sessions, send: moderationSend });
  const consents = createConsentClient({ endpoint, readAuthorization: () => sessions.readAuthorization(endpoint), signIntent, send: consentSend, now });
  const operations = new WeakMap(), signing = new Set();
  async function prepare(input,{original=null}={}) {
    const authorization = await sessions.readAuthorization(endpoint);
    if (!authorization || !['moderation','consent'].every(scope=>authorization.scopes.includes(scope))) throw new Error('Moderation authorization required.');
    const currentAuthorization=async()=>{if(!await sessions.isAuthorizationCurrent(authorization)||!sessions.matchesAuthorization(authorization))throw new Error('Moderation authorization changed.');};
    if(original){
      if(original.reference.subjectId!==authorization.subjectId||createHash('sha256').update(original.payloadJson).digest('hex')!==original.reference.payloadHash)
        throw new Error('Original Moderation owner and payload required.');
      const result=await moderation.recover(original.reference);await currentAuthorization();
      if(result.state!=='absent') throw new Error('Original Moderation operation must be confirmed absent before renewed preparation.');
    }
    const config = await moderation.config();
    await currentAuthorization();
    if (!config.moderatorIds?.length) throw new Error('Moderation is not configured.');
    let payload, participation=null, recipients = config.moderatorIds;
    if (input.kind === 'report') {
      if(input.caseId&&!config.reportTargets?.includes('case'))throw new Error('Case moderation is not supported by this endpoint.');
      if(input.evidenceId&&!config.evidenceRevalidation)throw new Error('Evidence revalidation is not supported by this endpoint.');
      const {kind:_kind,...fields}=input;
      payload = moderationReportSchema.parse({ ...fields, id: original?JSON.parse(original.payloadJson).id:randomUUID() });
    }
    else {
      const current = await moderation.get(input.reportId);
      await currentAuthorization();
      if(original&&JSON.parse(original.payloadJson).expectedVersion!==current.version) throw new Error('Original Moderation version is no longer current.');
      const isStatement=['supplement','correct'].includes(input.kind);
      const verifierPermission={'invite-verifier':'canInviteVerifier','accept-verifier':'canAcceptVerifier','decline-verifier':'canDeclineVerifier',
        'withdraw-verifier':'canWithdrawVerifier','verification-response':'canSubmitVerification'};
      const isVerifier=Object.hasOwn(verifierPermission,input.kind);
      if(isVerifier){if(config.verifierParticipation!==1||!current[verifierPermission[input.kind]])throw new Error('Verifier participation is not available for this action.');}
      else if(input.kind==='correct'?!current.canCorrectEventIds?.length:input.kind === 'appeal' ? !current.canAppeal : isStatement ? !current.canSupplement : !current.canModerate) throw new Error('Moderation role required.');
      if(input.kind==='revalidate'&&(!current.canRevalidate||current.revalidation?.evidenceId!==input.evidenceId))throw new Error('Authorized Evidence revalidation required.');
      if(input.kind==='correct'&&!current.canCorrectEventIds?.includes(input.correctsEventId))throw new Error('Own moderation statement required.');
      let fields=input;
      if(input.kind==='invite-verifier'){
        const report=current.report;if(!report)throw new Error('Visible report required.');
        fields={...input,target:report.caseId?{caseId:report.caseId,caseVersion:report.caseVersion,targetEventId:report.targetEventId,
          ...(report.evidenceId?{evidenceId:report.evidenceId}:{})}:{assistanceId:report.assistanceId}};
      }else if(isVerifier){
        const invitationId=current.verifierParticipation?.own?.invitationId;
        if(!invitationId||input.invitationId&&input.invitationId!==invitationId)throw new Error('Current verifier invitation required.');
        fields={...input,invitationId};
        participation=current.verifierParticipation.own;
      }
      payload = moderationEventSchema.parse({ ...fields, id: original?JSON.parse(original.payloadJson).id:randomUUID(), expectedVersion: current.version });
      if (input.kind !== 'appeal'&&!(isStatement&&current.canAppeal)) recipients = [...recipients, current.reporterId, ...current.participantIds];
      if(input.kind==='invite-verifier')recipients.push(input.verifierId);
    }
    await currentAuthorization();
    const payloadJson = original?original.payloadJson:JSON.stringify(payload), issuedAt = now();
    if(original&&(payload.id!==original.reference.eventId||(payload.reportId??payload.id)!==original.reference.reportId||
      (payload.expectedVersion?payload.expectedVersion+1:1)!==original.reference.expectedVersion)) throw new Error('Original Moderation operation reference mismatch.');
    const intent = { version: 1, id: randomUUID(), subjectId: authorization.subjectId, bindingId: authorization.bindingId,
      endpoint, objectId: payload.id, action: 'moderation.publish', purpose: 'operational', recipient: endpoint,
      fields: Object.keys(JSON.parse(payloadJson)), visibility: 'Private', viewers: [...new Set(recipients)].filter(id=>id!==authorization.subjectId).sort((a,b)=>a.localeCompare(b)),
      payloadHash: createHash('sha256').update(payloadJson).digest('hex'), policyVersion: '0.1', issuedAt,
      expiresAt: Math.min(issuedAt+3600, authorization.bindingExpiresAt) };
    const consentPreview = consents.prepare(intent), intentJson = consentPreview.intentJson;
    const actionPreview = moderation.prepare({ consentId: intent.id, payloadJson },{subjectId:authorization.subjectId,authorization});
    const hash = createHash('sha256').update(JSON.stringify([endpoint,intentJson,payloadJson])).digest('hex');
    const preview = Object.freeze({ endpoint, kind: input.kind, reportId: actionPreview.reportId,eventId:actionPreview.eventId,
      payloadHash:actionPreview.payloadHash,expectedVersion:actionPreview.expectedVersion,subjectId:authorization.subjectId,payloadJson, intentJson,
      ...(participation?{participation:Object.freeze(structuredClone(participation))}:{}),
      confirmation: `CONFIRM MODERATION ${actionPreview.reportId} ${hash}` });
    operations.set(preview,{ authorization, consentPreview, actionPreview, state:'prepared',businessStarted:false }); return preview;
  }
  function cancel(preview) {
    const operation = operations.get(preview); if (!operation) throw new Error('Unknown Moderation preview.');
    operation.state = 'canceled'; signing.delete(preview.intentJson);
    if (operation.consentPreview) consents.cancel(operation.consentPreview); moderation.cancel(operation.actionPreview);
  }
  async function execute(preview, confirmation) {
    const operation = operations.get(preview);
    if (!operation || operation.state !== 'prepared' || confirmation !== preview.confirmation) throw new Error('Exact materials confirmation required.');
    operation.state = 'executing';
    const check = async () => {
      if (operation.state === 'canceled' || !await sessions.isAuthorizationCurrent(operation.authorization)
        || !sessions.matchesAuthorization(operation.authorization)) throw new Error('Moderation canceled or authorization changed.');
    };
    try {
      await check();
      if (operation.consentPreview) {
        signing.add(preview.intentJson); await consents.execute(operation.consentPreview, operation.consentPreview.confirmation);
        operation.consentPreview=null;signing.delete(preview.intentJson); await check();
      }
      operation.businessStarted=true;
      const receipt = await moderation.execute(operation.actionPreview, operation.actionPreview.confirmation);
      await check(); operation.state = 'completed'; return receipt;
    } catch (error) { if (operation.state !== 'canceled') operation.state = operation.businessStarted?'unknown':'failed'; throw error; }
    finally { signing.delete(preview.intentJson); }
  }
  async function reconcile(preview,options){
    const operation=operations.get(preview);if(!operation)throw new Error('Unknown Moderation preview.');
    const result=await moderation.reconcile(operation.actionPreview,options);
    operation.state=result.state==='acknowledged'?'completed':result.state==='absent'?'prepared':'conflict';return result;
  }
  function recoveryReference(preview){const operation=operations.get(preview);if(!operation)throw new Error('Unknown Moderation preview.');return moderation.recoveryReference(operation.actionPreview);}
  async function prepareExisting({reference,payloadJson}){
    if(typeof payloadJson!=='string'||Buffer.byteLength(payloadJson)>16000)throw new Error('Invalid Moderation payload.');
    const raw=JSON.parse(payloadJson),isEvent=Object.hasOwn(raw,'reportId');
    const payload=(isEvent?moderationEventSchema:moderationReportSchema).parse(raw);
    return prepare(isEvent?payload:{kind:'report',...payload},{original:{reference,payloadJson}});
  }
  return Object.freeze({ prepare,prepareExisting,execute,cancel,reconcile,recover:moderation.recover,recoveryReference,isSigningIntent: payload => signing.has(payload) });
}
