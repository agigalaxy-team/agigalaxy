import test from 'node:test';
import {verifyCapsuleWebV2} from './capsule-web-v2-workflow.mjs';
test('Capsule webpage client: exact versions, actual failed application and own durable HTTP receipts',{timeout:120000},()=>verifyCapsuleWebV2());
