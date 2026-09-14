import test from 'node:test';
import {verifyHonorV2Workflow} from './honor-v2-workflow.mjs';
test('multi-actor accepted diagnosis and failed verification retain separate contributions; projections and requester feedback obey selected fields',()=>verifyHonorV2Workflow());
