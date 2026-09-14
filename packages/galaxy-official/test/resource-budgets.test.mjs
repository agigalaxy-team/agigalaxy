import test from 'node:test';
import { verifyResourceBudgets } from './resource-budget-workflow.mjs';
test('transactional payload/export/queue budgets reject growth without breaking withdrawal or worker completion',()=>verifyResourceBudgets());
