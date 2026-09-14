import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { openDatabase } from '../src/database.mjs';
import { assertRuntimeEnvironment } from '../src/runtime-environment.mjs';
import { deletionPreview } from '../src/operations/deletion-preview.mjs';

let db;
try {
  const [subjectId, destination] = process.argv.slice(2);
  if (!isAbsolute(destination ?? '')) throw new Error('Absolute new receipt path required');
  assertRuntimeEnvironment(process.env, 'migration');
  db = openDatabase(process.env.DATABASE_URL);
  const result = await deletionPreview(db, subjectId);
  await writeFile(destination, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ event: 'deletion_preview_written', physicalDeletionPerformed: false }));
} catch {
  console.error(JSON.stringify({ event: 'deletion_preview_failed', help: 'node scripts/deletion-preview.mjs <GUID> <new-absolute-receipt.json>; isolated runtime database configuration required' }));
  process.exitCode = 1;
} finally { if (db) await db.end(); }
