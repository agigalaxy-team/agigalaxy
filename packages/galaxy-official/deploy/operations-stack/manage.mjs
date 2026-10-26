#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, lstat, chown } from 'node:fs/promises';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { operationsConfiguration, readOperationsConfiguration, configurationNeeds, requireConfiguration, beneath } from './configuration.mjs';
import { renderOperationsFiles, postgresOverlay, sourceDirectory } from './render.mjs';
import { assertTarget, runCommand, ensureDirectory, atomicWrite, noSymlinkPath, inspectPostgres, resumePausedWriters } from './host.mjs';
import { createProductBackup, restoreProductBackup, restoreDatabaseAtTime, initializeRestic, applyResticRetention } from './backup.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
const marker = '# Managed by Galaxy operations-stack v1\n';

export function operationsPlan(config) {
  return {
    version: 1, targetHostname: config.targetHostname,
    services: [
      { name: 'grafana', image: config.images.grafana, url: config.grafana.rootUrl, listen: '127.0.0.1:' + config.grafana.port, memoryMiB: 512, issuer: config.grafana.issuer },
      { name: 'loki', image: config.images.loki, listen: '127.0.0.1:' + config.loki.port, memoryMiB: 768, retentionDays: config.loki.retentionDays },
      { name: 'alloy', image: config.images.alloy, listen: '127.0.0.1:' + config.alloy.port, memoryMiB: 192, fileInputs: config.logs, journalInputs: config.journals, dockerInputs: config.dockerLogs, requestId: 'structured-metadata' }
    ],
    metrics: { mode: config.monitoring.mode, prometheus: config.monitoring.prometheusUrl, alertmanager: config.monitoring.alertmanagerUrl, api: config.monitoring.apiTarget, worker: config.monitoring.workerTarget,
      receiverConfigurationFile: config.monitoring.receiverConfigurationFile, inheritedRules: ['docs/operations/examples/alerts/galaxy.rules.json', 'docs/operations/examples/monitoring/external.rules.json'] },
    writes: { configuration: config.directories.configuration, data: config.directories.data, systemdUnits: ['galaxy-operations.service', 'galaxy-operations-backup.service', 'galaxy-operations-backup.timer', ...(config.dockerLogs.length ? ['galaxy-component-logs.service'] : []), ...(config.monitoring.mode === 'managed' ? ['galaxy-prometheus.service', 'galaxy-alertmanager.service', 'galaxy-blackbox-exporter.service'] : [])] },
    pitr: config.postgres.map(pg => ({ stanza: pg.id, container: pg.container, composeFile: pg.composeFile, projectName: pg.projectName, service: pg.service, database: pg.database,
      dataPath: pg.dataPath, repository: pg.repository, cipherReference: pg.cipherFile, archiveMode: 'enable-on-explicit-activate-pitr', image: config.images.postgresBackup })),
    backup: { type: 'weekly-full-daily-differential', sources: config.backup.sources, pausedWriters: config.backup.writers, pauseLimitSeconds: config.backup.maxPauseSeconds,
      captureDirectory: config.directories.captures, repositoryReference: config.backup.repositoryFile, passwordReference: config.backup.passwordFile, retention: config.backup.retention,
      statusDirectory: config.directories.status, restoreRoot: config.directories.restores, restoreNetwork: 'none', publicRestore: false,
      keycloakRealmsRequiringLogoutBeforeActivation: config.backup.keycloakRealms },
    configure: Object.fromEntries(['monitoring', 'pitr', 'backup', 'restore'].map(feature => [feature, configurationNeeds(config, feature)])),
    apiEnvironment: { GALAXY_BACKUP_STATUS_DIRECTORY: config.directories.status, GALAXY_METRICS_BACKUP_ACTIONS: 'create', GALAXY_METRICS_PORT: config.monitoring.apiTarget?.split(':')[1] ?? null },
    workerEnvironment: { GALAXY_METRICS_PORT: config.monitoring.workerTarget?.split(':')[1] ?? null }
  };
}

async function monitoringUser(config, run) {
  const name = config.monitoring.serviceUser;
  let user = await run('/usr/bin/getent', ['passwd', name], { accepted: [0, 2], maxOutput: 2048 });
  if (user.code === 2) {
    await run('/usr/sbin/useradd', ['--system', '--no-create-home', '--home-dir', config.directories.data, '--shell', '/usr/sbin/nologin', '--user-group', name]);
    user = await run('/usr/bin/getent', ['passwd', name], { maxOutput: 2048 });
  }
  const fields = user.stdout.trim().split(':');
  const uid = Number(fields[2]), gid = Number(fields[3]);
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) throw new Error('operations_monitor_user_invalid');
  return { uid, gid };
}
export async function prepareOperations(config, { run = runCommand } = {}) {
  requireConfiguration(config, 'monitoring');
  const root = config.directories.configuration;
  await noSymlinkPath(root);
  let present = [];
  try { present = await readdir(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (present.length && !present.includes('.galaxy-operations')) throw new Error('operations_configuration_directory_not_owned');
  await ensureDirectory(root, { mode: 0o755 });
  await atomicWrite(root + '/.galaxy-operations', '1\n');
  const files = await renderOperationsFiles(config);
  for (const [relative, content] of Object.entries(files)) {
    const target = root + '/' + relative;
    if (!beneath(root, target)) throw new Error('operations_output_path_invalid');
    await mkdir(posix.dirname(target), { recursive: true, mode: 0o755 });
    await atomicWrite(target, content, 0o644);
  }
  await atomicWrite(root + '/configuration.json', json(config));
  await ensureDirectory(config.directories.data, { mode: 0o755 });
  for (const [directory, uid, gid] of [['grafana', 472, 472], ['loki', 10001, 10001], ['alloy', 0, 0]]) await ensureDirectory(config.directories.data + '/' + directory, { uid, gid });
  if (config.dockerLogs.length) await ensureDirectory(config.directories.data + '/component-logs', { mode: 0o700 });
  if (config.journals.length) {
    // Empty journal directories are harmless; bind creation is deliberate,
    // rather than Docker accidentally creating a file at the wrong path.
    for (const directory of ['/var/log/journal', '/run/log/journal']) await ensureDirectory(directory, { mode: 0o755 });
  }
  if (config.monitoring.mode === 'managed') {
    const user = await monitoringUser(config, run);
    for (const directory of [config.monitoring.prometheusData, config.monitoring.alertmanagerData]) await ensureDirectory(directory, user);
  }
  return { state: 'prepared', configuration: root, caddyFragment: root + '/caddy-monitoring.fragment', started: false };
}
export async function installUnits(config, run = runCommand) {
  requireConfiguration(config, 'monitoring');
  const files = await renderOperationsFiles(config), installed = [];
  for (const [relative, content] of Object.entries(files).filter(([name]) => name.startsWith('systemd/'))) {
    const target = '/etc/systemd/system/' + posix.basename(relative);
    try { if (!(await readFile(target, 'utf8')).startsWith(marker)) throw new Error('operations_unrelated_unit_exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await atomicWrite(target, marker + content, 0o644); installed.push(posix.basename(target));
  }
  await run(config.tools.systemctl, ['daemon-reload']);
  return { state: 'installed', units: installed, started: false };
}
export async function startOperations(config, run = runCommand) {
  requireConfiguration(config, 'monitoring');
  const units = [...(config.dockerLogs.length ? ['galaxy-component-logs.service'] : []), 'galaxy-operations.service', ...(config.monitoring.mode === 'managed' ? ['galaxy-prometheus.service', 'galaxy-alertmanager.service', 'galaxy-blackbox-exporter.service'] : [])];
  await run(config.tools.systemctl, ['enable', '--now', ...units], { timeout: 300000 });
  return { state: 'started', units, grafana: config.grafana.rootUrl, backupTimerEnabled: false };
}

export async function preparePitr(config, run = runCommand) {
  requireConfiguration(config, 'pitr');
  const discovered = structuredClone(config);
  for (const pg of discovered.postgres) {
    const metadata = await inspectPostgres(config, pg, run);
    const labels = (await run(config.tools.docker, ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}', pg.container])).stdout.trim().split('|');
    if (labels[0] !== pg.projectName || labels[1] !== pg.service) throw new Error('operations_compose_target_mismatch');
    const [uid, gid, command] = await Promise.all([
      run(config.tools.docker, ['exec', '--user', 'postgres', pg.container, 'id', '-u']),
      run(config.tools.docker, ['exec', '--user', 'postgres', pg.container, 'id', '-g']),
      run(config.tools.docker, ['inspect', '--format', '{{json .Config.Cmd}}', pg.container])
    ]);
    pg.uid = Number(uid.stdout.trim()); pg.gid = Number(gid.stdout.trim());
    pg.systemIdentifier = metadata.systemIdentifier;
    pg.serverCommand = JSON.parse(command.stdout);
  }
  const ready = operationsConfiguration(discovered), root = ready.directories.configuration;
  // All generated configuration is public topology; credential values remain
  // exclusively in the referenced host files and child-process environment.
  const files = await renderOperationsFiles(ready);
  for (const [relative, value] of Object.entries(files).filter(([name]) => name.startsWith('postgres/'))) {
    await mkdir(posix.dirname(root + '/' + relative), { recursive: true, mode: 0o755 });
    await atomicWrite(root + '/' + relative, value, 0o644);
  }
  for (const pg of ready.postgres) await ensureDirectory(pg.repository, { uid: pg.uid, gid: pg.gid });
  await atomicWrite(root + '/configuration.json', json(ready));
  return { state: 'prepared', configuration: root + '/configuration.json', activated: false };
}
function volumeTarget(value) {
  if (typeof value === 'string') return value.split(':')[1];
  if (value && typeof value.target === 'string') return value.target;
  throw new Error('operations_compose_volume_invalid');
}
export function mergePostgresService(original, overlay) {
  const replace = new Set(overlay.volumes.map(volumeTarget));
  const tmpfsReplace = new Set(overlay.tmpfs.map(value => value.split(':')[0]));
  return { ...original, image: overlay.image, command: overlay.command,
    volumes: [...(original.volumes ?? []).filter(value => !replace.has(volumeTarget(value))), ...overlay.volumes],
    tmpfs: [...(original.tmpfs ?? []).filter(value => !tmpfsReplace.has(value.split(':')[0])), ...overlay.tmpfs] };
}
async function waitForPostgres(config, pg, run) {
  const deadline = Date.now() + 120000;
  while (true) {
    try {
      return await inspectPostgres(config, pg, (file, args, options) => run(file, args, { ...options, timeout: 5000 }));
    } catch (error) {
      if (!['operations_command_failed', 'operations_command_timed_out'].includes(error.message) || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}
export async function activatePitr(config, run = runCommand) {
  requireConfiguration(config, 'backup');
  const activated = [];
  for (const pg of config.postgres) {
    await inspectPostgres(config, pg, run);
    const labels = (await run(config.tools.docker, ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}', pg.container])).stdout.trim();
    if (labels !== pg.projectName + '|' + pg.service) throw new Error('operations_compose_target_mismatch');
    await noSymlinkPath(pg.composeFile);
    const info = await lstat(pg.composeFile), original = JSON.parse(await readFile(pg.composeFile, 'utf8'));
    if (!original.services?.[pg.service] || original.name && original.name !== pg.projectName) throw new Error('operations_compose_service_missing');
    const before = config.directories.configuration + '/postgres/' + pg.id + '/compose.before-pitr.json';
    try { await writeFile(before, json(original), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const overlay = postgresOverlay(config, pg).services[pg.service];
    original.services[pg.service] = mergePostgresService(original.services[pg.service], overlay);
    // Persist into the exact existing JSON compose file so its original boot
    // unit keeps the backup image, mounts and archive settings after reboot.
    await atomicWrite(pg.composeFile, json(original), info.mode & 0o777);
    await chown(pg.composeFile, info.uid, info.gid);
    await run(config.tools.docker, ['compose', '--project-name', pg.projectName, '--project-directory', posix.dirname(pg.composeFile), '-f', pg.composeFile, 'up', '-d', '--no-deps', pg.service], { timeout: 300000 });
    await waitForPostgres(config, pg, run);
    await run(config.tools.docker, ['exec', '--user', 'postgres', pg.container, '/usr/local/bin/galaxy-pgbackrest', '--stanza=' + pg.id, 'stanza-create']);
    await run(config.tools.docker, ['exec', '--user', 'postgres', pg.container, '/usr/local/bin/galaxy-pgbackrest', '--stanza=' + pg.id, 'check'], { timeout: 300000 });
    activated.push(pg.id);
  }
  return { state: 'activated', stanzas: activated, backupCreated: false };
}
function argumentsFor(argv) {
  const [action, ...rest] = argv, values = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!/^--[a-z][a-z-]*$/.test(rest[index] ?? '') || !rest[index + 1] || rest[index + 1].startsWith('--')) throw new Error('operations_arguments_invalid');
    const key = rest[index].slice(2);
    if (values[key] !== undefined) throw new Error('operations_argument_repeated');
    values[key] = rest[index + 1];
  }
  if (!values.config) throw new Error('operations_config_required');
  return { action, values };
}
export async function main(argv = process.argv.slice(2)) {
  const { action, values } = argumentsFor(argv), config = await readOperationsConfiguration(values.config);
  if (action === 'plan') return operationsPlan(config);
  assertTarget(config);
  switch (action) {
    case 'prepare': return prepareOperations(config);
    case 'install-units': return installUnits(config);
    case 'up': return startOperations(config);
    case 'stop': await runCommand(config.tools.systemctl, ['stop', 'galaxy-operations.service']); return { state: 'stopped', dataPreserved: true };
    case 'build-postgres':
      await runCommand(config.tools.docker, ['build', '--build-arg', 'POSTGRES_BASE_IMAGE=' + config.images.postgresBase, '--tag', config.images.postgresBackup, sourceDirectory + 'postgres'], { timeout: 3600000 });
      return { state: 'built', image: config.images.postgresBackup };
    case 'prepare-pitr': return preparePitr(config);
    case 'activate-pitr': return activatePitr(config);
    case 'repository-init': return initializeRestic(config);
    case 'backup': return createProductBackup(config, { type: values.type ?? 'auto' });
    case 'retention': return applyResticRetention(config);
    case 'resume-writers': return resumePausedWriters(config);
    case 'restore':
      if (!values.receipt || !values.directory) throw new Error('operations_restore_target_required');
      return restoreProductBackup(config, { receipt: JSON.parse(await readFile(values.receipt, 'utf8')), directory: values.directory });
    case 'restore-database':
      if (!values.stanza || !values.at || !values.directory) throw new Error('operations_pitr_target_required');
      return restoreDatabaseAtTime(config, { stanza: values.stanza, at: values.at, directory: values.directory });
    default: throw new Error('operations_action_unknown');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => process.stdout.write(json(result))).catch(error => {
    const code = /^operations_[a-z_]+$/.test(error.message) ? error.message : 'operations_action_failed';
    process.stderr.write(json({ error: code, sourceId: error.sourceId ?? null, configure: error.configure ?? [], command: error.command ?? null, exitCode: error.exitCode ?? null, writers: error.writers ?? [] }));
    process.exitCode = 1;
  });
}
