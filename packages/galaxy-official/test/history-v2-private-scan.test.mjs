import test from 'node:test';
import { verifyHistoryPrivateCandidateScan, verifyHistoryCandidateEntrances,
  verifyHistoryCandidateDeletionAndExpiry, verifyHistoryCandidateIsNotAuthority } from './history-v2-private-scan-workflow.mjs';

test('History private growth avoids invisible body projection without changing public cursor or complete owner history',
  () => verifyHistoryPrivateCandidateScan());
test('History candidate gate preserves private viewers and independently visible event/report/Task entries',
  () => verifyHistoryCandidateEntrances());
test('History candidate gate mirrors deletion cancellation and grant expiry while owner remains canonical',
  () => verifyHistoryCandidateDeletionAndExpiry());
test('History permission expiring after candidate screening is still withheld by the canonical projection',
  () => verifyHistoryCandidateIsNotAuthority());
