import test from 'node:test';
import { verifyDeletionMinimization } from './deletion-minimize-workflow.mjs';
test('terminal receipt minimization clears operator text but preserves signed queries and old-snapshot deletion replay',()=>verifyDeletionMinimization());
