import test from 'node:test';
import { verifyHistoryWorkflow } from './history-workflow.mjs';
test('history rebuilds from events, searches visible cases and immediately removes withdrawn grants',()=>verifyHistoryWorkflow());
