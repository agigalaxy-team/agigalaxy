import test from 'node:test';
import {verifyTargetGovernanceV2} from './target-governance-v2-workflow.mjs';
test('Task and ordinary Room private governance preserve independent scoped restrictions and appeal',{timeout:120000},()=>verifyTargetGovernanceV2());
