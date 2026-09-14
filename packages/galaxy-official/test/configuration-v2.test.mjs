import test from 'node:test';
import {verifyConfigurationV2} from './configuration-v2-workflow.mjs';
test('Configuration versions, explicit content permissions and optional Case comparison survive deletion',{timeout:120000},()=>verifyConfigurationV2());
