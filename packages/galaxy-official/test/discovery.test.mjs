import test from 'node:test';
import { verifyDiscoveryWorkflow } from './discovery-workflow.mjs';
test('project discovery matches functions with sources and respects live visibility and temporary contact wishes', { timeout: 60000 }, () => verifyDiscoveryWorkflow());
