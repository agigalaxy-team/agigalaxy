import test from 'node:test';
import {
  verifyPrivacyPageHashRebind, verifyPrivacyFinalHashRebind, verifyPrivacyQueueAndLocalRead, verifyPrivacyPreviewAndSigner,
  verifyPrivacyPendingWriteAndUnknown, verifyPrivacyLateOwnerSave, verifyPrivacyCommittedLostAckAndHolderABA, verifyPrivacyExpiryPartial,
} from './privacy-consumer-continuity-workflow.mjs';

test('privacy page hash completion withholds old private body after actual rebind', { timeout: 60000 }, verifyPrivacyPageHashRebind);
test('privacy final content hash rebind cannot return an old complete or partial download', { timeout: 60000 }, verifyPrivacyFinalHashRebind);
test('privacy local read and queued operations keep their original connection lease', { timeout: 60000 }, verifyPrivacyQueueAndLocalRead);
test('privacy preview and real device-material signer await cannot adopt a reconnected identity', { timeout: 60000 }, verifyPrivacyPreviewAndSigner);
test('privacy original pending save survives lease change without business dispatch or automatic absent retry', { timeout: 60000 }, verifyPrivacyPendingWriteAndUnknown);
test('privacy accepted receipt persists for original owner when real signed recovery changes owner during save', { timeout: 60000 }, verifyPrivacyLateOwnerSave);
test('privacy commit then lost ACK recovers original operation and unconnected holder status fences null ABA', { timeout: 60000 }, verifyPrivacyCommittedLostAckAndHolderABA);
test('privacy expired ticket stops further pages and preserves legitimate current-owner partial download', { timeout: 60000 }, verifyPrivacyExpiryPartial);
