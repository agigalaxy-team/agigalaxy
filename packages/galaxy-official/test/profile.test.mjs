import test from 'node:test';
import { verifyProfileWorkflow } from './profile-workflow.mjs';
test('Profile self declarations stay separate from facts and support signed updates, visibility, revocation and export',()=>verifyProfileWorkflow());
