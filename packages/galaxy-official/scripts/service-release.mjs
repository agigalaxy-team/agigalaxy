import { readFile,writeFile,lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import pg from 'pg';
import { createServiceRelease, inspectServiceRelease,inspectServiceTransition } from '../src/operations/service-release.mjs';
import {runServiceReleaseAttempt} from '../src/operations/service-release-attempt.mjs';
import {createServiceReleaseHost} from '../deploy/service-release-host.mjs';

const [action, ...args] = process.argv.slice(2);
let db;
async function requireNewReceipt(output){
  if(!isAbsolute(output))throw Error('Absolute receipt required.');
  try{await lstat(output);}catch(error){if(error.code==='ENOENT')return;throw error;}
  throw Error('Preserve original receipt; select a new result file.');
}
try {
  let result, receipt;
  if (action === 'capture' && args.length === 4) {
    const [directory, releaseId, configurationVersion, output] = args; receipt = output;
    await requireNewReceipt(receipt);
    result = await createServiceRelease({ directory, releaseId, configurationVersion });
  } else if (action === 'compare' && args.length === 5 && process.env.GALAXY_RELEASE_DATABASE_URL) {
    const [fromDirectory, fromDigest, toDirectory, toDigest, output] = args; receipt = output;
    await requireNewReceipt(receipt);
    db = new pg.Pool({ connectionString: process.env.GALAXY_RELEASE_DATABASE_URL, max: 1 });
    result = await inspectServiceTransition({ db, fromDirectory, fromDigest, toDirectory, toDigest });
  } else if(action==='attempt'&&args.length===7&&process.env.GALAXY_RELEASE_DATABASE_URL){
    const [fromDirectory,fromDigest,toDirectory,toDigest,configurationFile,operationId,output]=args;receipt=output;
    await requireNewReceipt(receipt);
    if(!isAbsolute(configurationFile))throw Error('Absolute protected host configuration required.');
    const from=await inspectServiceRelease(fromDirectory,fromDigest),to=await inspectServiceRelease(toDirectory,toDigest);
    const configuration=JSON.parse(await readFile(configurationFile,'utf8'));
    const adapter=await createServiceReleaseHost({configuration,operationId,from,to});
    db=new pg.Pool({connectionString:process.env.GALAXY_RELEASE_DATABASE_URL,max:2});
    result=await runServiceReleaseAttempt({operationId,from,to,db,...adapter});
  } else throw new Error('usage');
  if (!isAbsolute(receipt)) throw new Error('absolute receipt required');
  await writeFile(receipt, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ action, receiptWritten: true, deployed: action==='attempt'&&result.state==='activated',state:result.state??null }));
} catch(error) {
  console.error(JSON.stringify({ event: 'service_release_failed',...(error.code==='release_resource_missing'?{code:error.code,resource:error.resource}:{}), help: 'See docs/operations/deployment.md; no raw database configuration is logged.' }));
  process.exitCode = 1;
} finally { if (db) await db.end(); }
