import test from 'node:test';
import { verifyDiscoveryV2 } from './discovery-v2-workflow.mjs';

test('active discovery uses ephemeral context, current source/willingness, real history and resumable windows', { timeout: 60000 }, () => verifyDiscoveryV2());
