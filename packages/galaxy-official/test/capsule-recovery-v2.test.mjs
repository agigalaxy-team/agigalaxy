import test from 'node:test';
import {verifyCapsuleRecoveryV2} from './capsule-recovery-v2-workflow.mjs';
test('v2 Capsule maintenance, blank repair and exact owner withdrawal across HTTP',()=>verifyCapsuleRecoveryV2());
