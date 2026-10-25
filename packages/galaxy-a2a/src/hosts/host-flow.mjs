import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as z from 'zod/v4';
import { createA2aBridge } from '../protocol/bridge.mjs';
import { hash } from '../storage/journal.mjs';
import { createConsentClient } from '../../../galaxy-official/src/consent-client.mjs';
import { createCaseClient } from '../../../galaxy-official/src/case-client.mjs';

// Supply this factory explicitly to createLocalHostRuntime. Peer configuration
// is secret-free; credential resolution is a separate host callback, never UI.
export function a2aHostFactory({ peers, readPeerAuthorization, post }) {
  if (!Array.isArray(peers) || peers.length < 1 || peers.length > 32 || typeof readPeerAuthorization !== 'function')
    throw new Error('Explicit A2A peers and authorization resolver required.');
  const configured = structuredClone(peers);
  for (const peer of configured) {
    z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).parse(peer.id);
    z.string().min(1).max(160).parse(peer.name);
    if ('credential' in peer) throw new Error('Use the separate A2A credential resolver.');
  }
  if (new Set(configured.map(p => p.id)).size !== configured.length) throw new Error('Duplicate A2A peer ID.');
  return ({ dataDirectory, endpoint, sessions, cases, signIntent, consentSend, caseSend, caseRead, now }) => {
    const adapters = new Map(), operations = new WeakMap(), signing = new Set();
    const consents = createConsentClient({ endpoint, readAuthorization: () => sessions.readAuthorization(endpoint), signIntent, send: consentSend, now });
    const caseWriter = createCaseClient({ endpoint, sessions, send: caseSend, read: caseRead });
    async function authorized(scopes = ['case-teaser'], signal) {
      signal?.throwIfAborted();
      const actor = await sessions.readAuthorization(endpoint);
      if (!actor || !scopes.every(scope => actor.scopes.includes(scope)) || !await sessions.isAuthorizationCurrent(actor)
        || !sessions.matchesAuthorization(actor)) throw new Error('Current A2A host session required.');
      signal?.throwIfAborted();
      return actor;
    }
    async function adapter(peerId, signal) {
      const actor = await authorized(undefined, signal);
      const peer = configured.find(item => item.id === peerId);
      if (!peer) throw new Error('Choose a configured A2A endpoint.');
      const key = `${actor.subjectId}:${peer.id}`;
      if (!adapters.has(key)) adapters.set(key, createA2aBridge({ ...peer, officialEndpoint: endpoint,
        subjectId: actor.subjectId, directory: dataDirectory, cases, post, now: () => now() * 1000,
        authorize: async () => {
          const current = await authorized();
          if (current.subjectId !== actor.subjectId) throw new Error('A2A subject changed.');
          // No Official credential is exposed to the external resolver.
          const external = await readPeerAuthorization(Object.freeze({ id: peer.id, endpoint: peer.endpoint,
            tenant: peer.tenant ?? '', peerPrincipal: peer.peerPrincipal }), current.subjectId);
          if (external?.peerPrincipal !== peer.peerPrincipal) throw new Error('External A2A principal changed.');
          return { subjectId: current.subjectId, peerPrincipal: external.peerPrincipal, credential: external.credential };
        } }));
      return adapters.get(key);
    }
    async function read(method, input = {}, { signal } = {}) {
      await authorized(undefined, signal);
      if (method === 'peers') return configured.map(({ id, name, endpoint: peerEndpoint, tenant = '', peerPrincipal }) =>
        ({ id, name, endpoint: peerEndpoint, tenant, peerPrincipal }));
      const bridge = await adapter(input.peerId, signal);
      if (method === 'list') return bridge.list();
      if (method === 'get') return bridge.get(input.associationId);
      if (method === 'poll') return bridge.poll(input.associationId, { signal });
      if (method === 'reconcile') {
        const link = await bridge.get(input.associationId), saved = link.resultImport;
        if (!saved) return { state: 'not-prepared' };
        const remote = await cases.get(link.caseId, { signal });
        const event = remote.events.find(e => e.id === saved.draft.event.id);
        if (!event) return { state: 'not-observed', eventId: saved.draft.event.id };
        const { version, ...payload } = event;
        if (!isDeepStrictEqual(payload, saved.draft.event) || version !== saved.draft.event.expectedVersion + 1)
          throw new Error('A2A imported Result differs from the frozen event.');
        signal?.throwIfAborted();
        const receipt = { caseId: link.caseId, eventId: event.id, version, verification: 'unverified' };
        await bridge.recordResult(link.id, receipt);
        return { state: 'acknowledged', ...receipt };
      }
      throw new Error('Unknown A2A read operation.');
    }
    async function prepare(input) {
      const actor = await authorized(input.kind === 'result' ? ['case-teaser', 'consent'] : ['case-teaser']);
      const bridge = await adapter(input.peerId);
      let inner, consentPreview, casePreview;
      if (input.kind === 'send') inner = await bridge.prepareStart(input);
      else if (input.kind === 'reply') inner = await bridge.prepareReply(input.associationId, input.text);
      else if (input.kind === 'cancel') inner = await bridge.prepareCancel(input.associationId);
      else if (input.kind === 'result') {
        const draft = await bridge.prepareResult(input.associationId);
        const link = await bridge.get(input.associationId);
        if (link.resultImport.state === 'acknowledged') throw new Error('A2A Result already imported.');
        const visibility = input.visibility ?? 'Private', viewers = input.viewers ?? [];
        const payloadJson = JSON.stringify(draft.event);
        const intent = link.resultImport.consentIntent ?? { version: 1, id: randomUUID(), subjectId: actor.subjectId,
          bindingId: actor.bindingId, endpoint, objectId: draft.event.id, action: 'case.teaser.publish',
          purpose: visibility === 'Public' ? 'public-profile' : 'operational', recipient: endpoint,
          fields: Object.keys(draft.event), visibility, viewers, payloadHash: hash(payloadJson), policyVersion: '0.1',
          issuedAt: now(), expiresAt: Math.min(now() + 3600, actor.bindingExpiresAt) };
        if (intent.visibility !== visibility || !isDeepStrictEqual(intent.viewers, viewers)) throw new Error('A2A result visibility already frozen; reconcile the existing import.');
        consentPreview = consents.prepare(intent);
        await bridge.saveResultConsent(input.associationId, intent);
        casePreview = caseWriter.prepare({ consentId: intent.id, payloadJson });
        inner = { endpoint, associationId: input.associationId, payloadJson, intentJson: consentPreview.intentJson, eventId: draft.event.id };
      } else throw new Error('Unknown A2A action.');
      const contents = JSON.stringify({ peerId: input.peerId, kind: input.kind, ...inner });
      const preview = Object.freeze({ ...inner, peerId: input.peerId, kind: input.kind,
        confirmation: `CONFIRM A2A HOST ${hash(contents)}` });
      operations.set(preview, { bridge, inner, consentPreview, casePreview, actor, state: 'prepared' });
      return preview;
    }
    function cancel(preview) {
      const op = operations.get(preview);
      if (!op) return;
      op.state = 'canceled';
      if (op.consentPreview) { consents.cancel(op.consentPreview); caseWriter.cancel(op.casePreview); }
      else op.bridge.abort(op.inner);
    }
    async function execute(preview, confirmation) {
      const op = operations.get(preview);
      if (!op || op.state !== 'prepared' || confirmation !== preview.confirmation) throw new Error('Exact A2A host confirmation required.');
      op.state = 'executing';
      const check = async () => {
        if (op.state === 'canceled' || !await sessions.isAuthorizationCurrent(op.actor) || !sessions.matchesAuthorization(op.actor))
          throw new Error('A2A host operation canceled or session changed.');
      };
      try {
        await check();
        if (!op.consentPreview) return await op.bridge.execute(op.inner, op.inner.confirmation);
        const link = await op.bridge.get(preview.associationId);
        if (link.resultImport.state === 'acknowledged' || link.resultImport.sourceHash !== link.peer?.responseHash)
          throw new Error('A2A import already acknowledged or peer result changed.');
        signing.add(preview.intentJson);
        await consents.execute(op.consentPreview, op.consentPreview.confirmation);
        signing.delete(preview.intentJson);
        await check();
        const receipt = await caseWriter.execute(op.casePreview, op.casePreview.confirmation);
        await check();
        return await op.bridge.recordResult(preview.associationId, receipt);
      } finally { signing.delete(preview.intentJson); if (op.state === 'executing') op.state = 'finished'; }
    }
    return Object.freeze({ read, prepare, execute, cancel, isSigningIntent: payload => signing.has(payload) });
  };
}
