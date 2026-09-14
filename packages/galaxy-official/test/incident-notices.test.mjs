import test from 'node:test';
import { verifyIncidentNotices } from './incident-notices-workflow.mjs';
test('targeted incident inbox supports private pagination, read receipts, preferences, export and deletion inventory during containment',()=>verifyIncidentNotices());
