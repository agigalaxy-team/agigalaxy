import test from 'node:test';
import {verifyIdentityGroupV2} from './identity-group-v2-workflow.mjs';
test('Identity groups current control, exact source display, recovery and lifecycle',{timeout:120000},()=>verifyIdentityGroupV2());
