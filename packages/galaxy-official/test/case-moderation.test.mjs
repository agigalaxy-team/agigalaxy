import test from 'node:test';
import { verifyCaseModerationWorkflow } from './case-moderation-workflow.mjs';
test('Case reports support independent decisions, appeals, source versions, linked holds and private exports', () => verifyCaseModerationWorkflow());
