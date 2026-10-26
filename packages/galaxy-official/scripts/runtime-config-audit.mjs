import { readFile,writeFile,lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { openDatabase } from "../src/infrastructure/database.mjs";
import { assertRuntimeEnvironment } from "../src/infrastructure/runtime-environment.mjs";
import { exportRuntimeConfigPage } from '../src/operations/runtime-config-audit.mjs';
let db;
try{
  const [commandPath,output]=process.argv.slice(2);
  if(![commandPath,output].every(value=>typeof value==='string'&&isAbsolute(value)))throw new Error();
  const info=await lstat(commandPath);if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw new Error();
  const command=JSON.parse(await readFile(commandPath,'utf8'));
  if(Object.keys(command).some(key=>!['endpoint','component','after','limit','operatorRef'].includes(key)))throw new Error();
  assertRuntimeEnvironment(process.env,'migration');db=openDatabase(process.env.DATABASE_URL);
  const page=await exportRuntimeConfigPage(db,command);await writeFile(output,JSON.stringify(page,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({event:'runtime_config_archive_page',count:page.events.length,nextCursor:page.nextCursor,hasMore:page.hasMore,sha256:page.sha256}));
}catch{console.error(JSON.stringify({event:'runtime_config_archive_failed'}));process.exitCode=1;}
finally{if(db)await db.end();}
