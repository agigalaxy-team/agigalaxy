import test from 'node:test';
import { verifyHonorWorkflow } from './honor-workflow.mjs';
test('Honor derives scoped evidence and preserves privacy, provenance, negative history and live status',()=>verifyHonorWorkflow());
