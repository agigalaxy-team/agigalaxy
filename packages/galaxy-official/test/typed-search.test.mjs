import test from 'node:test';
import { verifyTypedSearch } from './typed-search-workflow.mjs';
test('typed search preserves source identity, per-source visibility, final pages and revocation through HTTP and portable client',()=>verifyTypedSearch());
