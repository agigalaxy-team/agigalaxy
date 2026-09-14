import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createA2aBridge } from './bridge.mjs';
import { createA2aFactsV2 } from './facts-v2.mjs';
import { hash } from './journal.mjs';
import * as z from 'zod/v4';

/** Optional native host component. Peers and external auth are host-selected;
 * no config discovery, identity creation, card fallback or model execution. */
export function createNativeA2aHostV2({ runtime, directory, peers, readPeerAuthorization, post, now = () => Date.now() }) {
  peers = structuredClone(z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), name: z.string().max(160).optional(),
    endpoint: z.url(), tenant: z.string().max(256).optional(), peerPrincipal: z.string().min(1).max(160),
    agentCard: z.record(z.string(), z.unknown()), cardHash: z.string().regex(/^[0-9a-f]{64}$/), trustExpiresAt: z.number().int().positive()
  })).min(1).max(32).parse(peers));
  if (new Set(peers.map(p => p.id)).size !== peers.length || typeof readPeerAuthorization !== 'function') throw new Error('Explicit unique A2A peers and authorization resolver required.');
  const adapters = new Map(), previews = new WeakMap();
  const readCase = (id, { signal, ...input } = {}) => runtime.api.call(`/v2/cases/${id}/read`, input, { signal });
  async function adapter(peerId) {
    const binding = runtime.api.snapshot();
    if (!binding || (await runtime.status()).identity !== binding.subjectId) throw new Error('Current native connection required.');
    const peer = peers.find(p => p.id === peerId);
    if (!peer) throw new Error('Select a configured A2A peer.');
    const validate = async () => {
      if (runtime.api.snapshot()?.subjectId !== binding.subjectId) throw new Error('A2A host identity changed.');
      if (!Number.isSafeInteger(peer.trustExpiresAt) || peer.trustExpiresAt <= now()
        || hash(JSON.stringify(peer.agentCard)) !== peer.cardHash) throw new Error('Current configured AgentCard trust required.');
      let auth;
      try { auth = await readPeerAuthorization({ peerId, subjectId: binding.subjectId, endpoint: peer.endpoint,
        tenant: peer.tenant ?? '', peerPrincipal: peer.peerPrincipal, officialEndpoint: runtime.api.endpoint, cardHash: peer.cardHash }); }
      catch { throw new Error('External A2A authorization unavailable.'); }
      if (!auth || auth.subjectId !== binding.subjectId || auth.peerPrincipal !== peer.peerPrincipal) throw new Error('External A2A authorization unavailable.');
      return auth;
    };
    await validate();
    const key = `${binding.subjectId}:${peerId}`;
    if (!adapters.has(key)) adapters.set(key, createA2aBridge({ ...peer, subjectId: binding.subjectId,
      directory, officialEndpoint: runtime.api.endpoint, authorize: validate, post, now,
      factsV2: createA2aFactsV2({ readCase, readTask: (id, { signal }) => runtime.api.call(`/v2/tasks/${id}`, undefined, { method: 'GET', signal }) }) }));
    return { bridge: adapters.get(key), binding, peer };
  }
  async function read(peerId, action, id) {
    const { bridge } = await adapter(peerId);
    if (action === 'list') return bridge.list();
    if (action === 'get') return bridge.get(id);
    if (action === 'poll') return bridge.poll(id);
    if (action === 'reconcile-result') return reconcile(bridge, id);
    throw new Error('Unsupported A2A read.');
  }
  async function reconcile(bridge, id) {
    const link = await bridge.get(id), saved = link.resultImportV2;
    if (!saved) return { state: 'not-prepared' };
    // Always refresh current source access; a cached ACK is not permission.
    const view = await readCase(link.caseId, link.factContext.taskId ? { taskId: link.factContext.taskId } : {});
    const found = view.events?.find(e => e.eventId === saved.draft.event.eventId);
    if (!found) return { state: view.coverage?.complete ? 'absent' : 'unavailable', originalOperationRetained: true };
    const { caseVersion, ...event } = found;
    if (!isDeepStrictEqual(event, saved.draft.event) || caseVersion !== event.expectedVersion + 1) throw new Error('A2A Result reconciliation conflict.');
    const receipt = { caseId: event.caseId, eventId: event.eventId, version: caseVersion, caseVersion,
      objectRef: { id: event.eventId, version: 1 }, claimAuthority: 'participant-reported',
      verification: 'not-provided', acceptance: 'not-provided', resolution: 'separate' };
    await bridge.recordResultV2(id, receipt);
    return { state: 'acknowledged', receipt, externalSource: saved.draft.source, authority: 'exact-current-authorized-event' };
  }
  async function prepare(peerId, action, input) {
    const { bridge, binding } = await adapter(peerId);
    let preview;
    if (action === 'send') preview = await bridge.prepareStart(input);
    else if (action === 'reply') preview = await bridge.prepareReply(input.associationId, input.text);
    else if (action === 'cancel') preview = await bridge.prepareCancel(input.associationId);
    else if (action === 'result') {
      const draft = await bridge.prepareResultV2(input.associationId, input);
      const link = await bridge.get(input.associationId);
      if (link.resultImportV2.state === 'acknowledged') return { state: 'acknowledged', receipt: link.resultImportV2.receipt };
      const authorization = link.resultImportV2.authorization ?? { requestId: randomUUID(), action: 'case.teaser.publish',
        objectId: draft.event.eventId, payloadJson: link.resultImportV2.payloadJson, visibility: input.visibility ?? 'Private',
        viewers: input.viewers ?? [], ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) };
      await bridge.saveResultAuthorizationV2(input.associationId, authorization);
      preview = Object.freeze({ kind: 'result', associationId: input.associationId, draft, authorization });
    } else throw new Error('Unsupported A2A action.');
    previews.set(preview, { peerId, action, bridge, bindingId: binding.bindingId, subjectId: binding.subjectId, used: false });
    return preview;
  }
  async function execute(preview, { confirmed = false } = {}) {
    const pending = previews.get(preview);
    if (!pending || pending.used || !confirmed) throw new Error('Reviewed A2A action required.');
    const { binding } = await adapter(pending.peerId);
    if (binding.subjectId !== pending.subjectId || binding.bindingId !== pending.bindingId) throw new Error('A2A connection changed; inspect original operation.');
    pending.used = true;
    if (pending.action !== 'result') return pending.bridge.execute(preview, preview.confirmation);
    const acknowledged = await reconcile(pending.bridge, preview.associationId);
    if (acknowledged.state === 'acknowledged') return { ...acknowledged.receipt, externalSource: acknowledged.externalSource };
    // A participant's projection may be incomplete because another person's
    // events are private. This does not prove absence. An explicitly requested
    // retry may submit only the already frozen ID, bytes and Consent to the
    // idempotent canonical endpoint; it never allocates a replacement event.
    if (!['absent', 'unavailable'].includes(acknowledged.state)) throw new Error('Original Result unavailable.');
    // Revalidates exact Attempt/Participation before (re)using original Consent.
    await pending.bridge.prepareResultV2(preview.associationId, preview.draft.event);
    const auth = await runtime.authorize(preview.authorization, { confirmed: true });
    const receipt = await runtime.api.call('/v2/cases/events', { consentId: auth.consentId, payloadJson: preview.authorization.payloadJson });
    await pending.bridge.recordResultV2(preview.associationId, receipt);
    return { ...receipt, externalSource: preview.draft.source };
  }
  return Object.freeze({ read, prepare, execute, abort: preview => {
    const p = previews.get(preview); if (!p) throw new Error('Unknown A2A preview.');
    p.used = true; if (p.action !== 'result') p.bridge.abort(preview);
    return { localStopped: true, remoteCanceled: false, originalOperationRetained: true };
  }, peers: () => peers.map(({ id, name, endpoint, tenant, trustExpiresAt }) => ({ id, name, endpoint, tenant, trustExpiresAt })) });
}
