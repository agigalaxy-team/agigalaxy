import test from 'node:test';
import { verifyPeeringProjectionExpiry, verifyPeeringForeignDisplayDeadline, verifyPeeringLateExpiryWithheld,
  verifyPeeringInnerSignatureDeadline }
  from './hub-peering-expiry-continuity-workflow.mjs';

test('actual signed direct peering respects selected source expiry, revoke and original proof bytes',
  { timeout: 60000 }, () => verifyPeeringProjectionExpiry());
test('actual independently signed peer page and JWT cannot extend known current source display deadlines',
  { timeout: 60000 }, () => verifyPeeringForeignDisplayDeadline());
test('actual outgoing query withholds a source response that expires during final local authorization',
  { timeout: 60000 }, () => verifyPeeringLateExpiryWithheld());
test('actual inner proof JWT narrows local item and page deadlines without changing signed bytes',
  { timeout: 60000 }, () => verifyPeeringInnerSignatureDeadline());
