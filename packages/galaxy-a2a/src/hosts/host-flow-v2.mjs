import { randomUUID } from 'node:crypto';
import { createA2aBridge } from '../protocol/bridge.mjs';
import { createA2aFactsV2 } from '../facts/facts-v2.mjs';
import { hash } from '../storage/journal.mjs';
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
  function assertBinding(binding) {
    const current = runtime.api.snapshot();
    if (current?.subjectId !== binding.subjectId || current.bindingId !== binding.bindingId
      || runtime.api.endpoint !== binding.endpoint || (current.generation ?? null) !== binding.generation)
      throw new Error('A2A connection changed; inspect original operation.');
  }
  async function adapter(peerId) {
    const snapshot = runtime.api.snapshot();
    if (!snapshot) throw new Error('Current native connection required.');
    const binding = Object.freeze({ subjectId: snapshot.subjectId, bindingId: snapshot.bindingId,
      endpoint: runtime.api.endpoint, generation: snapshot.generation ?? null });
    if ((await runtime.status()).identity !== binding.subjectId) throw new Error('Current native connection required.');
    assertBinding(binding);
    const peer = peers.find(p => p.id === peerId);
    if (!peer) throw new Error('Select a configured A2A peer.');
    const validate = async () => {
      assertBinding(binding);
      if (!Number.isSafeInteger(peer.trustExpiresAt) || peer.trustExpiresAt <= now()
        || hash(JSON.stringify(peer.agentCard)) !== peer.cardHash) throw new Error('Current configured AgentCard trust required.');
      let auth;
      try { auth = await readPeerAuthorization({ peerId, subjectId: binding.subjectId, endpoint: peer.endpoint,
        tenant: peer.tenant ?? '', peerPrincipal: peer.peerPrincipal, officialEndpoint: runtime.api.endpoint, cardHash: peer.cardHash }); }
      catch { throw new Error('External A2A authorization unavailable.'); }
      assertBinding(binding);
      if (!auth || auth.subjectId !== binding.subjectId || auth.peerPrincipal !== peer.peerPrincipal) throw new Error('External A2A authorization unavailable.');
      return auth;
    };
    await validate();
    const key = `${binding.subjectId}:${peerId}`;
    const cached = adapters.get(key);
    if (!cached || cached.binding.bindingId !== binding.bindingId || cached.binding.generation !== binding.generation
      || cached.binding.endpoint !== binding.endpoint) adapters.set(key, { binding, bridge: createA2aBridge({ ...peer, subjectId: binding.subjectId,
      directory, officialEndpoint: runtime.api.endpoint, authorize: validate, assertCurrent: () => assertBinding(binding), post, now,
      factsV2: createA2aFactsV2({ readCase: async (...args) => {
        assertBinding(binding); const result = await readCase(...args); assertBinding(binding); return result;
      }, readTask: async (id, { signal }) => {
        assertBinding(binding); const result = await runtime.api.call(`/v2/tasks/${id}`, undefined, { method: 'GET', signal });
        assertBinding(binding); return result;
      } }) }) });
    assertBinding(binding);
    return { bridge: adapters.get(key).bridge, binding, peer };
  }
  async function read(peerId, action, id, input) {
    const { bridge, binding } = await adapter(peerId);
    let result;
    if (action === 'list') result = await bridge.list();
    else if (action === 'get') result = await bridge.get(id);
    else if (action === 'poll') result = await bridge.poll(id);
    else if (action === 'reconcile-task') result = await bridge.reconcileTask(id, input);
    else if (action === 'reconcile-result') result = await reconcile(bridge, id, binding);
    else throw new Error('Unsupported A2A read.');
    assertBinding(binding);
    return result;
  }
  async function reconcile(bridge, id, binding) {
    const link = await bridge.get(id), saved = link.resultImportV2;
    assertBinding(binding);
    if (!saved) return { state: 'not-prepared' };
    // Query only the exact original accepted operation. A revoked source is
    // never reread, and acceptance does not restore access to its material.
    const event = saved.draft.event;
    const accepted = await runtime.api.call('/v2/cases/events/receipt',
      { caseId: link.caseId, eventId: event.eventId, payloadHash: saved.payloadHash });
    assertBinding(binding);
    if (accepted.caseId !== link.caseId || accepted.eventId !== event.eventId || accepted.payloadHash !== saved.payloadHash
      || accepted.authority !== 'accepted-operation-only' || accepted.currentAccessGranted !== false)
      throw new Error('A2A Result reconciliation conflict.');
    if (accepted.state === 'absent') return { state: 'absent', originalOperationRetained: true,
      authority: accepted.authority, currentAccessGranted: false };
    if (accepted.state !== 'acknowledged' || accepted.caseVersion !== event.expectedVersion + 1
      || accepted.verification !== 'not-provided' || accepted.acceptance !== 'not-provided' || accepted.resolution !== 'separate')
      throw new Error('A2A Result reconciliation conflict.');
    const caseVersion = accepted.caseVersion;
    const receipt = { caseId: event.caseId, eventId: event.eventId, version: caseVersion, caseVersion,
      objectRef: { id: event.eventId, version: 1 }, claimAuthority: 'participant-reported',
      verification: 'not-provided', acceptance: 'not-provided', resolution: 'separate',
      authority: accepted.authority, currentAccessGranted: false };
    await bridge.recordResultV2(id, receipt);
    assertBinding(binding);
    return { state: 'acknowledged', receipt, authority: accepted.authority, currentAccessGranted: false };
  }
  async function prepare(peerId, action, input) {
    const { bridge, binding } = await adapter(peerId);
    let preview;
    if (action === 'send') preview = await bridge.prepareStart(input);
    else if (action === 'reply') preview = await bridge.prepareReply(input.associationId, input.text);
    else if (action === 'cancel') preview = await bridge.prepareCancel(input.associationId);
    else if (action === 'result') {
      const draft = await bridge.prepareResultV2(input.associationId, input);
      assertBinding(binding);
      const link = await bridge.get(input.associationId);
      assertBinding(binding);
      if (link.resultImportV2.state === 'acknowledged') return { state: 'acknowledged', receipt: link.resultImportV2.receipt };
      const authorization = link.resultImportV2.authorization ?? { requestId: randomUUID(), action: 'case.teaser.publish',
        objectId: draft.event.eventId, payloadJson: link.resultImportV2.payloadJson, visibility: input.visibility ?? 'Private',
        viewers: input.viewers ?? [], ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) };
      await bridge.saveResultAuthorizationV2(input.associationId, authorization);
      assertBinding(binding);
      preview = Object.freeze({ kind: 'result', associationId: input.associationId, draft, authorization });
    } else throw new Error('Unsupported A2A action.');
    assertBinding(binding);
    previews.set(preview, { peerId, action, bridge, binding, used: false });
    return preview;
  }
  async function execute(preview, { confirmed = false } = {}) {
    const pending = previews.get(preview);
    if (!pending || pending.used || !confirmed) throw new Error('Reviewed A2A action required.');
    const { binding } = await adapter(pending.peerId);
    assertBinding(pending.binding);
    pending.used = true;
    if (pending.action !== 'result') {
      const result = await pending.bridge.execute(preview, preview.confirmation);
      assertBinding(pending.binding);
      return result;
    }
    const acknowledged = await reconcile(pending.bridge, preview.associationId, binding);
    if (acknowledged.state === 'acknowledged') return acknowledged.receipt;
    // Receipt absence never dispatches work. Only this separately confirmed
    // execution may retry the original frozen event, after current fact checks.
    if (acknowledged.state !== 'absent') throw new Error('Original Result unavailable.');
    // Revalidates exact Attempt/Participation before (re)using original Consent.
    await pending.bridge.prepareResultV2(preview.associationId, preview.draft.event);
    assertBinding(binding);
    const auth = await runtime.authorize(preview.authorization, { confirmed: true });
    assertBinding(binding);
    const receipt = await runtime.api.call('/v2/cases/events', { consentId: auth.consentId, payloadJson: preview.authorization.payloadJson });
    assertBinding(binding);
    await pending.bridge.recordResultV2(preview.associationId, receipt);
    assertBinding(binding);
    return { ...receipt, externalSource: preview.draft.source };
  }
  return Object.freeze({ read, prepare, execute, abort: preview => {
    const p = previews.get(preview); if (!p) throw new Error('Unknown A2A preview.');
    p.used = true; if (p.action !== 'result') p.bridge.abort(preview);
    return { localStopped: true, remoteCanceled: false, originalOperationRetained: true };
  }, peers: () => peers.map(({ id, name, endpoint, tenant, trustExpiresAt }) => ({ id, name, endpoint, tenant, trustExpiresAt })) });
}
