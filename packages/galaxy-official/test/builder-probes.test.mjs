import test from 'node:test';
import { verifyBuilderProbes } from './builder-probes-workflow.mjs';
test('Node-approved probe queue retains exact targets, public observations, expiry, privacy, revocation, retry and lease recovery',()=>verifyBuilderProbes());
