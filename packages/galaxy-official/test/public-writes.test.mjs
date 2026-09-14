import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { verifyPublicWrites } from './public-writes-workflow.mjs';

test('persistent Account quotas preserve multi-GUID, retry, rollback and invitation semantics', {timeout:60000}, async () => {
  const db = new PGlite();
  try { await verifyPublicWrites(db); } finally { await db.close(); }
});

