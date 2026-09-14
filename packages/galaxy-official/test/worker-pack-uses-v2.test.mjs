import test from 'node:test';
import {verifyWorkerPackUsesV2} from './worker-pack-uses-v2-workflow.mjs';
test('Pack exact-version use, independent authors, recovery and lifecycle',{timeout:120000},()=>verifyWorkerPackUsesV2());
