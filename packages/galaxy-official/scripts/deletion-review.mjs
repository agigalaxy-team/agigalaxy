import { readFile, writeFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { openDatabase } from "../src/infrastructure/database.mjs";
import { assertRuntimeEnvironment } from "../src/infrastructure/runtime-environment.mjs";
import { reviewDeletionRequest } from '../src/operations/deletion-review.mjs';
let db;
try {
  const [input, output] = process.argv.slice(2);
  if (![input, output].every(path => typeof path === 'string' && isAbsolute(path))) throw new Error();
  const info = await stat(input); if (!info.isFile() || info.size > 65536) throw new Error();
  assertRuntimeEnvironment(process.env, 'migration'); db = openDatabase(process.env.DATABASE_URL);
  const result = await reviewDeletionRequest(db, JSON.parse(await readFile(input, 'utf8')));
  await writeFile(output, JSON.stringify(result,null,2)+'\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ event: 'deletion_review_recorded', state: result.state, physicalDeletionPerformed: false }));
} catch { console.error(JSON.stringify({ event: 'deletion_review_failed', help: 'node scripts/deletion-review.mjs <absolute-decision.json> <new-absolute-receipt.json>' })); process.exitCode = 1; }
finally { if (db) await db.end(); }
