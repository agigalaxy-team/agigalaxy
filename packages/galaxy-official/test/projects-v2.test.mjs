import test from 'node:test';
import { verifyProjectsV2 } from './projects-v2-workflow.mjs';
test('Project v2 preserves imports and distinct roles, accepted transfer and current discovery', {timeout:60000},()=>verifyProjectsV2());
