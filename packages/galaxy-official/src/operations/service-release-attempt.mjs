// The host adapter owns protected snapshots and process control. This module
// stores only references and migration facts, never environment file contents.
const versions=manifest=>manifest.migrations.map(row=>row.version);
const equal=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
function compatibleHistory(from,to){
 if(from.migrations.some((row,index)=>to.migrations[index]?.version!==row.version||to.migrations[index]?.sha256!==row.sha256))
  throw Error('Historical migration changed; release refused.');
}
async function readVersions(client){return(await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row=>row.version);}

// Must be called only after migration is known to have stopped. An unreachable
// observer or a still-running migration cannot authorize old application code.
export async function reconcileServiceReleaseAttempt({record,client,host,journal}){
 if(['activated','old-runtime-restored','requires-compatible-fix'].includes(record.state))return record;
 let actual;
 try{
  if(!['inactive','failed'].includes(await host.migrationState()))throw Error('Migration outcome pending.');
  actual=await readVersions(client);
 }catch{
  const next={...record,state:'result-unknown',nextAction:'query-original-attempt',runtimeOpened:false};
  await journal.write(next);return next;
 }
 const before=versions(record.from),target=versions(record.to);
 if(equal(actual,before)){
  // This is the only branch permitted to restore the previous configuration.
  // Config restoration, all old process starts, and readiness are one outcome.
  await host.stopAll();
  try{await host.restore(record.snapshotReference);await host.startPrevious();await host.verifyPrevious();
   const next={...record,state:'old-runtime-restored',actualVersions:actual,runtimeOpened:true,databaseDowngrade:false};await journal.write(next);return next;
  }catch{await host.stopAll();const next={...record,state:'result-unknown',actualVersions:actual,nextAction:'query-original-attempt',runtimeOpened:false};await journal.write(next);return next;}
 }
 await host.stopAll();
 const next={...record,state:'requires-compatible-fix',actualVersions:actual,runtimeOpened:false,databaseDowngrade:false,
  schemaAdvanced:equal(actual,target),nextAction:'prepare-compatible-fix-or-separately-approved-database-restore'};
 await journal.write(next);return next;
}

export async function runServiceReleaseAttempt({operationId,from,to,db,host,journal,migrate}){
 if(!/^[0-9a-f-]{36}$/i.test(operationId)||typeof migrate!=='function')throw Error('Explicit release attempt required.');
 compatibleHistory(from,to);
 const client=await db.connect();let locked=false;
 try{
  locked=(await client.query('SELECT pg_try_advisory_lock(743912306) AS locked')).rows[0].locked;
  if(!locked)throw Error('Another release attempt is in progress.');
  const original=await journal.read(operationId);
  if(original){
   if(original.from.releaseId!==from.releaseId||original.to.releaseId!==to.releaseId||!equal(original.from.migrations,from.migrations)||!equal(original.to.migrations,to.migrations))
    throw Error('Original release attempt changed.');
   return reconcileServiceReleaseAttempt({record:original,client,host,journal});
  }
  const actual=await readVersions(client);
  if(!equal(actual,versions(from)))throw Error('Current schema does not match the selected previous release.');
  const snapshotReference=await host.snapshot();
  let record={operationId,from,to,snapshotReference,state:'prepared',phase:'before-stop',actualVersions:actual,runtimeOpened:false};
  await journal.write(record);
  try{
   await host.stopAll();await host.applyTarget();
   record={...record,state:'running',phase:'migration-started'};await journal.write(record);
   await migrate();
   // Even a successful migration process exit must agree with its full list.
   if(!equal(await readVersions(client),versions(to)))throw Error('Migration version facts differ from the target.');
   record={...record,phase:'migration-committed'};await journal.write(record);
   await host.startTarget();await host.verifyTarget();
   record={...record,state:'activated',phase:'ready',actualVersions:versions(to),runtimeOpened:true,databaseDowngrade:false};
   await journal.write(record);return record;
  }catch{
   // Preserve the first failed phase. Status retrieval uses this same ID and
   // never starts another migration or synthesizes a replacement operation.
   record={...record,state:'result-unknown',failedPhase:record.phase};await journal.write(record);
   await host.stopAll();return reconcileServiceReleaseAttempt({record,client,host,journal});
  }
 }finally{try{if(locked)await client.query('SELECT pg_advisory_unlock(743912306)');}finally{client.release();}}
}
