import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import pg from 'pg';
import { createServiceRelease, inspectServiceTransition } from '../src/operations/service-release.mjs';

const [action, ...args] = process.argv.slice(2);
let db;
try {
  let result, receipt;
  if (action === 'capture' && args.length === 4) {
    const [directory, releaseId, configurationVersion, output] = args; receipt = output;
    result = await createServiceRelease({ directory, releaseId, configurationVersion });
  } else if (action === 'compare' && args.length === 5 && process.env.GALAXY_RELEASE_DATABASE_URL) {
    const [fromDirectory, fromDigest, toDirectory, toDigest, output] = args; receipt = output;
    db = new pg.Pool({ connectionString: process.env.GALAXY_RELEASE_DATABASE_URL, max: 1 });
    result = await inspectServiceTransition({ db, fromDirectory, fromDigest, toDirectory, toDigest });
  } else throw new Error('usage');
  if (!isAbsolute(receipt)) throw new Error('absolute receipt required');
  await writeFile(receipt, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ action, receiptWritten: true, deployed: false }));
} catch {
  console.error(JSON.stringify({ event: 'service_release_failed', help: 'See docs/service-release-rollback-v1.md; no raw database configuration is logged.' }));
  process.exitCode = 1;
} finally { if (db) await db.end(); }
