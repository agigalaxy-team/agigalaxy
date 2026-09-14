import test from 'node:test';
import {verifyTaskCommentsV2} from './task-comments-v2-workflow.mjs';
test('verified comments, shared quota, independent governance and current projections', {timeout:60000}, async()=>verifyTaskCommentsV2());
