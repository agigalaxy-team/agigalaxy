import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createConsentClient } from './consent-client.mjs';
import { createCaseClient } from './case-client.mjs';
import { listLocalPublicationCases, prepareLocalCasePublication, saveLocalCasePublicationConsent,
  recordLocalCasePublication, getLocalCasePublication } from './local-case-publication.mjs';

// One explicit confirmation covers the displayed Consent AND exact Case payload.
export function createLocalPublicationFlow({ dataDirectory, endpoint, sessions, signIntent, consentSend, caseSend, caseRead,
  now = () => Math.floor(Date.now() / 1000) }) {
  const consents = createConsentClient({ endpoint, readAuthorization: () => sessions.readAuthorization(endpoint), signIntent, send: consentSend, now });
  const cases = createCaseClient({ endpoint, sessions, send: caseSend, read: caseRead });
  const operations = new WeakMap();
  async function prepare(localCaseId, { visibility = 'Private', viewers = [] } = {}) {
    if (!['Private', 'Public'].includes(visibility) || !Array.isArray(viewers)) throw new Error('Invalid publication visibility.');
    const authorization = await sessions.readAuthorization(endpoint);
    if (!authorization || !['consent', 'case-teaser'].every(scope => authorization.scopes.includes(scope)))
      throw new Error('Publication authorization required.');
    let record = await prepareLocalCasePublication(dataDirectory, endpoint, localCaseId);
    if (record.subjectId !== authorization.subjectId) throw new Error('Publication identity changed.');
    if (record.status === 'acknowledged') throw new Error('Case already acknowledged; use a revision for changes.');
    const issuedAt = now();
    const intent = record.consentIntent ?? { version: 1, id: randomUUID(), subjectId: record.subjectId,
      bindingId: authorization.bindingId, endpoint, objectId: record.eventId, action: 'case.teaser.publish',
      purpose: visibility === 'Public' ? 'public-profile' : 'operational', recipient: endpoint,
      fields: Object.keys(JSON.parse(record.payloadJson)), visibility, viewers, payloadHash: record.payloadHash,
      policyVersion: '0.1', issuedAt, expiresAt: Math.min(issuedAt + 3600, authorization.bindingExpiresAt) };
    if (intent.visibility !== visibility || JSON.stringify(intent.viewers) !== JSON.stringify(viewers))
      throw new Error('Publication Consent already frozen; reconcile the existing publication first.');
    const consentPreview = consents.prepare(intent);
    record = await saveLocalCasePublicationConsent(dataDirectory, endpoint, localCaseId, intent);
    const casePreview = cases.prepare({ consentId: intent.id, payloadJson: record.payloadJson });
    const hash = createHash('sha256').update(JSON.stringify([endpoint, consentPreview.intentJson, record.payloadJson])).digest('hex');
    const preview = Object.freeze({ endpoint, localCaseId, eventId: record.eventId, payloadJson: record.payloadJson,
      intentJson: consentPreview.intentJson, confirmation: `CONFIRM PUBLICATION ${record.eventId} ${hash}` });
    operations.set(preview, { consentPreview, casePreview, authorization, state: 'prepared' });
    return preview;
  }
  function cancel(preview) {
    const operation = operations.get(preview);
    if (!operation) throw new Error('Unknown publication preview.');
    operation.state = 'canceled'; consents.cancel(operation.consentPreview); cases.cancel(operation.casePreview);
  }
  async function execute(preview, confirmation) {
    const operation = operations.get(preview);
    if (!operation || operation.state !== 'prepared' || confirmation !== preview.confirmation)
      throw new Error('Exact publication confirmation required.');
    operation.state = 'executing';
    const check = async () => {
      if (operation.state === 'canceled' || !await sessions.isAuthorizationCurrent(operation.authorization)
        || !sessions.matchesAuthorization(operation.authorization)) throw new Error('Publication canceled or authorization changed.');
    };
    try {
      await check();
      await consents.execute(operation.consentPreview, operation.consentPreview.confirmation);
      await check();
      const receipt = await cases.execute(operation.casePreview, operation.casePreview.confirmation);
      await check();
      await recordLocalCasePublication(dataDirectory, endpoint, preview.localCaseId, receipt);
      operation.state = 'completed';
      return receipt;
    } catch (error) { if (operation.state !== 'canceled') operation.state = 'failed'; throw error; }
  }
  async function reconcile(localCaseId, { signal } = {}) {
    signal?.throwIfAborted();
    const record = await getLocalCasePublication(dataDirectory, endpoint, localCaseId);
    if (!record) return { state: 'not-prepared', localCaseId };
    let remote;
    try { remote = await cases.get(record.eventId, { signal }); }
    catch {
      signal?.throwIfAborted();
      return { state: 'unknown', localCaseId, eventId: record.eventId };
    }
    signal?.throwIfAborted();
    const event = remote.events.find(item => item.id === record.eventId && item.kind === 'case' && item.version === 1);
    if (!event) return { state: 'mismatch', localCaseId, eventId: record.eventId };
    const { version: _version, ...payload } = event;
    if (!isDeepStrictEqual(payload, JSON.parse(record.payloadJson))) return { state: 'mismatch', localCaseId, eventId: record.eventId };
    const receipt = { caseId: record.eventId, eventId: record.eventId, version: 1, verification: 'unverified' };
    await recordLocalCasePublication(dataDirectory, endpoint, localCaseId, receipt);
    return { state: 'acknowledged', localCaseId, eventId: record.eventId, checkedAt: now(), remoteState: remote.state };
  }
  return Object.freeze({ list: () => listLocalPublicationCases(dataDirectory, endpoint), prepare, execute, cancel, reconcile });
}
