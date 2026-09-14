import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyContextWorkflow } from './context-workflow.mjs';
import { contextGrantSchema } from '../src/shared/context-schema.mjs';
test('Context API/client workflow requires participant acceptance and stops on scope, consent, expiry or cancellation', async () => verifyContextWorkflow());
test('Context grants accept only selected text and reject known credential material', () => {
  const payload = { id: randomUUID(), assistanceId: randomUUID(), caseId: randomUUID(), participantId: 'GUID' + 'A'.repeat(28),
    scope: 'Selected excerpt', scopeEventId: randomUUID(), expiresAt: 2000000100,
    materials: [{ id: randomUUID(), label: 'Excerpt', mediaType: 'text/plain', content: 'A useful diagnostic line.' }] };
  assert.ok(contextGrantSchema.safeParse(payload).success);
  assert.equal(contextGrantSchema.safeParse({ ...payload, rawContext: 'not accepted' }).success, false);
  assert.equal(contextGrantSchema.safeParse({ ...payload, materials: [{ ...payload.materials[0], content: '-----BEGIN PRIVATE KEY-----' }] }).success, false);
});
