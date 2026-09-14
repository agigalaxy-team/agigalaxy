import test from 'node:test';
import { verifyHistorySearch } from './history-search-workflow.mjs';
test('fixed relevance queries combine visible capabilities and current CI strength before pagination',()=>verifyHistorySearch());
