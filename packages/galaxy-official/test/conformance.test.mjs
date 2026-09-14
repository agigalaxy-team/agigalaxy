import test from 'node:test';
import { verifyConformanceWorkflow } from './conformance-workflow.mjs';
test('portable conformance reports bind exact source and expire/revoke without hiding failures',()=>verifyConformanceWorkflow());
