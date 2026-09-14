import test from 'node:test';
import { verifyNodeControlProofWorkflow } from './node-control-proof-workflow.mjs';
test('portable Node authorization binds actual Node signature and live registry snapshot without granting execution',()=>verifyNodeControlProofWorkflow());
