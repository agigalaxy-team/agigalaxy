import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { AgentCard, SendMessageRequest, GetTaskRequest, CancelTaskRequest } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { A2AError } from '@a2a-js/sdk/errors';
import { postA2aJson, validatePublicUrl } from '../../galaxy-official/src/public-fetch.mjs';
import { createJournal, hash } from './journal.mjs';
import { snapshot, terminal, resultDraft } from './mapping.mjs';
import { resultDraftV2 } from './facts-v2.mjs';

export const A2A_PROFILE = Object.freeze({ sdk: '1.1.0', protocol: '1.0', transport: 'JSONRPC', streaming: false });
const uuid = value => z.uuid().parse(value);
const selectedText = value => {
  z.string().min(1).max(12000).parse(value);
  if (Buffer.byteLength(JSON.stringify(value)) > 24000) throw new Error('Selected A2A text exceeds encoded request limit.');
  return value;
};
const label = value => z.string().min(1).max(160).refine(text => !/\p{Cc}/u.test(text)).parse(value);

/**
 * Host adapter, not an autonomous agent. authorize() must resolve the current
 * local actor and the separately approved external principal/credential.
 * cases.get() must be the authenticated, owner-scoped Galaxy Case client.
 * post is a trusted transport injection for hosts/tests, never peer input.
 */
export function createA2aBridge({ endpoint, tenant = '', agentCard, subjectId, peerPrincipal,
  officialEndpoint, directory, authorize, cases, factsV2, post = postA2aJson, now = () => Date.now() }) {
  endpoint = validatePublicUrl(endpoint).href;
  if (validatePublicUrl(officialEndpoint).origin !== officialEndpoint) throw new Error('Invalid Official origin.');
  z.string().regex(/^GUID[0-9A-Z]{28}$/).parse(subjectId);
  label(peerPrincipal);
  z.string().max(256).parse(tenant);
  if (typeof authorize !== 'function' || (typeof cases?.get !== 'function' && typeof factsV2?.resolve !== 'function')) throw new Error('Host authorization and Case reader required.');
  const card = AgentCard.fromJSON(agentCard);
  const selected = card.supportedInterfaces.find(item => item.url === endpoint && item.tenant === tenant
    && item.protocolBinding === A2A_PROFILE.transport && item.protocolVersion === A2A_PROFILE.protocol);
  if (!selected) throw new Error('Explicit A2A 1.0 JSONRPC interface required.');
  // Pin exactly one host-selected interface. No peer-selected fallback, card
  // refresh, OAuth navigation, push URL, or discovery request can occur here.
  card.supportedInterfaces = [selected];
  const scope = { subjectId, officialEndpoint, endpoint, tenant, peerPrincipal };
  const journal = createJournal(directory, scope);
  const pending = new WeakMap();

  async function access(caseId, attemptId, signal, frozen, selected) {
    signal?.throwIfAborted();
    const auth = await authorize(Object.freeze({ ...scope }));
    if (auth?.subjectId !== subjectId || auth?.peerPrincipal !== peerPrincipal) throw new Error('A2A host authorization changed.');
    if (auth.credential !== undefined && (typeof auth.credential !== 'string' || !/^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/.test(auth.credential)))
      throw new Error('Invalid external A2A credential.');
    if (factsV2) {
      if (!frozen && !selected) throw new Error('Legacy association requires the legacy host; no implicit fact migration.');
      const result = await factsV2.resolve({ caseId: uuid(caseId), attemptId: uuid(attemptId), subjectId, frozen, selected, signal });
      const after = await authorize(Object.freeze({ ...scope }));
      if (after?.subjectId !== subjectId || after?.peerPrincipal !== peerPrincipal) throw new Error('A2A host authorization changed during fact read.');
      signal?.throwIfAborted(); return { auth, ...result };
    }
    if (frozen) throw new Error('A2A v2 association requires the v2 fact reader.');
    const current = await cases.get(uuid(caseId), { signal });
    if (current.caseId !== caseId || !Number.isSafeInteger(current.version) || current.version < 2
      || current.state === 'withdrawn' || !current.events?.some(e => e.kind === 'attempt' && e.id === uuid(attemptId)))
      throw new Error('Current owned Galaxy Case/Attempt required.');
    signal?.throwIfAborted();
    return { auth, current };
  }
  async function client(auth, signal) {
    const fetchImpl = async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== endpoint || request.method !== 'POST' || request.headers.get('A2A-Version') !== '1.0')
        throw new Error('A2A transport left the approved interface.');
      const result = await post(endpoint, { bodyJson: await request.text(), credential: auth.credential,
        signal: signal ?? request.signal, timeoutMs: 30000, maxBytes: 1048576 });
      return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })], preferredTransports: ['JSONRPC'] })
      .createFromAgentCard(card);
  }
  function preview(kind, link, text) {
    const operationId = randomUUID();
    const payload = { ...scope, kind, associationId: link.id, caseId: link.caseId, attemptId: link.attemptId,
      revision: link.revision ?? 0, taskId: link.peer?.taskId ?? null, contextId: link.peer?.contextId ?? null,
      messageId: kind === 'cancel' ? null : randomUUID(), ...(text === undefined ? {} : { text }) };
    if (link.factContext) payload.factContext = structuredClone(link.factContext);
    const payloadJson = JSON.stringify(payload);
    const result = Object.freeze({ ...payload, operationId, payloadJson,
      confirmation: `CONFIRM A2A ${operationId} ${hash(payloadJson)}` });
    pending.set(result, { kind, link, text, operationId, state: 'prepared' });
    return result;
  }
  async function prepareStart({ caseId, attemptId, text, ...selected }) {
    selectedText(text);
    const { factContext } = await access(caseId, attemptId, undefined, undefined, factsV2 ? selected : undefined);
    if ((await journal.list()).some(link => link.caseId === caseId && link.attemptId === attemptId))
      throw new Error('A2A Attempt already dispatched; inspect the existing association.');
    return preview('send', { id: randomUUID(), caseId, attemptId, revision: 0, ...(factContext ? { factContext } : {}) }, text);
  }
  async function prepareReply(id, text) {
    selectedText(text);
    const link = await journal.get(uuid(id));
    await access(link.caseId, link.attemptId, undefined, link.factContext);
    if (link.status !== 'observed' || !['input-required', 'auth-required'].includes(link.peer?.state))
      throw new Error('A2A task is not waiting for input/authentication.');
    return preview('reply', link, text);
  }
  async function prepareCancel(id) {
    const link = await journal.get(uuid(id));
    await access(link.caseId, link.attemptId, undefined, link.factContext);
    if (link.status !== 'observed' || !link.peer?.taskId || terminal(link.peer.state))
      throw new Error('Refresh an active A2A task before requesting cancellation.');
    return preview('cancel', link);
  }
  // Aborting local transport never reports that the remote task was canceled.
  function abort(prepared) {
    const op = pending.get(prepared);
    if (!op) throw new Error('Unknown A2A preview.');
    if (op.state === 'prepared') op.state = 'aborted';
    op.controller?.abort();
  }
  async function perform(kind, link, auth, signal, params, operationId, requestHash) {
    const reserved = await journal.change(link.id, link.revision ?? 0, previous => {
      const operations = previous?.operations ?? [];
      if (operations.length >= 128) throw new Error('A2A association operation limit reached.');
      return { ...link, status: 'dispatching', operations: [...operations,
        { id: operationId, kind, requestHash, at: now(), outcome: 'dispatching' }] };
    });
    try {
      signal?.throwIfAborted();
      const sdk = await client(auth, signal);
      const result = kind === 'poll' ? await sdk.getTask(params, { signal })
        : kind === 'cancel' ? await sdk.cancelTask(params, { signal }) : await sdk.sendMessage(params, { signal });
      const peer = snapshot(result, link.peer);
      return await journal.change(link.id, reserved.revision, previous => ({ ...previous, peer, status: 'observed',
        operations: finish(previous.operations, { outcome: 'observed', state: peer.state, responseHash: peer.responseHash }) }));
    } catch (error) {
      const reason = error instanceof A2AError && /^[A-Z_]{1,80}$/.test(error.reason) ? error.reason : null;
      const outcome = reason ? 'peer-error' : 'unknown';
      // A newer poll may already have reconciled this operation. Never replace
      // its observation with a late reply from this request.
      try {
        await journal.change(link.id, reserved.revision, previous => ({ ...previous, status: outcome,
          operations: finish(previous.operations, { outcome, reason }) }));
      } catch { /* Keep the durable reservation or newer observation. */ }
      const failure = new Error(reason ? `A2A peer error: ${reason}.` : 'A2A outcome unknown; inspect association and poll known task before another action.');
      failure.code = reason ?? 'A2A_OUTCOME_UNKNOWN';
      failure.associationId = link.id;
      throw failure;
    }
  }
  async function execute(prepared, confirmation) {
    const op = pending.get(prepared);
    if (!op || op.state !== 'prepared' || confirmation !== prepared.confirmation) throw new Error('Exact A2A confirmation required.');
    op.state = 'executing';
    op.controller = new AbortController();
    try {
      const { auth } = await access(op.link.caseId, op.link.attemptId, op.controller.signal, op.link.factContext);
      const params = op.kind === 'cancel' ? CancelTaskRequest.fromJSON({ tenant, id: op.link.peer.taskId })
        : SendMessageRequest.fromJSON({ tenant,
          message: { messageId: prepared.messageId, role: 'ROLE_USER',
            contextId: op.link.peer?.contextId ?? '', taskId: op.link.peer?.taskId ?? '',
            parts: [{ text: op.text, mediaType: 'text/plain' }] },
          configuration: { acceptedOutputModes: ['text/plain', 'application/json'], historyLength: 0, returnImmediately: true } });
      const result = await perform(op.kind, op.link, auth, op.controller.signal, params, op.operationId, hash(prepared.payloadJson));
      op.state = 'completed';
      return result;
    } finally { if (op.state === 'executing') op.state = 'finished'; }
  }
  async function poll(id, { signal } = {}) {
    const link = await journal.get(uuid(id));
    const { auth } = await access(link.caseId, link.attemptId, signal, link.factContext);
    if (!link.peer?.taskId) throw new Error('No observed peer task ID; automatic recovery/resend is unavailable.');
    const params = GetTaskRequest.fromJSON({ tenant, id: link.peer.taskId, historyLength: 0 });
    return perform('poll', link, auth, signal, params, randomUUID(), hash(JSON.stringify(params)));
  }
  async function prepareResult(id) {
    const link = await journal.get(uuid(id));
    if (link.factContext) throw new Error('Use the explicit v2 Result flow.');
    const { current } = await access(link.caseId, link.attemptId);
    // A draft only. The existing Case flow supplies separate exact-payload
    // consent, signs locally, and submits it to Official after host review.
    if (link.resultImport) return structuredClone(link.resultImport.draft);
    const draft = { associationId: link.id,
      source: { ...scope, taskId: link.peer?.taskId, contextId: link.peer?.contextId, verification: 'peer-reported' },
      event: resultDraft(link, current.version, randomUUID()) };
    await journal.change(link.id, link.revision, previous => ({ ...previous,
      resultImport: { draft, sourceHash: link.peer.responseHash, state: 'prepared' } }));
    return draft;
  }
  async function saveResultConsent(id, intent) {
    const link = await journal.get(uuid(id));
    const saved = link.resultImport;
    if (!saved || intent.objectId !== saved.draft.event.id || intent.payloadHash !== hash(JSON.stringify(saved.draft.event))
      || intent.subjectId !== subjectId || intent.endpoint !== officialEndpoint || intent.action !== 'case.teaser.publish')
      throw new Error('Result Consent does not match the frozen A2A import.');
    if (saved.consentIntent) {
      if (JSON.stringify(saved.consentIntent) !== JSON.stringify(intent)) throw new Error('A2A result Consent already frozen.');
      return;
    }
    await journal.change(link.id, link.revision, previous => ({ ...previous,
      resultImport: { ...previous.resultImport, consentIntent: structuredClone(intent) } }));
  }
  async function recordResult(id, receipt) {
    const link = await journal.get(uuid(id)), event = link.resultImport?.draft.event;
    if (!event || receipt.caseId !== event.caseId || receipt.eventId !== event.id
      || receipt.version !== event.expectedVersion + 1 || receipt.verification !== 'unverified')
      throw new Error('A2A Result receipt mismatch.');
    await journal.change(link.id, link.revision, previous => ({ ...previous,
      resultImport: { ...previous.resultImport, state: 'acknowledged', receipt: structuredClone(receipt) } }));
    return receipt;
  }
  async function prepareResultV2(id, selection) {
    const link = await journal.get(uuid(id));
    if (!link.factContext || !factsV2) throw new Error('Native v2 association required.');
    const { current } = await access(link.caseId, link.attemptId, undefined, link.factContext);
    if (link.resultImportV2) return structuredClone(link.resultImportV2.draft);
    const draft = { associationId: link.id, source: { ...scope, taskId: link.peer?.taskId,
      contextId: link.peer?.contextId, responseHash: link.peer?.responseHash,
      observedAt: link.operations.at(-1).at, verification: 'peer-reported' },
      event: resultDraftV2(link, scope, current, selection, randomUUID()) };
    const payloadJson = JSON.stringify(draft.event);
    await journal.change(link.id, link.revision, previous => ({ ...previous,
      resultImportV2: { draft, payloadJson, payloadHash: hash(payloadJson), sourceHash: link.peer.responseHash, state: 'prepared' } }));
    return draft;
  }
  async function saveResultAuthorizationV2(id, authorization) {
    const link = await journal.get(uuid(id)), saved = link.resultImportV2;
    if (!saved || authorization.payloadJson !== saved.payloadJson || authorization.objectId !== saved.draft.event.eventId
      || authorization.action !== 'case.teaser.publish') throw new Error('v2 authorization differs from the frozen import.');
    if (saved.authorization) {
      if (JSON.stringify(saved.authorization) !== JSON.stringify(authorization)) throw new Error('v2 authorization already frozen.');
      return;
    }
    await journal.change(link.id, link.revision, prior => ({ ...prior,
      resultImportV2: { ...prior.resultImportV2, authorization: structuredClone(authorization) } }));
  }
  async function recordResultV2(id, receipt) {
    const link = await journal.get(uuid(id)), saved = link.resultImportV2, e = saved?.draft.event;
    if (!e || receipt.caseId !== e.caseId || receipt.eventId !== e.eventId || receipt.version !== e.expectedVersion + 1
      || receipt.claimAuthority !== 'participant-reported' || receipt.verification !== 'not-provided'
      || receipt.acceptance !== 'not-provided' || receipt.resolution !== 'separate') throw new Error('v2 Result receipt mismatch.');
    await journal.change(link.id, link.revision, prior => ({ ...prior,
      resultImportV2: { ...prior.resultImportV2, state: 'acknowledged', receipt: structuredClone(receipt) } }));
    return receipt;
  }
  return Object.freeze({ prepareStart, prepareReply, prepareCancel, execute, abort, poll, prepareResult,
    prepareResultV2, saveResultAuthorizationV2, recordResultV2,
    // Local reads contain selected peer text, never external credentials.
    get: async id => journal.get(uuid(id)), list: journal.list, saveResultConsent, recordResult, profile: A2A_PROFILE });
}
function finish(operations, result) {
  return [...operations.slice(0, -1), { ...operations.at(-1), ...result }];
}
