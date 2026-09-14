import test from 'node:test';
import {verifyContextV2} from './context-v2-workflow.mjs';
test('real HTTP Task/Participation grants isolate materials and preserve exact receipts',{timeout:60000},async()=>verifyContextV2());
