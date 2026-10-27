import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const text = (value, name, max = 4096) => {
  if (typeof value !== 'string' || !value || value.length > max || /[\p{Cc}\uFEFF]/u.test(value)) throw new Error(`Invalid ${name}`);
  return value;
};
export function absolutePath(value, name = 'path') {
  text(value, name);
  if (!value.startsWith('/') || value === '/' || posix.normalize(value) !== value || value.includes('\\')) throw new Error(`Invalid ${name}`);
  return value;
}
export function beneath(root, target) {
  return target !== root && target.startsWith(root + '/') && posix.normalize(target) === target;
}
function optionalPath(value, name) { return value == null ? null : absolutePath(value, name); }
function name(value, field) {
  text(value, field, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@+-]*$/.test(value)) throw new Error(`Invalid ${field}`);
  return value;
}
function integer(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${field}`);
  return value;
}
function loopbackUrl(value, field) {
  const url = new URL(text(value, field));
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) throw new Error(`Invalid ${field}`);
  return url.href.replace(/\/$/, '');
}
function httpsUrl(value, field) {
  const url = new URL(text(value, field));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(`Invalid ${field}`);
  return url.href;
}
function target(value, field) {
  if (value == null) return null;
  if (!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value) || Number(value.split(':')[1]) > 65535) throw new Error(`Invalid ${field}`);
  return value;
}
function image(value, field) {
  text(value, field, 300);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./_:@-]+$/.test(value) || (!value.includes(':') && !value.includes('@'))) throw new Error(`Versioned image required: ${field}`);
  return value;
}

// This file contains references and topology only. It never reads credential files.
export function operationsConfiguration(input) {
  if (!input || input.version !== 1) throw new Error('operations configuration version 1 required');
  const dirs = input.directories ?? {}, monitoring = input.monitoring ?? {}, grafana = input.grafana ?? {}, backup = input.backup ?? {};
  const configuration = {
    version: 1,
    targetHostname: input.targetHostname == null ? null : name(input.targetHostname, 'targetHostname'),
    projectName: name(input.projectName ?? 'galaxy-operations', 'projectName'),
    environment: name(input.environment ?? 'production', 'environment'),
    directories: Object.fromEntries(Object.entries({
      configuration: dirs.configuration ?? '/etc/galaxy/operations', data: dirs.data ?? '/var/lib/galaxy/operations',
      captures: dirs.captures ?? '/var/lib/galaxy/backups/operations-staging', restores: dirs.restores ?? '/var/lib/galaxy/restores',
      status: dirs.status ?? '/var/lib/galaxy/backup-status/operations'
    }).map(([key, value]) => [key, absolutePath(value, `directories.${key}`)])),
    tools: {
      docker: absolutePath(input.tools?.docker ?? '/usr/bin/docker'), systemctl: absolutePath(input.tools?.systemctl ?? '/usr/bin/systemctl'),
      node: absolutePath(input.tools?.node ?? '/opt/galaxy/runtime/node-v24.19.0-linux-x64/bin/node'),
      restic: optionalPath(input.tools?.restic, 'tools.restic'),
      stackDirectory: optionalPath(input.tools?.stackDirectory ?? (process.platform === 'linux' ? posix.dirname(fileURLToPath(import.meta.url)) : null), 'tools.stackDirectory')
    },
    images: {
      grafana: image(input.images?.grafana ?? 'grafana/grafana:13.2.4', 'images.grafana'),
      loki: image(input.images?.loki ?? 'grafana/loki:3.7.8', 'images.loki'),
      alloy: image(input.images?.alloy ?? 'grafana/alloy:v1.21.0', 'images.alloy'),
      postgresBase: image(input.images?.postgresBase ?? 'postgres:18.6', 'images.postgresBase'),
      postgresBackup: image(input.images?.postgresBackup ?? 'galaxy-postgres-pgbackrest:18.6-2.60.0', 'images.postgresBackup')
    },
    grafana: {
      rootUrl: httpsUrl(grafana.rootUrl ?? 'https://admin.agigalaxy.org/monitoring/', 'grafana.rootUrl'),
      issuer: httpsUrl(grafana.issuer ?? 'https://admin.agigalaxy.org/realms/galaxy-operations', 'grafana.issuer').replace(/\/$/, ''),
      clientId: name(grafana.clientId ?? 'galaxy-operations-grafana', 'grafana.clientId'),
      roleSource: grafana.roleSource ?? 'client',
      clientSecretFile: optionalPath(grafana.clientSecretFile, 'grafana.clientSecretFile'),
      secretKeyFile: optionalPath(grafana.secretKeyFile, 'grafana.secretKeyFile'),
      bootstrapPasswordFile: optionalPath(grafana.bootstrapPasswordFile, 'grafana.bootstrapPasswordFile'),
      port: integer(grafana.port ?? 13000, 'grafana.port', 1024, 65535),
      roles: Object.fromEntries(['viewer', 'editor', 'admin'].map(role => [role, name(grafana.roles?.[role] ?? `galaxy-monitoring-${role}`, `grafana.roles.${role}`)]))
    },
    monitoring: {
      mode: monitoring.mode ?? 'existing',
      prometheusUrl: loopbackUrl(monitoring.prometheusUrl ?? 'http://127.0.0.1:9090', 'monitoring.prometheusUrl'),
      alertmanagerUrl: loopbackUrl(monitoring.alertmanagerUrl ?? 'http://127.0.0.1:9093', 'monitoring.alertmanagerUrl'),
      blackboxTarget: target(monitoring.blackboxTarget ?? '127.0.0.1:9115', 'monitoring.blackboxTarget'),
      apiTarget: target(monitoring.apiTarget, 'monitoring.apiTarget'), workerTarget: target(monitoring.workerTarget, 'monitoring.workerTarget'),
      prometheusBinary: optionalPath(monitoring.prometheusBinary, 'monitoring.prometheusBinary'),
      alertmanagerBinary: optionalPath(monitoring.alertmanagerBinary, 'monitoring.alertmanagerBinary'),
      blackboxBinary: optionalPath(monitoring.blackboxBinary, 'monitoring.blackboxBinary'),
      prometheusData: absolutePath(monitoring.prometheusData ?? '/var/lib/galaxy/prometheus', 'monitoring.prometheusData'),
      alertmanagerData: absolutePath(monitoring.alertmanagerData ?? '/var/lib/galaxy/operations/alertmanager', 'monitoring.alertmanagerData'),
      serviceUser: name(monitoring.serviceUser ?? 'galaxy-monitoring', 'monitoring.serviceUser'),
      receiverConfigurationFile: optionalPath(monitoring.receiverConfigurationFile, 'monitoring.receiverConfigurationFile'),
      websiteUnit: monitoring.websiteUnit===undefined?undefined:name(monitoring.websiteUnit, 'monitoring.websiteUnit'),
      website: httpsUrl(monitoring.website ?? 'https://agigalaxy.org/', 'monitoring.website'),
      liveness: httpsUrl(monitoring.liveness ?? 'https://official.agigalaxy.org/healthz', 'monitoring.liveness'),
      readiness: httpsUrl(monitoring.readiness ?? 'https://official.agigalaxy.org/readyz', 'monitoring.readiness')
    },
    logs: (input.logs ?? []).map((entry, index) => ({ component: name(entry.component, `logs.${index}.component`), path: absolutePath(entry.path, `logs.${index}.path`), release: name(entry.release ?? 'unreported', `logs.${index}.release`) })),
    journals: (input.journals ?? []).map((entry, index) => ({ component: name(entry.component, `journals.${index}.component`), unit: name(entry.unit, `journals.${index}.unit`), release: name(entry.release ?? 'unreported', `journals.${index}.release`) })),
    dockerLogs: (input.dockerLogs ?? []).map((entry, index) => ({ component: name(entry.component, `dockerLogs.${index}.component`), container: name(entry.container, `dockerLogs.${index}.container`), release: name(entry.release ?? 'unreported', `dockerLogs.${index}.release`) })),
    logCollection: {
      maxFileBytes: integer(input.logCollection?.maxFileBytes ?? 10485760, 'logCollection.maxFileBytes', 1048576, 104857600),
      files: integer(input.logCollection?.files ?? 3, 'logCollection.files', 2, 10),
      journalMaxAgeHours: integer(input.logCollection?.journalMaxAgeHours ?? 24, 'logCollection.journalMaxAgeHours', 1, 168)
    },
    loki: { port: integer(input.loki?.port ?? 13100, 'loki.port', 1024, 65535), grpcPort: integer(input.loki?.grpcPort ?? 19095, 'loki.grpcPort', 1024, 65535), retentionDays: integer(input.loki?.retentionDays ?? 7, 'loki.retentionDays', 1, 90) },
    alloy: { port: integer(input.alloy?.port ?? 12345, 'alloy.port', 1024, 65535) },
    postgres: (input.postgres ?? []).map((entry, index) => ({
      id: name(entry.id, `postgres.${index}.id`), container: name(entry.container, `postgres.${index}.container`),
      projectName: name(entry.projectName ?? entry.container.replace(/-database-1$/, ''), `postgres.${index}.projectName`),
      composeFile: optionalPath(entry.composeFile, `postgres.${index}.composeFile`), service: name(entry.service ?? 'database', `postgres.${index}.service`),
      dataPath: optionalPath(entry.dataPath, `postgres.${index}.dataPath`),
      socketPath: absolutePath(entry.socketPath ?? '/var/run/postgresql', `postgres.${index}.socketPath`),
      administrator: entry.administrator == null ? null : name(entry.administrator, `postgres.${index}.administrator`),
      database: entry.database == null ? null : name(entry.database, `postgres.${index}.database`),
      systemIdentifier: entry.systemIdentifier == null ? null : text(entry.systemIdentifier, `postgres.${index}.systemIdentifier`, 24),
      uid: entry.uid == null ? null : integer(entry.uid, `postgres.${index}.uid`, 1, 2147483647),
      gid: entry.gid == null ? null : integer(entry.gid, `postgres.${index}.gid`, 1, 2147483647),
      serverCommand: entry.serverCommand == null ? null : entry.serverCommand.map(value => text(value, `postgres.${index}.serverCommand`, 1024)),
      repository: absolutePath(entry.repository, `postgres.${index}.repository`),
      cipherFile: optionalPath(entry.cipherFile, `postgres.${index}.cipherFile`),
      retentionFull: integer(entry.retentionFull ?? 2, `postgres.${index}.retentionFull`, 2, 52)
    })),
    backup: {
      repositoryFile: optionalPath(backup.repositoryFile, 'backup.repositoryFile'), passwordFile: optionalPath(backup.passwordFile, 'backup.passwordFile'),
      credentialEnvironmentFile: optionalPath(backup.credentialEnvironmentFile, 'backup.credentialEnvironmentFile'),
      resticHost: name(backup.resticHost ?? 'galaxy-production', 'backup.resticHost'),
      minimumFreeBytes: integer(backup.minimumFreeBytes ?? 34359738368, 'backup.minimumFreeBytes', 0, Number.MAX_SAFE_INTEGER),
      maxCaptureBytes: integer(backup.maxCaptureBytes ?? 107374182400, 'backup.maxCaptureBytes', 1048576, Number.MAX_SAFE_INTEGER),
      maxPauseSeconds: integer(backup.maxPauseSeconds ?? 180, 'backup.maxPauseSeconds', 30, 1800),
      retention: { daily: integer(backup.retention?.daily ?? 1, 'backup.retention.daily', 1, 365), weekly: integer(backup.retention?.weekly ?? 4, 'backup.retention.weekly', 1, 104), monthly: integer(backup.retention?.monthly ?? 1, 'backup.retention.monthly', 1, 120) },
      statusGroupId: backup.statusGroupId == null ? null : integer(backup.statusGroupId, 'backup.statusGroupId', 0, 2147483647),
      calendar: text(backup.calendar ?? 'Sun *-*-* 03:15:00 UTC', 'backup.calendar', 100),
      keycloakRealms: (backup.keycloakRealms ?? ['galaxy', 'galaxy-operations']).map(realm => name(realm, 'backup.keycloakRealms')),
      writers: (backup.writers ?? []).map((entry, index) => ({ kind: entry.kind, name: name(entry.name, `backup.writers.${index}.name`) })),
      sources: (backup.sources ?? []).map((entry, index) => ({ id: name(entry.id, `backup.sources.${index}.id`), path: absolutePath(entry.path, `backup.sources.${index}.path`), kind: entry.kind ?? 'tree', optional: entry.optional === true }))
    }
  };
  if (!['existing', 'managed'].includes(configuration.monitoring.mode)) throw new Error('monitoring.mode must be existing or managed');
  if (!['client', 'realm'].includes(configuration.grafana.roleSource)) throw new Error('grafana.roleSource must be client or realm');
  if (!/^[a-z][a-z0-9_-]{0,30}$/.test(configuration.monitoring.serviceUser)) throw new Error('Invalid monitoring service user');
  if (new URL(configuration.grafana.rootUrl).pathname !== '/monitoring/') throw new Error('Grafana rootUrl must end with /monitoring/');
  if (new Set(Object.values(configuration.directories)).size !== 5) throw new Error('Operations directories must be separate');
  if (configuration.journals.some(log => !log.unit.endsWith('.service'))) throw new Error('Journal sources must name exact service units');
  if (new Set(configuration.dockerLogs.map(log => log.container)).size !== configuration.dockerLogs.length) throw new Error('Docker log sources must name distinct exact containers');
  if (new Set(configuration.dockerLogs.map(log => log.component)).size !== configuration.dockerLogs.length) throw new Error('Docker log components must be distinct');
  if (new Set(configuration.postgres.map(pg => pg.id)).size !== configuration.postgres.length) throw new Error('PostgreSQL stanza names must be unique');
  if (new Set(configuration.backup.sources.map(source => source.id)).size !== configuration.backup.sources.length) throw new Error('Backup source names must be unique');
  for (const pg of configuration.postgres) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(pg.id)) throw new Error('Invalid PostgreSQL stanza name');
    if (pg.systemIdentifier !== null && !/^[1-9][0-9]{10,23}$/.test(pg.systemIdentifier)) throw new Error('Invalid PostgreSQL system identifier');
    if (pg.serverCommand !== null && pg.serverCommand[0] !== 'postgres') throw new Error('serverCommand must preserve the current postgres command');
    if (pg.dataPath !== null && !beneath('/var/lib/postgresql', pg.dataPath)) throw new Error('PostgreSQL dataPath must be the actual cluster below /var/lib/postgresql');
  }
  for (const writer of configuration.backup.writers) if (!['systemd', 'container'].includes(writer.kind)) throw new Error('Unknown backup writer kind');
  for (const source of configuration.backup.sources) {
    if (!['tree', 'file'].includes(source.kind)) throw new Error('Unknown backup source kind');
    if ([configuration.directories.captures, configuration.directories.restores].some(dir => source.path === dir || beneath(source.path, dir) || beneath(dir, source.path))) throw new Error('A backup source cannot contain staging or restore directories');
  }
  return configuration;
}

export function configurationNeeds(config, feature) {
  const needs = [];
  const requireValue = (value, field) => { if (value == null || value === '') needs.push(field); };
  requireValue(config.targetHostname, 'targetHostname');
  if (feature === 'monitoring') {
    for (const key of ['clientSecretFile', 'secretKeyFile', 'bootstrapPasswordFile']) requireValue(config.grafana[key], `grafana.${key}`);
    for (const key of ['apiTarget', 'workerTarget']) requireValue(config.monitoring[key], `monitoring.${key}`);
    if (!config.logs.length && !config.journals.length && !config.dockerLogs.length) needs.push('logs, journals or dockerLogs');
    if (config.monitoring.mode === 'managed') for (const key of ['prometheusBinary', 'alertmanagerBinary', 'blackboxBinary', 'receiverConfigurationFile']) requireValue(config.monitoring[key], `monitoring.${key}`);
  }
  if (feature === 'pitr' || feature === 'backup' || feature === 'restore') {
    if (!config.postgres.length) needs.push('postgres');
    for (const pg of config.postgres) {
      for (const key of ['composeFile', 'dataPath', 'administrator', 'database', 'cipherFile']) requireValue(pg[key], `postgres.${pg.id}.${key}`);
      if (feature !== 'pitr') for (const key of ['systemIdentifier', 'uid', 'gid', 'serverCommand']) requireValue(pg[key], `postgres.${pg.id}.${key}`);
    }
  }
  if (feature === 'backup' || feature === 'restore') {
    requireValue(config.tools.restic, 'tools.restic');
    for (const key of ['repositoryFile', 'passwordFile']) requireValue(config.backup[key], `backup.${key}`);
    if (feature === 'backup' && !config.backup.sources.length) needs.push('backup.sources');
    if (feature === 'backup' && !config.backup.writers.length) needs.push('backup.writers');
  }
  return needs;
}
export function requireConfiguration(config, feature) {
  const missing = configurationNeeds(config, feature);
  if (missing.length) throw Object.assign(new Error('operations_configuration_incomplete'), { configure: missing });
}
export async function readOperationsConfiguration(path) {
  return operationsConfiguration(JSON.parse(await readFile(path, 'utf8')));
}
