import test from 'node:test';
import { verifyTaskCommentLifecycleV2 } from './task-comments-lifecycle-v2-workflow.mjs';
test(
  'Comment expiry, owner export/deletion and independent reply/governance retention',
  { timeout: 120000 },
  () => verifyTaskCommentLifecycleV2(),
);
