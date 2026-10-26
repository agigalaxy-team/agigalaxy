import { readFile,writeFile,lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { openDatabase } from "../src/infrastructure/database.mjs";
import { assertRuntimeEnvironment } from "../src/infrastructure/runtime-environment.mjs";
import { captureDeletionLedger,replayDeletionLedger } from '../src/operations/deletion-ledger.mjs';
const read=async(path,max)=>{if(!isAbsolute(path))throw new Error();const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>max)throw new Error();return readFile(path,'utf8');};
let db;
try{
  const [mode,inputPath,outputPath]=process.argv.slice(2);
  const input=JSON.parse(await read(inputPath,16384));if(!isAbsolute(outputPath))throw new Error();
  assertRuntimeEnvironment(process.env,'migration');
  if(mode==='capture'){
    if(Object.keys(input).join(',')!=='endpoint')throw new Error();
    db=openDatabase(process.env.DATABASE_URL);const artifact=await captureDeletionLedger(db,input);
    await writeFile(outputPath,artifact.payloadJson,{flag:'wx',mode:0o600});
    console.log(JSON.stringify({event:'deletion_ledger_captured',sha256:artifact.sha256,capturedAt:artifact.capturedAt,bytes:artifact.bytes,requests:artifact.requests}));
  }else if(mode==='replay'){
    const {targetDatabase,ledgerPath,...command}=input;
    if(typeof targetDatabase!=='string'||!/^galaxy_restore_[a-z0-9_]+$/.test(targetDatabase)||targetDatabase.length>63)throw new Error();
    const connection=new URL(process.env.DATABASE_URL);connection.pathname='/'+targetDatabase;
    db=openDatabase(connection.href);
    if((await db.query('SELECT current_database() AS name')).rows[0].name!==targetDatabase)throw new Error();
    const result=await replayDeletionLedger(db,await read(ledgerPath,20*1024*1024),command);
    await writeFile(outputPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({event:'deletion_ledger_replayed',requests:result.requestsReplayed,quarantined:true,publicActivationReady:false}));
  }else throw new Error();
}catch{console.error(JSON.stringify({event:'deletion_ledger_operation_incomplete',help:'node scripts/deletion-ledger.mjs capture|replay <absolute-input.json> <new-absolute-output>; inspect stored operation ID before retry'}));process.exitCode=1;}
finally{if(db)await db.end();}
