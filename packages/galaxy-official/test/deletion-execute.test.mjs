import test from 'node:test';
import { verifyDeletionExecution, verifySharedDeletionRace } from './deletion-execute-workflow.mjs';
test('approved deletion erases owner rows, honors audit retention, resumes and preserves signed status access',()=>verifyDeletionExecution());
test('foreign authors remain intact and an in-flight worker cannot resurrect deleted records',()=>verifySharedDeletionRace());
