import test from 'node:test';
import { verifyBuilderNodeControl } from './builder-node-control-workflow.mjs';
test('Node key holder approves an exact owner declaration; expiry, both-party revocation, changes and binding revocation invalidate it',()=>verifyBuilderNodeControl());
