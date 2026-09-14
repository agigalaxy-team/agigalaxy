import test from 'node:test';
import { verifyBuilderRecovery } from './builder-recovery-workflow.mjs';
test('owner recovery and independent notices work after declaration revocation without republishing old data',()=>verifyBuilderRecovery());
