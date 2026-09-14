import test from 'node:test';
import { verifyAuditWorkflow } from './audit-workflow.mjs';
test('audit API/client authorizes own history and independently approved scoped reads and exports', () => verifyAuditWorkflow());
