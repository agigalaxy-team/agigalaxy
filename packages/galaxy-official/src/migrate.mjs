import { openDatabase, migrate, validateMigrationRoles } from "./infrastructure/database.mjs";
import { createRuntimeLogger,consoleRuntimeLogger,runtimeLogConfiguration } from './operations/runtime-log.mjs';
import { assertRuntimeEnvironment } from "./infrastructure/runtime-environment.mjs";
import { runtimeServiceRelease } from './operations/service-release.mjs';
import { fileURLToPath } from 'node:url';

let db;
let runtimeLog=consoleRuntimeLogger('migration',{destination:process.stderr});
try {
  assertRuntimeEnvironment(process.env, 'migration');
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && !args[0].startsWith('--roles=')) throw new Error('Unknown migration arguments');
  const roles = validateMigrationRoles(args.length ? args[0].slice('--roles='.length).split(',') : []);
  const configuredLog=await createRuntimeLogger({component:'migration',...runtimeLogConfiguration(process.env)});
  await runtimeLog.close();runtimeLog=configuredLog;
  await runtimeServiceRelease(process.env, 'migration', fileURLToPath(import.meta.url));
  db = openDatabase(process.env.DATABASE_URL);
  const version = await migrate(db, { roles });
  runtimeLog.write({ event: 'migration_complete', version, count: roles.length });
} catch {
  runtimeLog.error({ event: 'migration_failed' });
  process.exitCode = 1;
} finally {
  try{if (db) await db.end();}catch{runtimeLog.error({event:'migration_failed'});process.exitCode=1;}
  try{await runtimeLog.close();}catch{process.exitCode=1;}
}
