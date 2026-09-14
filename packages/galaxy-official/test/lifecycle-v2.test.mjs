import test from 'node:test';
import { verifyPendingDeletionV2, verifyProductV2Deletion, verifyProductV2Retention } from './lifecycle-v2-workflow.mjs';
test('pending deletion hides public Task and selected exports immediately; owner export and cancellation preserve original grant',()=>verifyPendingDeletionV2());
test('product v2 owner deletion erases all own fact copies while independent authors and control continuity remain',()=>verifyProductV2Deletion());
test('temporary Task content expires before worker cleanup; formal Task facts keep their lifetime',()=>verifyProductV2Retention());
