import test from 'node:test';
import { verifyDeletionSpool } from './deletion-spool-workflow.mjs';
test('pending failure audit honors retention then drains without recreating a deleted subject audit',()=>verifyDeletionSpool());
