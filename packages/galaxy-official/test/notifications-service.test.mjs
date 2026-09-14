import test from 'node:test';
import { verifyNotificationsWorkflow } from './notifications-workflow.mjs';
test('inbox, preferences, invitation limits and requester provenance use current visible events', async () => verifyNotificationsWorkflow());
