import { randomUUID } from 'node:crypto';
import { buildersContinuityFixture } from './builders-client-continuity-workflow.mjs';
import { builderDeclaration } from './builders-workflow.mjs';
import { sampleCharter } from './hubs-workflow.mjs';
import { createHubsWebClient } from '../../galaxy-web/src/hubs-client.mjs';

// Actual Browser binding/JWS/Consent/HTTP/PGlite. Synthetic identity and Map
// storage remain explicit; no independent operator or third-party network.
export async function hubsContinuityFixture() {
  const f = await buildersContinuityFixture(), hubId = randomUUID();
  const declaration = { id: randomUUID(), builderId: hubId, kind: 'declare', expectedRevision: 0,
    declaration: { ...builderDeclaration('hub', f.f.actor.subjectId), endpoint: f.api.endpoint } };
  const authorization = await f.api.authorizePayload(JSON.stringify(declaration), {
    action: 'builder.publish', objectId: declaration.id, visibility: 'Private', confirmed: true });
  await f.api.call('/v1/builders/events', authorization);
  const registered = await f.api.call('/v1/builders/manage/read', { builderId: hubId });
  const event = { schemaVersion: 2, id: randomUUID(), hubId, kind: 'charter', expectedVersion: 0,
    declarationId: registered.declarationId, declarationHash: registered.declarationHash,
    charter: sampleCharter(f.f.now) };
  const state = { loseAck: false, reconnectAfterCall: null, receiptState: null, failBeforeCommit: false };
  const hubCalls = [], consumer = f.runtime.api;
  f.runtime.api = { ...consumer, call: async (path, input, options) => {
    hubCalls.push({ path, input: structuredClone(input) });
    if (path.endsWith('/events') && state.failBeforeCommit) {
      state.failBeforeCommit = false; throw Error('Synthetic Hub request failed before commit');
    }
    const value = await consumer.call(path, input, options);
    if (state.reconnectAfterCall === path) { state.reconnectAfterCall = null; await f.connect(); }
    if (path.endsWith('/events') && state.loseAck) {
      state.loseAck = false; throw Error('Synthetic Hub ACK lost after actual commit');
    }
    if (path.endsWith('/receipt') && state.receiptState) return { ...value, state: state.receiptState };
    return value;
  } };
  const client = createHubsWebClient(f.runtime, { subjectId: f.f.actor.subjectId, now: () => f.f.now });
  const approval = async () => {
    const { party } = await client.peering('party', { hubId });
    const remote = { ...party, endpoint: 'https://peer.example.org', hubId: randomUUID() };
    return { schemaVersion: 2, id: randomUUID(), hubId, kind: 'peer-approve', expectedVersion: 0,
      agreement: { profile: 'galaxy-direct-proof/1', id: randomUUID(), version: 1,
        parties: [party, remote].sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
        sourceKinds: ['contribution-summary'], purpose: 'help-discovery', ratePerMinute: 10,
        pageSize: 5, expiresAt: f.f.now + 500, responseMaxAgeSeconds: 120,
        cache: 'no-response-body-retention', route: 'direct', officialProtocolFee: 0,
        localEvaluationAuthority: 'no-automatic-capability-upgrade', rawTaskContext: 'excluded',
        intake: 'each-party-hub-private-intake' } };
  };
  return { ...f, event, client, hubState: state, hubCalls, approval,
    hubBusinessCalls: () => hubCalls.filter(c => c.path.endsWith('/events')).length };
}
