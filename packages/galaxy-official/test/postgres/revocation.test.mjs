import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from "../../src/infrastructure/database.mjs";
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { workerReads } from '../../src/infrastructure/worker-reads.mjs';
import { verifyOperationalMetrics } from '../metrics-workflow.mjs';
import { verifyRevocationPropagation } from '../revocation-propagation-workflow.mjs';
import { verifyContextWorkflow } from '../context-workflow.mjs';
import { verifyHonorWorkflow } from '../honor-workflow.mjs';
import { verifyEvidenceRevalidation } from '../evidence-revalidation-workflow.mjs';
import { verifyBuilderProbes } from '../builder-probes-workflow.mjs';

test('current PostgreSQL revocation dependency metrics and HTTP consumer propagation',{timeout:90000},async()=>{
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
  const admin=new pg.Pool(),api=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:10000}),worker=new pg.Pool({max:4,options:'-c role=galaxy_evidence_worker',statement_timeout:10000});
  try{
    await migrate(admin);
    for(const role of ['api','worker'])await admin.query(await readFile(new URL('../../src/infrastructure/'+role+'-role.sql',import.meta.url),'utf8'));
    const consumerObservations=[],options={migrateDatabase:false,repositories:apiReads,workerDatabase:worker,workerDb:worker,workerReads,adminDatabase:admin,onRevocationCheck:value=>consumerObservations.push(value)};
    const existing=await verifyOperationalMetrics(api,options);
    const propagation=await verifyRevocationPropagation(api,options);
    await verifyContextWorkflow(api,options);await verifyHonorWorkflow(api,options);
    await verifyEvidenceRevalidation(api,options);await verifyBuilderProbes(api,options);
    assert.deepEqual(consumerObservations.map(value=>value.surface),['context-client','context-authorized-export','honor-ci-proof','honor-case-ancestor',
      'revalidation-command-worker','builder-declare-worker','builder-node-control-worker']);
    const report={version:1,timestamp:new Date().toISOString(),schema:41,node:process.version,postgres:(await admin.query('SHOW server_version')).rows[0].server_version,
      existing,propagation,consumerObservations,limits:['isolated synthetic subjects and sources','HTTP consumers use actual API and PostgreSQL restricted roles','elapsed observations include request/check overhead; not an atomic global transaction or runtime SLA','no proxy/TLS/real host/browser or external stored copy claim']};
    const directory=new URL('../../../../outputs/revocation/',import.meta.url);await mkdir(directory,{recursive:true});
    const output=new URL('propagation-'+Date.now()+'.json',directory);await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({revocationReport:fileURLToPath(output),measuredSurfaces:propagation.observations.length+consumerObservations.length,passed:true}));
  }finally{await worker.end();await api.end();await admin.end();}
});
