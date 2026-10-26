import { readFile,writeFile,lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { openDatabase } from "../src/infrastructure/database.mjs";
import { assertRuntimeEnvironment } from "../src/infrastructure/runtime-environment.mjs";
import { minimizeDeletionReceipt } from '../src/operations/deletion-minimize.mjs';
let db;
try{
  const [input,output]=process.argv.slice(2);if(![input,output].every(value=>typeof value==='string'&&isAbsolute(value)))throw new Error();
  const info=await lstat(input);if(!info.isFile()||info.isSymbolicLink()||info.size>16384)throw new Error();
  assertRuntimeEnvironment(process.env,'migration');db=openDatabase(process.env.DATABASE_URL);
  const result=await minimizeDeletionReceipt(db,JSON.parse(await readFile(input,'utf8')));
  await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({event:'deletion_receipt_minimized',events:result.minimization.eventsMinimized,serviceWideDeletionComplete:false}));
}catch{console.error(JSON.stringify({event:'deletion_minimization_incomplete',help:'node scripts/deletion-minimize.mjs <absolute-command.json> <new-absolute-receipt>; inspect stored operation ID before retry'}));process.exitCode=1;}
finally{if(db)await db.end();}
