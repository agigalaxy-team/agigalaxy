import test from 'node:test';
import { verifyHistoryCollaboration } from './history-collaboration-workflow.mjs';
test('history derives requirements and signed participation with independent visibility and revocation',()=>verifyHistoryCollaboration());
