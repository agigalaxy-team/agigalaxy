import { readFile,lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { openDatabase } from "../src/infrastructure/database.mjs";
import { assertRuntimeEnvironment } from "../src/infrastructure/runtime-environment.mjs";
import { assertSupportedSchema } from '../src/infrastructure/migrations.mjs';
import { deliverIncidentNotices } from '../src/operations/incident-notices.mjs';
let db;
try{
  const [path,...extra]=process.argv.slice(2);
  if(!path||!isAbsolute(path)||extra.length)throw new Error();
  const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>262144)throw new Error();
  const command=JSON.parse(await readFile(path,'utf8'));
  assertRuntimeEnvironment(process.env,'migration');db=openDatabase(process.env.DATABASE_URL);
  assertSupportedSchema((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows);
  const receipt=await deliverIncidentNotices(db,command);
  console.log(JSON.stringify({event:'incident_notices_delivered',...receipt}));
}catch{console.error(JSON.stringify({event:'incident_notices_delivery_failed'}));process.exitCode=1;}
finally{if(db)await db.end();}
