import test from 'node:test';
import {verifySearchV2} from './search-v2-workflow.mjs';
test('Search v2 actual HTTP/MCP sources preserve failures, private grants, visible pagination and proactive opportunities',()=>verifySearchV2());
