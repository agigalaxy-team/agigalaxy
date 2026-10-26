import { defaultResourceBudgetPolicy } from '../../src/infrastructure/resource-budgets.mjs';
import { digest } from '../../src/shared/digest.mjs';
import { defaultRequestQuotaPolicy } from '../../src/adapters/http/request-quotas.mjs';
import { reviewedGovernanceFixture } from '../governance-review-workflow.mjs';
import { governanceConfigurationHash,prepareGovernanceBundle } from '../../src/operations/governance-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { serviceFixture } from '../service-fixture.mjs';
import { migrate } from "../../src/infrastructure/database.mjs";
import { migrations } from '../../src/infrastructure/migrations.mjs';
import { issueKeyring } from "../../src/security/trust-keyring.mjs";

const pause = () => new Promise(resolve => setTimeout(resolve, 30));
test('isolated PostgreSQL: actual API and Worker stop/restart preserve in-flight queue state', { timeout: 45000 }, async () => {
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED, '1');
  const admin = new pg.Pool();
  let db;
  const temporary = await mkdtemp(join(tmpdir(), 'galaxy-service-lifecycle-'));
  const children = [];
  try {
    await admin.query('CREATE DATABASE galaxy_integration');
    db = new pg.Pool({ database: 'galaxy_integration' });
    await migrate(db);
    for (const role of ['api', 'worker']) await db.query(await readFile(new URL(`../../src/infrastructure/${role}-role.sql`, import.meta.url), 'utf8'));
    const directory = join(temporary, 'integration'); await mkdir(directory);
    const trust = join(directory, 'trust'); await mkdir(trust);
    const root = generateKeyPairSync('ed25519'), key = generateKeyPairSync('ed25519');
    const now = Math.floor(Date.now() / 1000), endpoint = 'https://official.example.org';
    const publicKey = (pair, kid) => ({ kid, publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      notBefore: now - 60, notAfter: now + 200000, revoked: false });
    const paths = { key: join(directory, 'key.pem'), pins: join(directory, 'pins.json'), ring: join(directory, 'ring.json') };
    await writeFile(paths.key, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await writeFile(paths.pins, JSON.stringify({ version: 1, endpoint, sequence: 1, keys: [publicKey(root, 'root')] }));
    await writeFile(paths.ring, JSON.stringify(await issueKeyring({ endpoint, keys: [publicKey(key, 'service')], sequence: 1,
      rootKid: 'root', rootPrivateKey: root.privateKey, now })));
    const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const metricsPort=async()=>{
      const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
      const selected=listener.address().port;await new Promise(resolve=>listener.close(resolve));return selected;
    };
    const apiMetricsPort=await metricsPort(),workerMetricsPort=await metricsPort();
    const url = new URL(`postgresql://${process.env.PGHOST}:${process.env.PGPORT}/galaxy_integration`);
    url.username = process.env.PGUSER; url.password = process.env.PGPASSWORD;
    const common = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GALAXY_') && name !== 'DATABASE_URL'));
    Object.assign(common, { GALAXY_ENVIRONMENT: 'integration', GALAXY_ENDPOINT: endpoint, DATABASE_URL: url.href });
    const runtimeLogDirectory=join(directory,'runtime-logs');common.GALAXY_RUNTIME_LOG_DIRECTORY=runtimeLogDirectory;
    const resourcePath=join(directory,'resource-budgets.json');
    await writeFile(resourcePath,JSON.stringify(defaultResourceBudgetPolicy));
    common.GALAXY_RESOURCE_BUDGET_FILE=resourcePath;
    const launch = (entry, env, expectStartupExit = false) => {
      if(entry==='worker')env={...env,GALAXY_METRICS_PORT:String(workerMetricsPort)};
      const args = process.platform === 'win32' && !expectStartupExit ? ['--import', new URL('./stop-channel.mjs', import.meta.url).href] : [];
      const child = spawn(process.execPath, [...args, fileURLToPath(new URL(`../../src/${entry}.mjs`, import.meta.url))],
        { env, windowsHide: true, stdio: expectStartupExit ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'ipc'] });
      child.stdout.resume();
      child.startupPhase = 'unknown';
      child.stderr.on('data', bytes => {
        for (const line of bytes.toString().split('\n')) {
          try { const entry = JSON.parse(line); if (/^[a-z-]{1,32}$/.test(entry.phase)) child.startupPhase = entry.phase; } catch { /* Never print raw child output. */ }
        }
      });
      child.result = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
      children.push(child); return child;
    };
    const apiEnvironment = { ...common, PGOPTIONS: '-c role=galaxy_api', PORT: String(port), GALAXY_OPERATOR: 'Synthetic test',
      GALAXY_METRICS_PORT:String(apiMetricsPort),GALAXY_METRICS_STORAGE_DIRECTORY:directory,
      GALAXY_REGION: 'synthetic', GALAXY_ENVIRONMENT_DIRECTORY: directory, GALAXY_SIGNING_KEY_FILE: paths.key,
      GALAXY_SIGNING_KEY_ID: 'service', GALAXY_ROOT_PINS_FILE: paths.pins, GALAXY_KEYRING_FILE: paths.ring, GALAXY_TRUST_DIRECTORY: trust };
    const quotaPath=join(directory,'request-quotas.json'),quotaPolicy=structuredClone(defaultRequestQuotaPolicy);quotaPolicy.categories.export.ip=1;
    await writeFile(quotaPath,JSON.stringify(quotaPolicy));apiEnvironment.GALAXY_REQUEST_QUOTA_FILE=quotaPath;
    const api = launch('server', apiEnvironment);
    let ready = false;
    for (let i = 0; i < 150 && api.exitCode === null; i++) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) })).status === 200; } catch { /* startup */ }
      if (ready) break; await pause();
    }
    assert.equal(ready, true, 'actual API must become ready; failure phase=' + api.startupPhase);
    const honorPost=async path=>{
      const response=await fetch(`http://127.0.0.1:${port}/v1/honor/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      assert.equal(response.status,200);return response.json();
    };
    assert.equal((await honorPost('rules')).ruleHistorySupported,true);
    assert.deepEqual((await honorPost('rule-history')).items,[]);
    const quotaProbe=()=>fetch(`http://127.0.0.1:${port}/v1/data-exports/not-real`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    const unknown=await quotaProbe();assert.equal(unknown.status,404);await unknown.arrayBuffer();
    const limited=await quotaProbe();assert.equal(limited.status,429);assert.equal(limited.headers.get('x-galaxy-quota-category'),'export');await limited.arrayBuffer();
    assert.match((await db.query("SELECT payload FROM runtime_config_events WHERE component='api' ORDER BY sequence DESC LIMIT 1")).rows[0].payload.snapshot.requestQuotaHash,/^[a-f0-9]{64}$/);
    console.log(JSON.stringify({event:'configured_request_quotas_runtime_verified',policyLoaded:true,categoryEnforced:true,configurationHashRecorded:true}));
    const failedRequest = await fetch(`http://127.0.0.1:${port}/v1/cases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(failedRequest.status, 401); await failedRequest.arrayBuffer();
    let failureRecord = [];
    for (let i = 0; i < 100; i++) {
      failureRecord = (await db.query("SELECT action,outcome FROM audit_events WHERE http_request_id=$1", [failedRequest.headers.get('x-request-id')])).rows;
      if (failureRecord.length) break; await pause();
    }
    assert.deepEqual(failureRecord, [{ action: 'http.rejected', outcome: '401' }]);
    const worker = launch('worker', { ...common, PGOPTIONS: '-c role=galaxy_evidence_worker' });
    let connections = 0;
    for (let i = 0; i < 150 && worker.exitCode === null; i++) {
      connections = Number((await db.query("SELECT count(*) FROM pg_stat_activity WHERE datname='galaxy_integration' AND application_name='galaxy-official'")).rows[0].count);
      if (connections >= 2) break; await pause();
    }
    assert.ok(connections >= 2, 'API and Worker hold actual database connections');
    const apiMetrics=await (await fetch('http://127.0.0.1:'+apiMetricsPort+'/metrics')).text();
    assert.match(apiMetrics,/galaxy_database_collection_success\{component="api"\} 1/);
    assert.match(apiMetrics,/galaxy_http_requests_total/);
    assert.match(apiMetrics,/galaxy_runtime_log_ready\{component="api"\} 1/);
    let workerMetrics='';
    for(let i=0;i<150;i++){
      try{workerMetrics=await (await fetch('http://127.0.0.1:'+workerMetricsPort+'/metrics',{signal:AbortSignal.timeout(500)})).text();}catch{}
      if(/galaxy_worker_iterations_total\{/.test(workerMetrics))break;await pause();
    }
    assert.match(workerMetrics,/galaxy_worker_iterations_total\{/);
    assert.match(workerMetrics,/galaxy_process_cpu_user_seconds_total/);
    console.log(JSON.stringify({event:'actual_operational_metrics_verified',api:true,worker:true,database:true,processMetrics:true}));
    for (const child of children) {
      if (process.platform === 'win32') child.send('stop-fixture');
      else { child.disconnect(); child.kill('SIGTERM'); }
    }
    const exits = await Promise.all(children.map(child => child.result));
    assert.ok(exits.every(result => result.code === 0 && result.signal === null));
    const apiLogPath=join(runtimeLogDirectory,'api-primary','runtime.jsonl');
    const apiLog=(await readFile(apiLogPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(apiLog.some(row=>row.event==='http_rejected'&&row.status===401&&row.requestId===failedRequest.headers.get('x-request-id')));
    assert.ok(apiLog.some(row=>row.event==='listening'));
    assert.ok(apiLog.every(row=>!('body' in row)&&!('authorization' in row)));
    for(const closedPort of [apiMetricsPort,workerMetricsPort])await assert.rejects(fetch('http://127.0.0.1:'+closedPort+'/metrics',{signal:AbortSignal.timeout(500)}));
    for(const component of ['api','worker']){
      const observed=(await db.query('SELECT payload FROM runtime_config_events WHERE component=$1 ORDER BY sequence DESC LIMIT 1',[component])).rows[0];
      assert.equal(observed.payload.snapshot.resourceBudgetHash,digest(JSON.stringify(defaultResourceBudgetPolicy)));
    }
    console.log(JSON.stringify({event:'configured_resource_budgets_runtime_verified',api:true,worker:true,configurationHashRecorded:true}));
    const remaining = await db.query("SELECT count(*) FROM pg_stat_activity WHERE datname='galaxy_integration' AND application_name='galaxy-official'");
    assert.equal(Number(remaining.rows[0].count), 0);
    assert.equal(Number((await db.query('SELECT count(*) FROM schema_migrations')).rows[0].count), migrations.length);
    assert.equal(Number((await db.query('SELECT count(*) FROM case_events')).rows[0].count), 0);
    const honorRule={id:'runtime-helper',version:'1',title:'Synthetic runtime contributor',kind:'open-contributor',capabilityId:'compiler',communityId:'fixture',
      members:['GUID'+'0'.repeat(28),'GUID'+'1'.repeat(28)],notBefore:now-1,notAfter:now+1000,windowFrom:now-100,windowUntil:now+100,minAcceptedCases:1,minProofs:0,repositories:[]};
    const reviewed=await reviewedGovernanceFixture({endpoint,now,previousConfigurationSha256:governanceConfigurationHash({}),configuration:{honorRules:[honorRule]}});
    const governancePath=join(directory,'governance-source.json'),reviewPath=join(directory,'governance-signatures.json'),authoritiesPath=join(directory,'governance-authorities.json');
    for(const [path,value] of [[governancePath,reviewed.configuration],[reviewPath,reviewed.envelope],[authoritiesPath,reviewed.authorities]])await writeFile(path,JSON.stringify(value));
    const approvedDirectory=join(directory,'reviewed-governance');
    await prepareGovernanceBundle({configurationPath:governancePath,reviewPath,authoritiesPath,endpoint,directory:approvedDirectory,now});
    Object.assign(apiEnvironment,{GALAXY_GOVERNANCE_CONFIG:join(approvedDirectory,'governance.json'),GALAXY_GOVERNANCE_REVIEW_FILE:join(approvedDirectory,'review.json'),GALAXY_GOVERNANCE_AUTHORITIES_FILE:authoritiesPath});
    // Seed two genuine queued evidence objects with revoked disclosure. This
    // exercises work completion without making any public source request.
    const f = await serviceFixture(['binding', 'consent', 'case-teaser', 'evidence'], db, { migrateDatabase: false });
    const parent = { id: randomUUID(), kind: 'case', localRef: 'lifecycle_case', title: 'Synthetic lifecycle', summary: 'Synthetic only',
      source: { kind: 'local', reference: 'lifecycle_case' }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
    await f.cases.submit(f.actor, await f.authorize(parent));
    const attempt = { id: randomUUID(), kind: 'attempt', caseId: parent.id, expectedVersion: 1, sequence: 1,
      approach: 'Fixture', configuration: { environment: 'integration', version: '1', tools: [] } };
    await f.cases.submit(f.actor, await f.authorize(attempt));
    const result = { id: randomUUID(), kind: 'result', caseId: parent.id, expectedVersion: 2, attemptId: attempt.id,
      outcome: 'failed', summary: 'Synthetic failure', failureReason: 'Fixture', limitations: ['Synthetic'] };
    await f.cases.submit(f.actor, await f.authorize(result));
    for (const runId of [1, 2]) {
      const evidence = { id: randomUUID(), caseId: parent.id, resultId: result.id,
        source: { provider: 'github-actions', owner: 'fixture', repository: 'example', runId, attempt: 1, commit: 'a'.repeat(40) } };
      const grant = await f.authorize(evidence, 'evidence.submit');
      await f.evidence.submit(f.actor, grant);
      await f.consents.revoke(f.actor, grant.consentId);
    }
    // Make both jobs unambiguously due before the worker captures integer time.
    await db.query("UPDATE jobs SET available_at=now()-interval '1 minute'");
    // The configured real Worker must still clean export tickets, while it
    // leaves due evidence untouched during the takeout window.
    const retirementPath = join(directory, 'retirement.json');
    await writeFile(retirementPath, JSON.stringify({ version: 1, id: 'synthetic-takeout', endpoint,
      operator: 'Synthetic operator', reason: 'Configured runtime rehearsal', announcedAt: now - 60,
      stopWritesAt: now - 1, takeoutUntil: now + 600, statusUntil: now + 1200,
      contactUrl: endpoint + '/contact', deletionPolicyUrl: endpoint + '/deletion' }));
    const expiredExport = randomUUID();
    await db.query(`INSERT INTO data_exports(id,subject_id,binding_id,datasets,bounds,selection_cutoff,expires_at)
      VALUES($1,$2,$3,'["identity"]','{}',now(),now()-interval '1 minute')`, [expiredExport, f.actor.subjectId, f.actor.bindingId]);
    const takeoutApi = launch('server', { ...apiEnvironment, GALAXY_RETIREMENT_FILE: retirementPath });
    const takeoutWorker = launch('worker', { ...common, PGOPTIONS: '-c role=galaxy_evidence_worker', GALAXY_RETIREMENT_FILE: retirementPath });
    let takeoutReady = false;
    for (let i = 0; i < 150 && takeoutApi.exitCode === null; i++) {
      try { takeoutReady = (await (await fetch(`http://127.0.0.1:${port}/v1/service-status`)).json()).phase === 'takeout'; } catch { /* startup */ }
      if (takeoutReady) break; await pause();
    }
    assert.equal(takeoutReady, true);
    const honorHistory=await honorPost('rule-history');assert.equal(honorHistory.items.length,1);
    assert.equal(honorHistory.items[0].rule.id,honorRule.id);assert.equal(honorHistory.items[0].registry.configured,true);
    assert.ok(!JSON.stringify(honorHistory).includes(honorRule.members[0]));
    const appliedReview=(await db.query("SELECT payload FROM runtime_config_events WHERE component='api' ORDER BY sequence DESC LIMIT 1")).rows[0].payload.snapshot.governance.review;
    assert.equal(appliedReview.changeId,reviewed.change.changeId);
    console.log(JSON.stringify({event:'reviewed_governance_runtime_loaded',independentReview:true,linkedToConfigurationEvent:true}));
    const deniedWrite = await fetch(`http://127.0.0.1:${port}/v1/cases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(deniedWrite.status, 410); await deniedWrite.arrayBuffer();
    let cleaned = false;
    for (let i = 0; i < 150 && takeoutWorker.exitCode === null; i++) {
      cleaned = !(await db.query('SELECT 1 FROM data_exports WHERE id=$1', [expiredExport])).rows.length;
      if (cleaned) break; await pause();
    }
    assert.equal(cleaned, true, 'configured takeout Worker must execute its cleanup loop');
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.deepEqual((await db.query('SELECT state,attempts FROM jobs')).rows, [{ state: 'pending', attempts: 0 }, { state: 'pending', attempts: 0 }]);
    for (const child of [takeoutApi, takeoutWorker]) {
      if (process.platform === 'win32') child.send('stop-fixture'); else { child.disconnect(); child.kill('SIGTERM'); }
      assert.equal((await child.result).code, 0);
    }
    console.log(JSON.stringify({ event: 'configured_retirement_runtime_verified', publicNotice: true, businessWritesDenied: true, evidenceNotClaimed: true, expiredExportRemoved: true }));
    const incidentPath=join(directory,'incident.json');
    const incidentPolicy={version:1,id:'synthetic-worker-incident',revision:1,endpoint,state:'contained',
      updatedAt:Math.floor(Date.now()/1000),publicMessage:'Synthetic incident containment',recovery:null};
    await writeFile(incidentPath,JSON.stringify(incidentPolicy));
    common.GALAXY_INCIDENT_FILE=incidentPath;apiEnvironment.GALAXY_INCIDENT_FILE=incidentPath;
    const incidentApi=launch('server',apiEnvironment),incidentWorker=launch('worker',{...common,PGOPTIONS:'-c role=galaxy_evidence_worker'});
    let contained=false;
    for(let i=0;i<150&&incidentApi.exitCode===null;i++){
      try{contained=(await (await fetch(`http://127.0.0.1:${port}/v1/service-status`)).json()).incident?.state==='contained';}catch{/* startup */}
      if(contained)break;await pause();
    }
    assert.equal(contained,true);
    const incidentReady=await fetch(`http://127.0.0.1:${port}/readyz`);assert.equal(incidentReady.status,503);await incidentReady.arrayBuffer();
    let observedPause=false;
    for(let i=0;i<150&&incidentWorker.exitCode===null;i++){
      try{observedPause=/galaxy_worker_retirement_paused\{component="worker"\} 1/.test(await (await fetch(`http://127.0.0.1:${workerMetricsPort}/metrics`)).text());}catch{/* startup */}
      if(observedPause)break;await pause();
    }
    assert.equal(observedPause,true,'actual incident Worker must run a paused iteration');
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.deepEqual((await db.query('SELECT state,attempts FROM jobs')).rows,[{state:'pending',attempts:0},{state:'pending',attempts:0}]);
    for(const child of [incidentApi,incidentWorker]){
      if(process.platform==='win32')child.send('stop-fixture');else{child.disconnect();child.kill('SIGTERM');}
      assert.equal((await child.result).code,0);
    }
    const recoveredAt=Math.floor(Date.now()/1000);
    await writeFile(incidentPath,JSON.stringify({...incidentPolicy,revision:2,state:'resolved',updatedAt:recoveredAt,
      recovery:{checkedAt:recoveredAt,evidenceSha256:digest('Synthetic revoked-job recovery rehearsal')}}));
    const recoveredApi=launch('server',apiEnvironment);let recoveredReady=false;
    for(let i=0;i<150&&recoveredApi.exitCode===null;i++){
      try{const res=await fetch(`http://127.0.0.1:${port}/readyz`);recoveredReady=res.status===200;await res.arrayBuffer();}catch{/* startup */}
      if(recoveredReady)break;await pause();
    }
    assert.equal(recoveredReady,true);
    const restartedHistory=await honorPost('rule-history');assert.equal(restartedHistory.items.length,1);
    assert.equal(restartedHistory.items[0].registry.definitionHash,honorHistory.items[0].registry.definitionHash);
    console.log(JSON.stringify({event:'honor_registry_actual_startup_verified',reviewedDefinition:true,publicHistory:true,retainedAfterRestart:true}));
    if(process.platform==='win32')recoveredApi.send('stop-fixture');else{recoveredApi.disconnect();recoveredApi.kill('SIGTERM');}
    assert.equal((await recoveredApi.result).code,0);
    console.log(JSON.stringify({event:'configured_incident_runtime_verified',apiContained:true,workerDidNotClaim:true,recoveryReady:true}));
    const lock = await db.connect();
    let busy;
    try {
      await lock.query('BEGIN'); await lock.query('LOCK TABLE jobs IN ACCESS EXCLUSIVE MODE');
      busy = launch('worker', { ...common, PGOPTIONS: '-c role=galaxy_evidence_worker' });
      let blocked = false;
      for (let i = 0; i < 150 && busy.exitCode === null; i++) {
        blocked = Number((await db.query("SELECT count(*) FROM pg_stat_activity WHERE datname='galaxy_integration' AND application_name='galaxy-official' AND wait_event_type='Lock'")).rows[0].count) === 1;
        if (blocked) break; await pause();
      }
      assert.equal(blocked, true, 'actual Worker must be blocked inside a queue transaction');
      if (process.platform === 'win32') {
        const stopped = once(busy, 'disconnect'); busy.send('stop-fixture'); await stopped;
      } else { busy.disconnect(); busy.kill('SIGTERM'); await new Promise(resolve => setTimeout(resolve, 100)); }
      await lock.query('COMMIT');
    } finally { await lock.query('ROLLBACK'); lock.release(); }
    assert.equal((await busy.result).code, 0);
    const afterStop = (await db.query('SELECT state,attempts FROM jobs ORDER BY state')).rows;
    assert.deepEqual(afterStop, [{ state: 'completed', attempts: 1 }, { state: 'pending', attempts: 0 }]);
    assert.equal(Number((await db.query('SELECT count(*) FROM verification_attempts')).rows[0].count), 1);
    const resumed = launch('worker', { ...common, PGOPTIONS: '-c role=galaxy_evidence_worker' });
    let completed = 0;
    for (let i = 0; i < 150 && resumed.exitCode === null; i++) {
      completed = Number((await db.query("SELECT count(*) FROM jobs WHERE state='completed'")).rows[0].count);
      if (completed === 2) break; await pause();
    }
    assert.equal(completed, 2);
    if (process.platform === 'win32') resumed.send('stop-fixture');
    else { resumed.disconnect(); resumed.kill('SIGTERM'); }
    assert.equal((await resumed.result).code, 0);
    assert.equal(Number((await db.query("SELECT count(*) FROM evidence_submissions WHERE state='revoked'")).rows[0].count), 2);
    assert.equal(Number((await db.query('SELECT count(*) FROM verification_attempts')).rows[0].count), 2);
    assert.equal(Number((await db.query('SELECT count(*) FROM proofs')).rows[0].count), 0);
    assert.equal(Number((await db.query("SELECT count(*) FROM pg_stat_activity WHERE datname='galaxy_integration' AND application_name='galaxy-official'")).rows[0].count), 0);
    await db.query("INSERT INTO recovery_state(singleton,recovery_id,snapshot_id,status) VALUES(true,$1,$2,'quarantined')", [randomUUID(), 'a'.repeat(64)]);
    const quarantinedApi = launch('server', apiEnvironment, true);
    assert.equal((await quarantinedApi.result).code, 1);
    const startupLogs=(await readFile(apiLogPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(startupLogs.at(-1).phase,'recovery');
    const quarantinedWorker = launch('worker', { ...common, PGOPTIONS: '-c role=galaxy_evidence_worker' }, true);
    assert.equal((await quarantinedWorker.result).code, 1);
    const workerLog=(await readFile(join(runtimeLogDirectory,'worker-primary','runtime.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(workerLog.some(row=>row.event==='evidence_job'&&row.state==='revoked'));
    assert.equal(workerLog.at(-1).event,'worker_startup_failed');
    console.log(JSON.stringify({event:'actual_runtime_logging_verified',api:true,worker:true,startupFailure:true,flushedOnStop:true}));
    const configEvents=(await db.query('SELECT component FROM runtime_config_events')).rows;
    assert.ok(configEvents.some(row=>row.component==='api'));assert.ok(configEvents.some(row=>row.component==='worker'));
    console.log(JSON.stringify({event:'runtime_configuration_startups_recorded',components:['api','worker']}));
    console.log('Actual services and in-flight queue stop/restart passed: one completed job before stop, one preserved for restart, revoked evidence never promoted.');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled(children.map(child => child.result));
    if (db) await db.end(); await admin.end();
    await rm(temporary, { recursive: true, force: true });
  }
});
