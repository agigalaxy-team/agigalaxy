import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationsConfiguration } from './configuration.mjs';
import { operationsPlan, mergePostgresService } from './manage.mjs';
import { renderOperationsFiles, grafanaClientContract, postgresOverlay } from './render.mjs';
import { chooseBackup, restoreManifest, isolatedPostgresArguments } from './backup.mjs';
import { quiesce } from './host.mjs';

const example = JSON.parse(await readFile(new URL('configuration.example.json', import.meta.url), 'utf8'));
function fixture() {
  const value = structuredClone(example);
  value.targetHostname = 'galaxy-fixture';
  value.tools.stackDirectory = '/opt/galaxy/fixture/packages/galaxy-official/deploy/operations-stack';
  value.monitoring.apiTarget = '127.0.0.1:9411'; value.monitoring.workerTarget = '127.0.0.1:9412';
  for (const pg of value.postgres) { pg.uid = 999; pg.gid = 999; pg.systemIdentifier = '7654321098765432100'; pg.serverCommand = ['postgres', '-c', 'max_connections=80']; }
  return operationsConfiguration(value);
}

test('monitoring uses its own realm and explicit signed client roles; no public collector listeners', async () => {
  const config = fixture(), files = await renderOperationsFiles(config), compose = JSON.parse(files['compose.json']);
  const contract = grafanaClientContract(config);
  assert.equal(contract.realm, 'galaxy-operations');
  assert.equal(contract.client.standardFlowEnabled, true);
  assert.equal(contract.client.directAccessGrantsEnabled, false);
  assert.equal(contract.client.implicitFlowEnabled, false);
  assert.equal(contract.client.fullScopeAllowed, false);
  assert.deepEqual(contract.client.redirectUris, ['https://admin.agigalaxy.org/monitoring/login/generic_oauth']);
  assert.equal(contract.client.protocolMappers[0].config['id.token.claim'], 'true');
  assert.match(files['grafana/grafana.ini'], /role_attribute_strict = true/);
  assert.match(files['grafana/grafana.ini'], /role_attribute_path = .*\|\| ''\n/);
  assert.match(files['grafana/grafana.ini'], /validate_id_token = true/);
  assert.match(files['grafana/grafana.ini'], /use_pkce = true/);
  for (const service of Object.values(compose.services)) { assert.equal(service.network_mode, 'host'); assert.equal(service.ports, undefined); }
  assert.equal(JSON.parse(files['loki.json']).server.http_listen_address, '127.0.0.1');
  assert.equal(JSON.parse(files['loki.json']).common.instance_addr, '127.0.0.1');
  assert.equal(operationsPlan(config).backup.publicRestore, false);
});

test('component collection uses explicit sources and reconstructs safe records with non-indexed request IDs', async () => {
  const files = await renderOperationsFiles(fixture()), alloy = files['config.alloy'];
  assert.match(alloy, /_SYSTEMD_UNIT=galaxy-api@pilot.service/);
  assert.match(alloy, /_SYSTEMD_UNIT=galaxy-worker@pilot.service/);
  assert.match(alloy, /_SYSTEMD_UNIT=galaxy-admin-pilot.service/);
  assert.match(alloy, /component = "keycloak"/);
  assert.match(alloy, /component = "postgres-business"/);
  assert.match(alloy, /component = "caddy-access"/);
  assert.match(alloy, /drop_malformed = false/);
  assert.match(alloy, /source = "safe_line"/);
  assert.match(alloy, /stage\.structured_metadata \{ values = \{requestId = "safe_requestId"/);
  assert.match(alloy, /tail_from_end = false/);
  assert.match(alloy, /on_positions_file_error = "restart_from_beginning"/);
  assert.doesNotMatch(alloy, /docker\.sock|__journal__MESSAGE/);
  assert.doesNotMatch(alloy.match(/stage\.labels[^\n]*/)[0], /requestId/);
  assert.match(alloy, /toJson \$r/);
  assert.match(alloy, /log_projection_failed/);
  assert.match(files['systemd/galaxy-component-logs.service'], /RestrictAddressFamilies=AF_UNIX/);
  assert.match(files['systemd/galaxy-component-logs.service'], /component-logs\.mjs/);
  const compose = JSON.parse(files['compose.json']);
  assert.equal(compose.services.alloy.volumes.some(volume => volume.source.includes('docker.sock')), false);
  assert.equal(JSON.parse(files['loki.json']).limits_config.allow_structured_metadata, true);
  const dashboard = JSON.parse(files['grafana/dashboards/galaxy-logs.json']);
  assert.equal(dashboard.uid, 'galaxy-logs');
  assert.ok(dashboard.templating.list.some(variable => variable.name === 'requestId' && variable.type === 'textbox'));
});

test('existing management-realm roles are an explicit alternative to dedicated client roles', async () => {
  const raw = fixture();
  raw.grafana.roleSource = 'realm';
  raw.grafana.roles = { admin: 'galaxy-operations-administrator', editor: 'galaxy-operations-administrator', viewer: 'galaxy-operations-reader' };
  const config = operationsConfiguration(raw), files = await renderOperationsFiles(config), contract = grafanaClientContract(config);
  assert.match(files['grafana/grafana.ini'], /contains\(realm_access\.roles/);
  assert.match(files['grafana/grafana.ini'], /role_attribute_strict = true/);
  assert.equal(contract.client.protocolMappers[0].protocolMapper, 'oidc-usermodel-realm-role-mapper');
  assert.deepEqual(new Set(contract.realmRoleScopeMappings), new Set(['galaxy-operations-administrator', 'galaxy-operations-reader']));
  assert.equal(contract.clientRoles, undefined);
  assert.match(files['systemd/galaxy-alertmanager.service'], /LoadCredential=alertmanager\.json:/);
  assert.match(files['systemd/galaxy-alertmanager.service'], /--config.file=\/run\/credentials\/galaxy-alertmanager.service\/alertmanager.json/);
});

test('PITR compose merge preserves existing environment, data volume and unrelated commands and remains idempotent', () => {
  const config = fixture(), pg = config.postgres[0], overlay = postgresOverlay(config, pg).services.database;
  const original = { image: config.images.postgresBase, environment: { POSTGRES_PASSWORD_FILE: '/run/secrets/database_password' }, volumes: ['database:/var/lib/postgresql', '/etc/galaxy/pilot/database.password:/run/secrets/database_password:ro'], restart: 'unless-stopped' };
  const merged = mergePostgresService(original, overlay), repeated = mergePostgresService(merged, overlay);
  assert.deepEqual(repeated, merged);
  assert.equal(merged.environment, original.environment);
  assert.equal(merged.volumes[0], 'database:/var/lib/postgresql');
  assert.equal(merged.restart, 'unless-stopped');
  assert.ok(merged.command.includes('max_connections=80'));
  assert.ok(merged.command.includes('archive_mode=on'));
  assert.equal(original.image, config.images.postgresBase);
});

test('database PITR selects a base backup that completed before the requested time', () => {
  const info = [{ backup: [
    { label: '20261018-030000F', timestamp: { stop: 1000 } },
    { label: '20261018-030000F_20261020-030000D', timestamp: { stop: 1500 } }
  ] }];
  assert.equal(chooseBackup(info, { before: 1400 }).label, '20261018-030000F');
  assert.throws(() => chooseBackup(info, { before: 999 }), /no_eligible_database_backup/);
});

test('isolated restore binds only the new data tree and read-only repository, with no network or public port', () => {
  const config = fixture(), pg = config.postgres[0];
  const args = isolatedPostgresArguments(config, pg, { root: '/var/lib/galaxy/restores/example/postgres/business', repository: '/var/lib/galaxy/restores/example/bundle/pgbackrest/business', configurationFile: '/var/lib/galaxy/restores/example/restore-config/business.conf', name: 'galaxy-restore-example-business', entrypoint: 'postgres', args: ['-D', pg.dataPath] });
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.equal(args.includes('--publish'), false); assert.equal(args.includes('-p'), false);
  assert.ok(args.includes('type=bind,src=/var/lib/galaxy/restores/example/postgres/business,dst=/var/lib/postgresql'));
  assert.ok(args.includes('type=bind,src=/var/lib/galaxy/restores/example/bundle/pgbackrest/business,dst=/var/lib/pgbackrest,readonly'));
  assert.equal(args.some(value => value.includes('/var/lib/docker/volumes/')), false);
});

test('a whole-product restore rejects a database from a different cluster or capture point', () => {
  const config = fixture(), id = '00000000-0000-4000-8000-000000000000';
  const manifest = { version: 1, id, databases: config.postgres.map(pg => ({ id: pg.id, systemIdentifier: pg.systemIdentifier, dataPath: pg.dataPath, database: pg.database, backupLabel: '20261018-030000F', restorePoint: 'galaxy_' + '0'.repeat(32) })) };
  assert.equal(restoreManifest(manifest, config, id), manifest);
  const changed = structuredClone(manifest); changed.databases[0].systemIdentifier = '7654321098765432101';
  assert.throws(() => restoreManifest(changed, config, id), /database_mismatch/);
});

test('failed capture resumes exactly the previously running writers in reverse order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-operations-pause-'));
  try {
    const calls = [], config = { directories: { status: directory }, tools: { systemctl: 'systemctl' }, backup: { maxPauseSeconds: 30, writers: [
      { kind: 'systemd', name: 'api.service' }, { kind: 'systemd', name: 'worker.service' }, { kind: 'systemd', name: 'inactive.service' }
    ] } };
    const run = async (_file, args) => {
      if (args[0] === 'show') return { code: 0, stdout: args.at(-1) === 'inactive.service' ? 'inactive\n' : 'active\n' };
      calls.push(args.join(' ')); return { code: 0, stdout: '' };
    };
    await assert.rejects(quiesce(config, async () => { throw new Error('capture_failed'); }, run), /capture_failed/);
    assert.deepEqual(calls, ['stop api.service', 'stop worker.service', 'start worker.service', 'start api.service']);
    await assert.rejects(readFile(join(directory, 'paused-writers.json')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('a lost stop acknowledgement still resumes that writer and never enters file capture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-operations-pause-'));
  try {
    const calls = [], config = { directories: { status: directory }, tools: { systemctl: 'systemctl' }, backup: { maxPauseSeconds: 30, writers: [{ kind: 'systemd', name: 'api.service' }] } };
    let captured = false;
    const run = async (_file, args) => {
      if (args[0] === 'show') return { code: 0, stdout: 'active\n' };
      calls.push(args.join(' '));
      if (args[0] === 'stop') throw new Error('lost_ack');
      return { code: 0, stdout: '' };
    };
    await assert.rejects(quiesce(config, async () => { captured = true; }, run), /lost_ack/);
    assert.equal(captured, false); assert.deepEqual(calls, ['stop api.service', 'start api.service']);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});
