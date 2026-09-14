import test from 'node:test';
import { verifyContextLifecycleV2 } from './context-lifecycle-v2-workflow.mjs';
test('M19 expires selected Context text, exports only its author and preserves independent acceptance without deleted text', () =>
  verifyContextLifecycleV2());
