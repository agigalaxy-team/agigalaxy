import test from 'node:test';
import {verifyQualificationPermissionWebV2} from './qualification-permission-web-v2-workflow.mjs';
test('bounded permission request web workflow, exact source authors, legacy picker and retained receipts',{timeout:120000},()=>verifyQualificationPermissionWebV2());
