import test from 'node:test';
import { informationWorkflow } from './information-v2-workflow.mjs';
test(
  'Information partial query and explicit watch HTTP/browser/lifecycle',
  { timeout: 120000 },
  () => informationWorkflow(),
);
