import test from 'node:test';
import {verifyChoiceSnapshots} from './choice-snapshots-v2-workflow.mjs';
test('Choice cloud category is owner-private, exact-source-bound and preserves device conflicts without implicit room sync',()=>verifyChoiceSnapshots());
