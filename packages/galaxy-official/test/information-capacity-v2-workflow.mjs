import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { cpus, platform, arch, totalmem } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import canonicalize from 'canonicalize';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { defaultRequestQuotaPolicy } from '../src/adapters/http/request-quotas.mjs';
import { defaultResourceBudgetPolicy, subjectResourceUsage } from '../src/infrastructure/resource-budgets.mjs';
import { choicePutIntent } from '../src/shared/choice-snapshot-schema-v2.mjs';
import { costInputSchema } from '../src/operations/cost-input.mjs';
import { digest } from '../src/shared/digest.mjs';

const scopes = ['binding', 'consent', 'assistance'];
const tables = ['task_requests', 'task_events', 'choice_snapshot_heads', 'choice_snapshot_versions', 'consents', 'audit_events'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const millisecond = value => Math.round(value * 1000) / 1000;

export const informationCapacityProfile = Object.freeze({
  levels: Object.freeze([16, 64, 128]), fanouts: Object.freeze([1, 4, 8]),
  concurrency: Object.freeze([1, 4, 8]), requestsPerPhase: 24, budgetSamplesPerPhase: 16,
});

export function capacityCostObservation(input = null) {
  if (input === null) return { state: 'unknown', amount: null, currency: null, kind: null, observedAt: null,
    periodStart: null, periodEnd: null, attribution: 'unknown', perRequestCost: null,
    newPaidProcurementExecuted: false, modelCalls: 0 };
  const value = costInputSchema.parse(input);
  return { state: value.kind === 'billing-export' ? 'billing-observed' : 'operator-estimate', amount: value.amount,
    currency: value.currency, kind: value.kind, observedAt: value.observedAt,
    periodStart: value.periodStart, periodEnd: value.periodEnd, budget: value.budget,
    scope: value.version === 2 ? value.scope : null, attribution: 'unallocated', perRequestCost: null,
    newPaidProcurementExecuted: false, modelCalls: 0 };
}

function profile(input = {}) {
  const value = { ...informationCapacityProfile, ...input };
  assert.ok(Object.keys(input).every(key => Object.hasOwn(informationCapacityProfile, key)), 'Unsupported experiment option');
  for (const [key, limit] of [['levels', 128], ['fanouts', 8], ['concurrency', 8]]) {
    const items = value[key];
    assert.ok(Array.isArray(items) && items.length >= 1 && items.length <= 3
      && items.every(item => Number.isSafeInteger(item) && item >= 1 && item <= limit)
      && items.every((item, i) => i === 0 || item > items[i - 1]), 'Invalid bounded experiment matrix');
  }
  for (const key of ['requestsPerPhase', 'budgetSamplesPerPhase']) {
    assert.ok(Number.isSafeInteger(value[key]) && value[key] >= Math.max(...value.concurrency)
      && value[key] <= 64, 'Invalid bounded sample count');
  }
  return value;
}

function bodyMeter() {
  let counters;
  const reset = () => { counters = { responses: 0, requestBodyBytes: 0, responseBodyBytes: 0, statusCodes: {} }; };
  reset();
  return {
    reset, snapshot: () => structuredClone(counters), quotaRejected: () => {}, parserError: () => {},
    beginHttp: () => { let completed = false; return ({ status, bodyBytes, receivedBodyBytes }) => {
      if (completed) return; completed = true;
      counters.responses++; counters.requestBodyBytes += receivedBodyBytes; counters.responseBodyBytes += bodyBytes;
      counters.statusCodes[status] = (counters.statusCodes[status] ?? 0) + 1;
    }; },
  };
}

async function loadHttp(url, credential, path, body, concurrency, count) {
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const child = fork(fileURLToPath(new URL('./capacity-driver.mjs', import.meta.url)), [], {
    execPath: process.execPath, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'exit'); let message;
  const timer = setTimeout(() => child.kill(), 60000);
  try {
    const reply = new Promise((resolve, reject) => {
      child.once('message', value => { message = value; resolve(value); });
      child.once('error', () => reject(Error('Capacity generator could not start')));
      child.once('exit', () => { if (!message) reject(Error('Capacity generator ended without an observation')); });
    });
    const lanes = Array.from({ length: concurrency }, () => []);
    for (let i = 0; i < count; i++) lanes[i % concurrency].push({ method: 'POST', path,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credential }, body: JSON.stringify(body) });
    child.send({ url, lanes });
    const output = await reply;
    assert.equal(output.ok, true, 'Capacity generator failed');
    const [exitCode, signal] = await exited;
    assert.equal(exitCode, 0); assert.equal(signal, null);
    return output.result;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  }
}

function latencySamples(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = ratio => sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? null;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? null };
}

async function measureBudget(f, concurrency, count) {
  const cpu = process.cpuUsage(), started = performance.now(), values = [], failureCodes = {}; let cursor = 0, errors = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      if (cursor++ >= count) return;
      const start = performance.now();
      try { await f.access.runAuthorized(f.actor, 'binding', db => subjectResourceUsage(db, f.actor.subjectId, f.access.now())); }
      catch (error) { errors++; const code = /^[a-z0-9_]{1,80}$/i.test(error.code ?? '') ? error.code : 'unspecified';
        failureCodes[code] = (failureCodes[code] ?? 0) + 1; }
      values.push(millisecond(performance.now() - start));
    }
  }));
  const durationMs = millisecond(performance.now() - started);
  return { kind: 'authorized-resource-budget-aggregate', requestedConcurrency: concurrency,
    samples: values.length, errors, failureCodes, durationMs, latencyMs: latencySamples(values),
    cpuMicroseconds: process.cpuUsage(cpu), rssBytes: process.memoryUsage().rss,
    authorityCheckedBeforeAggregate: true, currencyCost: null };
}

async function storageSnapshot(database, postgres, subjects) {
  const counts = (await database.query(`SELECT
    (SELECT count(*) FROM task_requests WHERE requester_id=$1)::int AS selected_tasks,
    (SELECT count(*) FROM task_requests WHERE requester_id=$2)::int AS hidden_tasks,
    (SELECT count(*) FROM choice_snapshot_versions WHERE subject_id=$1)::int AS retained_versions,
    (SELECT count(*) FROM choice_snapshot_versions WHERE subject_id=$1 AND content <> '{}'::jsonb)::int AS bodies_retained`, subjects)).rows[0];
  if (!postgres) return { counts, databaseBytes: null, relations: [], physicalSizeMeaning: 'not-measured-in-local-PGlite-fixture' };
  const size = (await database.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0];
  const relations = [];
  for (const table of tables) {
    const row = (await database.query('SELECT pg_relation_size($1::regclass)::text AS table_bytes, '
      + 'pg_indexes_size($1::regclass)::text AS index_bytes, pg_total_relation_size($1::regclass)::text AS total_bytes', [table])).rows[0];
    relations.push({ table, tableBytes: Number(row.table_bytes), indexBytes: Number(row.index_bytes), totalBytes: Number(row.total_bytes) });
  }
  return { counts, databaseBytes: Number(size.bytes), relations,
    physicalSizeMeaning: 'isolated-database-and-selected-table/index-allocations; excludes-WAL/backups/other-host-data; not-billed-storage' };
}

// Caller supplies a provisioned, explicitly isolated PostgreSQL pool and owns
// its lifetime. This function never discovers targets, creates roles or DDL,
// connects to a public URL, changes production policy, or reads credentials.
export async function runInformationCapacityV2(database = null, options = {}) {
  const matrix = profile(options.profile), postgres = database !== null;
  let runtimeIdentity;
  if (postgres) {
    assert.equal(options.isolated, true, 'Explicit isolated PostgreSQL authorization required');
    assert.equal(options.migrateDatabase, false, 'Caller must provision schema before measurement');
    const role = (await database.query("SELECT current_user AS role, session_user AS login, r.rolsuper AS superuser, "
      + "l.rolsuper AS login_superuser, pg_has_role(current_user,'galaxy_api','member') AS api, "
      + "current_database() AS database, current_setting('application_name') AS application "
      + "FROM pg_roles r JOIN pg_roles l ON l.rolname=session_user WHERE r.rolname=current_user")).rows[0];
    assert.equal(role.superuser, false, 'Measured API pool must be non-superuser'); assert.equal(role.api, true);
    assert.equal(role.login_superuser, false, 'Use a real non-superuser API LOGIN, not a superuser role switch');
    assert.ok(options.adminDatabase, 'Isolated administrative read-only statistics pool required');
    assert.equal((await options.adminDatabase.query('SELECT current_database() AS name')).rows[0].name, role.database,
      'API and statistics pools must refer to exactly the same disposable database');
    const pristine = (await options.adminDatabase.query('SELECT count(*)::int AS subjects FROM subjects')).rows[0];
    assert.equal(pristine.subjects, 0, 'Measurement requires a fresh disposable database');
    runtimeIdentity = role;
  }
  const now = Math.floor(Date.now() / 1000);
  const f = await serviceFixture(scopes, database, { migrateDatabase: !postgres, repositories: options.repositories,
    now, syntheticCommunityQuota: false });
  let hidden, server;
  const lag = monitorEventLoopDelay({ resolution: 10 }), meter = bodyMeter();
  const requestQuotaPolicy = structuredClone(defaultRequestQuotaPolicy);
  for (const category of Object.values(requestQuotaPolicy.categories)) for (const key of Object.keys(category)) category[key] = 1000000;
  const phases = [], stages = [], privateMarker = 'CAPACITY_PRIVATE_OTHER_OWNER';
  const report = { schemaVersion: 1, observedAt: new Date().toISOString(), experiment: 'information-v2-retained-metadata-growth',
    taskIds: ['NEW-M23-FLOW', 'NEW-M23-ACCEPT', 'PREP-M23-STEP01', 'PREP-M23-STEP02', 'PREP-M23-AC01', 'PREP-M23-AC02'],
    profile: matrix, environment: { database: postgres ? 'PostgreSQL' : 'PGlite', actualPostgresConcurrency: postgres,
      node: process.versions.node, platform: platform(), architecture: arch(), cpuCount: cpus().length, hostMemoryBytes: totalmem(),
      transport: 'loopback-HTTP', generator: 'separate-Node-process/autocannon', apiAndGeneratorSeparateProcesses: true,
      actualAccountQuotaTested: false, syntheticIdentitiesAndData: true, restrictedApiLoginVerified: postgres }, cost: capacityCostObservation(options.costInput ?? null),
    requestQuota: { experimentPolicyHash: digest(JSON.stringify(requestQuotaPolicy)), productionPolicyHash: digest(JSON.stringify(defaultRequestQuotaPolicy)),
      frequencyGate: 'isolated-experiment-only-1000000-per-dimension/window', productionPolicyChanged: false,
      productionQueryPerMinute: defaultRequestQuotaPolicy.categories.query },
    resourceBudget: { policy: structuredClone(defaultResourceBudgetPolicy), changed: false }, sourceHashes: {}, stages, phases,
    limits: ['Selected bounded workload; no product SLO, user-concurrency limit, saturation or soak claim.',
      'Fanout repeats the actual Task source with distinct keys; not evidence for every source adapter.',
      'Private Task authorization and real signed business writes are exercised; no public Account or external-user trial.',
      'CPU/RSS describe the API experiment process, including its sampler; PostgreSQL CPU and unrelated host tenants are not attributed.',
      'Physical database allocations differ from logical per-subject budgets; no WAL/backup/whole-disk attribution.',
      'No model, outbound provider call, paid procurement, production load or inferred monetary cost.'], cleanup: { apiClosed: false, localDatabaseClosed: false } };
  try {
    hidden = await serviceFixture(scopes, f.db, { migrateDatabase: false, repositories: options.repositories, now, syntheticCommunityQuota: false });
    server = createApi({ ...f, requestQuotaPolicy, metrics: meter });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const request = async (who, path, body) => {
      const response = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + who.credential },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200, 'Unexpected capacity-fixture HTTP status at ' + path);
      return response.json();
    };
    const snapshotId = randomUUID(), search = { type: 'task', query: { view: 'requested', query: 'Capacity visible', limit: 8 } };
    const preference = await request(f, '/v2/choice-snapshots/preferences/save', {
      endpoint: f.access.endpoint, expectedRevision: 0, enabled: true, snapshotIds: [snapshotId],
    });
    let created = 0, revision = 0, witness, original;
    const seedTask = async (who, i, other) => {
      const task = { operationId: randomUUID(), taskId: randomUUID(), caseId: null, intent: 'proactive-review',
        workContext: { goal: 'Bounded capacity experiment', currentSituation: 'Synthetic isolated input', attemptRefs: [] },
        title: other ? privateMarker : 'Capacity visible ' + i, summary: 'Synthetic workload; not real collaboration',
        visibility: 'Private', collaboration: 'open-assistance', enrollmentExpiresAt: now + 7200 };
      const submission = await who.authorize(task, 'assistance.publish', { objectId: task.operationId });
      const receipt = await request(who, '/v2/tasks', submission);
      assert.equal(receipt.taskId, task.taskId);
    };
    for (const relative of ['../src/information-v2.mjs', '../src/tasks-v2.mjs', '../src/tasks/v2/authority.mjs',
      '../src/tasks/v2/read-model.mjs', '../src/tasks/v2/service.mjs', '../src/tasks/v2/helpers.mjs', '../src/choice-snapshots-v2.mjs',
      '../src/infrastructure/resource-budgets.mjs', '../src/operations/cost-input.mjs', './capacity-driver.mjs', './information-capacity-v2-workflow.mjs']) {
      report.sourceHashes[relative] = sha(await readFile(new URL(relative, import.meta.url)));
    }
    if (postgres) report.environment.postgresVersion = (await database.query('SHOW server_version')).rows[0].server_version;
    lag.enable();
    for (const level of matrix.levels) {
      for (; created < level; created++) {
        await seedTask(f, created, false); await seedTask(hidden, created, true);
        witness ??= (await request(f, '/v2/search/query', search)).items[0]; assert.ok(witness?.ref);
        const input = { snapshotId, versionId: randomUUID(), baseRevision: revision, preferenceRevision: preference.revision,
          content: { localVersion: created + 1, localTaskRef: 'capacity-work', visibleRationale: 'Selected own source ' + created,
            rationaleAuthor: 'user', candidateRefs: [{ type: witness.type, ...witness.ref }], selectedRefs: [], resultRefs: [] },
          witnesses: [{ search, ref: witness.ref }], resolveVersionIds: [] };
        const receipt = await request(f, '/v2/choice-snapshots/put', input); revision = receipt.revision;
        original ??= { snapshotId, versionId: input.versionId, requestHash: digest(canonicalize(choicePutIntent(input))) };
      }
      const storage = await storageSnapshot(options.adminDatabase ?? f.db, postgres, [f.actor.subjectId, hidden.actor.subjectId]);
      assert.equal(storage.counts.selected_tasks, level); assert.equal(storage.counts.hidden_tasks, level);
      assert.equal(storage.counts.retained_versions, level); assert.equal(storage.counts.bodies_retained, 1);
      const usage = await f.access.runAuthorized(f.actor, 'binding', db => subjectResourceUsage(db, f.actor.subjectId, now));
      assert.ok(usage.payloadBytes <= BigInt(defaultResourceBudgetPolicy.maxPayloadBytesPerSubject));
      stages.push({ level, ...storage, ownerBudgetBytes: Number(usage.payloadBytes), queuedJobs: usage.queuedJobs, activeExports: usage.activeExports });
      const exercise = async (kind, fanout, concurrency) => {
        const readingReceipt = kind === 'original-choice-metadata-receipt';
        const path = readingReceipt ? '/v2/choice-snapshots/receipt' : '/v2/information/query';
        const body = readingReceipt ? original : { purpose: 'Isolated bounded capacity observation',
          sources: Array.from({ length: fanout }, (_, i) => ({ key: 'task-' + i, source: { kind: 'search',
            request: { type: 'task', query: { view: 'open', query: kind === 'authorized-no-match-scan' ? 'capacitymissingtoken' : 'Capacity visible', limit: 8 } } } })) };
        const check = async () => {
          const result = await request(f, path, body); assert.equal(JSON.stringify(result).includes(privateMarker), false);
          if (readingReceipt) {
            assert.equal(result.state, 'acknowledged'); assert.equal(result.contentReturned, false); assert.equal(result.currentAccessGranted, false);
            assert.equal(result.receipt.versionId, original.versionId);
          } else {
            assert.equal(result.modelCalls, 0); assert.equal(result.items.length, fanout);
            assert.ok(result.items.every(item => kind === 'authorized-no-match-scan' ? item.state === 'no-visible-data' : item.items.length > 0));
          }
        };
        await check(); meter.reset(); lag.reset();
        const cpu = process.cpuUsage(), started = performance.now(), rssBefore = process.memoryUsage().rss;
        const pgConnections = { measured: postgres, sampleCount: 0, peakActiveConnectionsObserved: 0, peakEstablishedConnectionsObserved: 0,
          activeMeaning: 'pg_stat_activity state active at 100ms sample; not inferred from requested client concurrency' };
        let sampling = postgres;
        const sampler = postgres ? (async () => {
          while (sampling) {
            const row = (await options.adminDatabase.query("SELECT count(*)::int AS established, "
              + "count(*) FILTER(WHERE state='active')::int AS active FROM pg_stat_activity "
              + "WHERE datname=current_database() AND usename=$1 AND application_name=$2", [runtimeIdentity.login, runtimeIdentity.application])).rows[0];
            pgConnections.sampleCount++;
            pgConnections.peakActiveConnectionsObserved = Math.max(pgConnections.peakActiveConnectionsObserved, row.active);
            pgConnections.peakEstablishedConnectionsObserved = Math.max(pgConnections.peakEstablishedConnectionsObserved, row.established);
            await delay(100);
          }
        })().catch(() => { sampling = false; pgConnections.measurementError = 'postgres_activity_sampling_failed'; }) : null;
        let result;
        try { result = await loadHttp(url, f.credential, path, body, concurrency, matrix.requestsPerPhase); }
        finally { sampling = false; if (sampler) await sampler; }
        const cpuMicroseconds = process.cpuUsage(cpu), measuredBody = meter.snapshot(), elapsedMs = millisecond(performance.now() - started);
        phases.push({ level, kind, sourceCount: readingReceipt ? 0 : fanout, requestedConcurrency: concurrency,
          requestedSamples: matrix.requestsPerPhase, ...result, elapsedMs, cpuMicroseconds, rssBefore, rssAfter: process.memoryUsage().rss, pgConnections,
          eventLoopMs: { mean: Number.isFinite(lag.mean) ? millisecond(lag.mean / 1e6) : null,
            p95: millisecond(lag.percentile(95) / 1e6), max: millisecond(lag.max / 1e6) },
          body: measuredBody, transferredBytesMeaning: 'generator HTTP transfer bytes; body counters separately exclude headers/TLS',
          unavailablePercentiles: ['p95-not-exposed-by-existing-generator; actual p50/p90/p97_5/p99 are preserved'],
          semanticProbes: { before: true, after: false }, currencyCost: null });
        await check(); phases.at(-1).semanticProbes.after = true;
      };
      for (const concurrency of matrix.concurrency) {
        for (const fanout of matrix.fanouts) await exercise('authorized-visible-page', fanout, concurrency);
        await exercise('authorized-no-match-scan', 1, concurrency);
        await exercise('original-choice-metadata-receipt', 0, concurrency);
        phases.push({ level, ...await measureBudget(f, concurrency, matrix.budgetSamplesPerPhase) });
      }
    }
    report.allMeasuredRequestsSucceeded = phases.every(phase => phase.errors === 0
      && (phase.kind === 'authorized-resource-budget-aggregate' || phase.responses === phase.requestedSamples
        && Object.keys(phase.statusCodes).every(code => code === '200')));
    report.allRequiredMeasurementsComplete = phases.every(phase => phase.kind === 'authorized-resource-budget-aggregate'
      || !postgres || phase.pgConnections.sampleCount > 0 && !phase.pgConnections.measurementError);
    report.environment.poolConnectionsEstablished = postgres ? database.totalCount ?? null : null;
    report.completedAt = new Date().toISOString();
    return report;
  } finally {
    lag.disable();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); report.cleanup.apiClosed = true; }
    if (!database) { await f.db.close(); report.cleanup.localDatabaseClosed = true; }
  }
}
