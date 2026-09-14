import test from 'node:test';
import { verifySearchIndex } from './search-index-workflow.mjs';
test('public index resumes scans and leases, retries writes, invalidates revocations and hides expired entries',()=>verifySearchIndex());
