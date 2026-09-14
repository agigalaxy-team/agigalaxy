import test from 'node:test';
import { verifyHistoryV2Workflow, verifyHistoryV2Cursor, verifyHistoryV2BoundReferences, verifyHistoryV2AllPages } from './history-v2-workflow.mjs';
test('History v2 HTTP projects real multi-party Task/Case/Verification facts and revocation', () => verifyHistoryV2Workflow(undefined, { testHttp: true }));
test('History v2 pagination ignores hidden writes and rejects stale visible sources; latest Profile never falls back', verifyHistoryV2Cursor);
test('History v2 binds affected Attempt to its accepted version; later private writes cannot retarget it', verifyHistoryV2BoundReferences);
test('History v2 traverses every permitted page beyond the legacy 200 candidate cap', verifyHistoryV2AllPages);
