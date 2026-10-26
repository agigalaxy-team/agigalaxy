import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { generateKeyPairSync, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, cp, lstat, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { serviceFixture } from '../service-fixture.mjs';
import { issueKeyring } from "../../src/security/trust-keyring.mjs";
import { verifyEnvelope } from "../../src/security/signed-envelope.mjs";
import { createServiceRelease, inspectServiceTransition } from '../../src/operations/service-release.mjs';
import { runBackupCommand } from '../../src/operations/backup.mjs';
import { officialRoutes } from '../../deploy/caddy-routes.mjs';

const pause = () => new Promise(resolve => setTimeout(resolve, 40));
const reserve = async () => {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
};

test('independently installed Official API/Worker releases run, switch and roll back through Caddy', { timeout: 180000 }, async () => {
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED, '1'); assert.ok(process.env.GALAXY_TEST_CADDY_BIN);
  assert.ok(process.env.GALAXY_TEST_NPM_CLI && isAbsolute(process.env.GALAXY_TEST_NPM_CLI), 'Explicit npm-cli.js required');
  const temporary = await mkdtemp(join(tmpdir(), 'galaxy-service-release-'));
  const admin = new pg.Pool(), children = []; let db;
  try {
    await admin.query('CREATE DATABASE galaxy_local'); db = new pg.Pool({ database: 'galaxy_local' });
    const now = Math.floor(Date.now() / 1000), endpoint = 'https://official.example.org';
    const f = await serviceFixture(['binding', 'consent', 'case-teaser'], db, { now });
    for (const role of ['api', 'worker']) await db.query(await readFile(new URL(`../../src/infrastructure/${role}-role.sql`, import.meta.url), 'utf8'));
    const beforeSubject = (await db.query('SELECT * FROM subjects')).rows;
    const makeCase = title => ({ id: randomUUID(), kind: 'case', localRef: randomUUID(), title, summary: 'Synthetic only',
      source: { kind: 'local', reference: randomUUID() }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] });
    const first = makeCase('Before release'), firstGrant = await f.authorize(first);
    await f.cases.submit(f.actor, firstGrant);
    const previous = await createServiceRelease({ directory: join(temporary, 'previous'), releaseId: 'previous', configurationVersion: 'config-1' });
    const candidateSource = join(temporary, 'candidate-source'); await cp(previous.directory, candidateSource, { recursive: true, errorOnExist: true });
    const manifestModule = join(candidateSource, 'packages/galaxy-official/src/manifest.mjs');
    const original = await readFile(manifestModule, 'utf8'); assert.equal(original.split("'Galaxy Official'").length, 2);
    await writeFile(manifestModule, original.replace("'Galaxy Official'", "'Galaxy Candidate Fixture'"));
    const candidate = await createServiceRelease({ directory: join(temporary, 'candidate'), releaseId: 'candidate', configurationVersion: 'config-2', sourceDirectory: candidateSource });
    const configRoot = join(temporary, 'local'); await mkdir(configRoot);
    const key = generateKeyPairSync('ed25519'), root = generateKeyPairSync('ed25519');
    const pin = pair => ({ publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }), notBefore: now - 60, notAfter: now + 200000, revoked: false });
    const rootPin = { kid: 'root', ...pin(root) }, servicePin = { kid: 'service', ...pin(key) };
    await writeFile(join(configRoot, 'key.pem'), key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await writeFile(join(configRoot, 'pins.json'), JSON.stringify({ version: 1, endpoint, sequence: 1, keys: [rootPin] }));
    await writeFile(join(configRoot, 'ring.json'), JSON.stringify(await issueKeyring({ endpoint, keys: [servicePin], sequence: 1, rootKid: 'root', rootPrivateKey: root.privateKey, now })));
    const url = new URL(`postgresql://${process.env.PGHOST}:${process.env.PGPORT}/galaxy_local`);
    url.username = process.env.PGUSER; url.password = process.env.PGPASSWORD;
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GALAXY_') && name !== 'DATABASE_URL'));
    const npmEnvironment = Object.fromEntries(Object.entries(inherited).filter(([name]) => !name.toLowerCase().startsWith('npm_config_')));
    const userConfig = join(temporary, 'user.npmrc'), globalConfig = join(temporary, 'global.npmrc');
    await writeFile(userConfig, ''); await writeFile(globalConfig, '');
    const launch = (binary, args, env, ipc = false) => {
      const child = spawn(binary, args, { env, windowsHide: true, stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
      child.stdout.resume(); child.stderr.resume();
      child.result = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
      children.push(child); return child;
    };
    const ports = [], workers = [], installs = [];
    for (const release of [previous, candidate]) {
      const packageDirectory = join(release.directory, 'packages/galaxy-official');
      await assert.rejects(lstat(join(packageDirectory, 'node_modules')), { code: 'ENOENT' });
      const installed = JSON.parse(await runBackupCommand(process.execPath, [process.env.GALAXY_TEST_NPM_CLI,
        'ci', '--omit=dev', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--json',
        '--userconfig', userConfig, '--globalconfig', globalConfig, '--registry', 'https://registry.npmjs.org/'],
      { env: npmEnvironment, cwd: packageDirectory, timeoutMs: 60000 }));
      assert.ok(installed.added > 0);
      assert.equal((await lstat(join(packageDirectory, 'node_modules'))).isSymbolicLink(), false);
      await assert.rejects(lstat(join(packageDirectory, 'node_modules/@electric-sql/pglite')), { code: 'ENOENT' });
      installs.push({ release: release.releaseId, added: installed.added, offline: true, devDependencies: false, sharedNodeModules: false });
      const migration = await runBackupCommand(process.execPath, [join(packageDirectory, 'src/migrate.mjs'), '--roles=api,worker'],
        { env: { ...inherited, PGOPTIONS: '', GALAXY_ENVIRONMENT: 'local', DATABASE_URL: url.href,
          GALAXY_RELEASE_DIRECTORY: release.directory, GALAXY_RELEASE_SHA256: release.manifestSha256,
          GALAXY_CONFIGURATION_VERSION: release.releaseId === 'previous' ? 'config-1' : 'config-2' }, cwd: packageDirectory });
      const completedMigration = migration.trim().split('\n').map(line => JSON.parse(line)).find(row => row.event === 'migration_complete');
      assert.equal(completedMigration.version, release.schema); assert.equal(completedMigration.count, 2);
      if (release === previous) {
        const recapturedPath = join(temporary, 'recaptured'), recapturedReceipt = join(temporary, 'recaptured-receipt.json');
        await runBackupCommand(process.execPath, [join(packageDirectory, 'scripts/service-release.mjs'), 'capture',
          recapturedPath, 'recaptured', 'config-1', recapturedReceipt], { env: npmEnvironment, cwd: packageDirectory });
        const recaptured = JSON.parse(await readFile(join(recapturedPath, 'service-release.json'), 'utf8'));
        const originalManifest = JSON.parse(await readFile(join(release.directory, 'service-release.json'), 'utf8'));
        assert.deepEqual(recaptured.files, originalManifest.files);
      }
      const trust = join(configRoot, `${release.releaseId}-trust`); await mkdir(trust);
      const port = await reserve(); ports.push(port);
      const env = { ...inherited, GALAXY_ENVIRONMENT: 'local', GALAXY_ENDPOINT: endpoint, DATABASE_URL: url.href,
        PGOPTIONS: '-c role=galaxy_api', PORT: String(port), GALAXY_OPERATOR: 'Synthetic release test', GALAXY_REGION: 'test',
        GALAXY_ENVIRONMENT_DIRECTORY: configRoot, GALAXY_SIGNING_KEY_FILE: join(configRoot, 'key.pem'), GALAXY_SIGNING_KEY_ID: 'service',
        GALAXY_ROOT_PINS_FILE: join(configRoot, 'pins.json'), GALAXY_KEYRING_FILE: join(configRoot, 'ring.json'), GALAXY_TRUST_DIRECTORY: trust,
        GALAXY_RELEASE_DIRECTORY: release.directory, GALAXY_RELEASE_SHA256: release.manifestSha256,
        GALAXY_CONFIGURATION_VERSION: release.releaseId === 'previous' ? 'config-1' : 'config-2' };
      const args = process.platform === 'win32' ? ['--import', new URL('./stop-channel.mjs', import.meta.url).href] : [];
      const child = launch(process.execPath, [...args, join(release.directory, 'packages/galaxy-official/src/server.mjs')], env, true);
      let ready = false;
      for (let i = 0; i < 150 && child.exitCode === null; i++) {
        try { ready = (await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(300) })).status === 200; } catch { /* startup */ }
        if (ready) break; await pause();
      }
      assert.equal(ready, true, `${release.releaseId} actual API ready`);
      const metricsPort = await reserve();
      const worker = launch(process.execPath, [...args, join(packageDirectory, 'src/worker.mjs')],
        { ...inherited, GALAXY_ENVIRONMENT: 'local', GALAXY_ENDPOINT: endpoint, DATABASE_URL: url.href,
          PGOPTIONS: '-c role=galaxy_evidence_worker', GALAXY_METRICS_PORT: String(metricsPort),
          GALAXY_RELEASE_DIRECTORY: release.directory, GALAXY_RELEASE_SHA256: release.manifestSha256,
          GALAXY_CONFIGURATION_VERSION: env.GALAXY_CONFIGURATION_VERSION }, true);
      let metrics = '';
      for (let i = 0; i < 150 && worker.exitCode === null; i++) {
        try { metrics = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`, { signal: AbortSignal.timeout(300) })).text(); } catch { /* startup */ }
        if (/galaxy_worker_iterations_total\{[^}]*outcome="idle"[^}]*\} [1-9]/.test(metrics)) break;
        await pause();
      }
      assert.match(metrics, /galaxy_worker_iterations_total\{[^}]*outcome="idle"[^}]*\} [1-9]/);
      assert.doesNotMatch(metrics, /galaxy_worker_iterations_total\{[^}]*outcome="error"[^}]*\} [1-9]/);
      const recorded = (await db.query("SELECT payload FROM runtime_config_events WHERE component='worker' ORDER BY sequence DESC LIMIT 1")).rows[0].payload.snapshot.release;
      assert.equal(recorded.manifestSha256, release.manifestSha256);
      workers.push({ release: release.releaseId, iterationsObserved: true });
      // Stop the first Worker before starting the candidate Worker.
      if (process.platform === 'win32') worker.send('stop-fixture');
      else { worker.disconnect(); worker.kill('SIGTERM'); }
      assert.equal(await worker.result, 0);
    }
    const proxyPort = await reserve(), adminPort = await reserve();
    const proxyEnvironment = { ...inherited, XDG_DATA_HOME: temporary, XDG_CONFIG_HOME: temporary };
    const configs = [];
    for (const [i, release] of [previous, candidate].entries()) {
      const path = join(temporary, `${release.releaseId}-caddy.json`); configs.push(path);
      await writeFile(path, JSON.stringify({ admin: { listen: `127.0.0.1:${adminPort}` }, apps: { http: { servers: { fixture: {
        automatic_https: { disable: true }, listen: [`127.0.0.1:${proxyPort}`], routes: officialRoutes({ endpoint, apiPort: ports[i] }) } } } } }));
      await runBackupCommand(process.env.GALAXY_TEST_CADDY_BIN, ['validate', '--config', path], { env: proxyEnvironment });
    }
    launch(process.env.GALAXY_TEST_CADDY_BIN, ['run', '--config', configs[0]], proxyEnvironment);
    const send = (path, method = 'GET', payload) => new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: proxyPort, path, method, agent: false,
        headers: { Host: 'official.example.org', Authorization: `Bearer ${f.credential}`, 'Content-Type': 'application/json' } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('end', () => resolve({ status: res.statusCode,
          release: res.headers['x-galaxy-release'], body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); req.setTimeout(1500, () => req.destroy(new Error('fixture timeout'))); req.once('error', reject); req.end(payload === undefined ? undefined : JSON.stringify(payload));
    });
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await send('/v1/policy')).release === 'previous'; } catch { /* startup */ } if (ready) break; await pause(); }
    assert.equal(ready, true);
    const readName = async () => {
      const response = await send('/.well-known/galaxy-network.json'); assert.equal(response.status, 200);
      return (await verifyEnvelope(response.body.signed, { type: 'manifest', issuer: endpoint, audience: endpoint,
        trustedKeys: new Map([['service', servicePin]]), now: Math.floor(Date.now() / 1000), maxAge: 300 })).data.displayName;
    };
    const transition = async (from, to, config) => {
      const check = await inspectServiceTransition({ db, fromDirectory: from.directory, fromDigest: from.manifestSha256,
        toDirectory: to.directory, toDigest: to.manifestSha256 }); assert.equal(check.compatible, true);
      await runBackupCommand(process.env.GALAXY_TEST_CADDY_BIN, ['reload', '--address', `127.0.0.1:${adminPort}`, '--config', config], { env: proxyEnvironment });
      return check;
    };
    assert.equal(await readName(), 'Galaxy Official'); assert.equal((await send(`/v1/cases/${first.id}`)).status, 200);
    await transition(previous, candidate, configs[1]);
    assert.equal(await readName(), 'Galaxy Candidate Fixture');
    const second = makeCase('Written by candidate');
    const created = await send('/v1/cases', 'POST', await f.authorize(second));
    assert.equal(created.status, 200); assert.equal(created.release, 'candidate');
    assert.equal((await send(`/v1/consents/${firstGrant.consentId}/revoke`, 'POST', {})).status, 200);
    const rollback = await transition(candidate, previous, configs[0]);
    assert.equal(await readName(), 'Galaxy Official');
    const retained = await send(`/v1/cases/${second.id}`); assert.equal(retained.status, 200); assert.equal(retained.release, 'previous');
    assert.equal(retained.body.events[0].title, 'Written by candidate');
    assert.ok((await send(`/v1/cases/${first.id}`)).status >= 400);
    assert.deepEqual((await db.query('SELECT * FROM subjects')).rows, beforeSubject);
    assert.equal((await db.query('SELECT count(*) FROM case_events')).rows[0].count, '2');
    await db.query('INSERT INTO schema_migrations(version) VALUES(999)');
    await assert.rejects(inspectServiceTransition({ db, fromDirectory: previous.directory, fromDigest: previous.manifestSha256,
      toDirectory: candidate.directory, toDigest: candidate.manifestSha256 }), /incompatible/);
    assert.equal((await send('/v1/policy')).release, 'previous');
    await db.query('DELETE FROM schema_migrations WHERE version=999');
    assert.equal(rollback.schema, previous.schema); assert.equal(candidate.schema, previous.schema);
    const result = { event: 'official_application_rollback', schema: rollback.schema, previous: previous.manifestSha256, candidate: candidate.manifestSha256,
      sourceFilesSha256: createHash('sha256').update(JSON.stringify(JSON.parse(await readFile(join(previous.directory, 'service-release.json'), 'utf8')).files)).digest('hex'),
      filesPerRelease: previous.files, signedManifestVerified: true, genuineCodeDifference: true, candidateWritesPreserved: true,
      revocationPreserved: true, subjectUnchanged: true, incompatibleTransitionRefused: true, proxy: 'actual local Caddy',
      releaseDatabaseDowngrade: rollback.databaseDowngrade, deployed: false, frozenDependencyInstall: true,
      packagedCaptureCommandVerified: true, packagedMigrationCommandVerified: true, installs, workers };
    console.log(JSON.stringify(result));
    if (process.env.GALAXY_TEST_RELEASE_EVIDENCE) await writeFile(process.env.GALAXY_TEST_RELEASE_EVIDENCE, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  } finally {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      if (child.connected && process.platform === 'win32') child.send('stop-fixture');
      else { if (child.connected) child.disconnect(); child.kill(); }
    }
    await Promise.allSettled(children.map(child => child.result));
    if (db) await db.end(); await admin.end(); await rm(temporary, { recursive: true, force: true });
  }
});
