import assert from 'node:assert/strict';
import { browserScopes } from '../../galaxy-official/src/browser-client.mjs';
import { identityKeyId, signIdentityPayload } from '../../galaxy-core/src/domain/identity-material.mjs';

export const taskContactWebsite = 'https://galaxy.example.org';

// This isolated local signer models the existing-device Agent handoff bridge.
// The registered device and control history come from the real signed HTTP
// fixture; product retainHandoff/requireCurrent verify every proof and scope.
// No model, external bridge, or verified-state flag is involved.
export async function retainTaskContactAgent(runtime, store, now) {
  const { identity, endpoint } = await runtime.status();
  assert.ok(identity);
  const material = await store.get(`device:${identity.subjectId}:${identity.deviceId}`);
  assert.ok(material?.privateKey);
  assert.equal(material.deviceId, identity.deviceId);
  const control = await runtime.api.call(`/v2/identity/${identity.subjectId}/control`, undefined, {
    method: 'GET', authenticated: false,
  });
  const keyId = await identityKeyId(material.publicKeyPem);
  const current = control.devices.find(row => row.device_id === identity.deviceId
    && row.key_id === keyId && row.epoch === control.epoch && row.status === 'active');
  assert.ok(current);
  assert.ok(current.scopes.includes('manage-identity'));
  assert.ok(browserScopes.every(scope => current.scopes.includes(scope)));
  const handoffId = crypto.randomUUID(), navigationId = crypto.randomUUID();
  const nonce = crypto.randomUUID(), bridgeOrigin = 'http://127.0.0.1:39847';
  const context = {
    endpoint, website: taskContactWebsite, subjectId: identity.subjectId,
    controller: { deviceId: identity.deviceId, keyId, epoch: control.epoch, chainHead: control.chainHead },
    scopes: [...browserScopes], expiresAt: now + 120, targetPath: '/app/publish',
    existingDevice: { subjectId: identity.subjectId, deviceId: identity.deviceId, keyId },
  };
  const payloadJson = JSON.stringify({ protocol: 'galaxy-web-identity-handoff', version: 1,
    handoffId, navigationId, nonce, bridgeOrigin, context });
  const signature = await signIdentityPayload(payloadJson, material.privateKey, {
    type: 'galaxy-web-identity-handoff-v1+jws',
  });
  await runtime.agentContinuity.retainHandoff({ handoffId, navigationId,
    context: { ...context, nonce, bridgeOrigin, proof: { payloadJson, signature } },
    offer: null, approval: null,
  });
  const verified = await runtime.agentContinuity.requireCurrent();
  assert.equal(verified.subjectId, identity.subjectId);
  assert.equal(verified.deviceId, identity.deviceId);
  assert.equal(verified.operationId, null);
}
