import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';
import { renderEmailLayout, renderGalaxyEmail, officialMailIdentity } from '../../../galaxy-mail/src/layout.mjs';
import { alloyConfiguration, logFileSources, loggingDashboard } from './log-pipeline.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
const bind = (source, target, readOnly = true) => ({ type: 'bind', source, target, read_only: readOnly, bind: { create_host_path: false } });
const q = value => JSON.stringify(value);
const command = values => values.map(value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"').join(' ');
export const sourceDirectory = fileURLToPath(new URL('.', import.meta.url));
const repositoryDocs = new URL('../../../../docs/', import.meta.url);

export function grafanaIni(config) {
  const g = config.grafana;
  const rolePath = g.roleSource === 'realm' ? 'realm_access.roles' : 'resource_access.' + JSON.stringify(g.clientId) + '.roles';
  const roleExpression = `contains(${rolePath} || \`[]\`, '${g.roles.admin}') && 'Admin' || contains(${rolePath} || \`[]\`, '${g.roles.editor}') && 'Editor' || contains(${rolePath} || \`[]\`, '${g.roles.viewer}') && 'Viewer' || ''`;
  return `[server]
http_addr = 127.0.0.1
http_port = ${g.port}
root_url = ${g.rootUrl}
serve_from_sub_path = true
[security]
secret_key = $__file{/run/secrets/grafana_secret_key}
admin_user = local-recovery-admin
admin_password = $__file{/run/secrets/grafana_bootstrap_password}
cookie_secure = true
cookie_samesite = lax
disable_gravatar = true
[users]
allow_sign_up = false
allow_org_create = false
[auth]
disable_login_form = true
disable_signout_menu = false
[auth.anonymous]
enabled = false
[auth.basic]
enabled = false
[auth.generic_oauth]
enabled = true
name = AGI Galaxy
allow_sign_up = true
client_id = ${g.clientId}
client_secret = $__file{/run/secrets/grafana_oauth_client_secret}
scopes = openid profile email
auth_url = ${g.issuer}/protocol/openid-connect/auth
token_url = ${g.issuer}/protocol/openid-connect/token
api_url = ${g.issuer}/protocol/openid-connect/userinfo
jwk_set_url = ${g.issuer}/protocol/openid-connect/certs
validate_id_token = true
use_pkce = true
use_refresh_token = false
login_attribute_path = preferred_username
role_attribute_path = ${roleExpression}
role_attribute_strict = true
allow_assign_grafana_admin = false
skip_org_role_sync = false
[analytics]
reporting_enabled = false
check_for_updates = false
[log]
mode = console
level = warn
[dashboards]
default_home_dashboard_path = /etc/grafana/dashboards/galaxy-operations.json
`;
}

export function grafanaClientContract(config) {
  const g = config.grafana;
  const realmRoles = g.roleSource === 'realm';
  const roles = [...new Set(Object.values(g.roles))];
  return {
    realm: new URL(g.issuer).pathname.split('/').at(-1),
    client: {
      clientId: g.clientId, name: 'Galaxy monitoring', protocol: 'openid-connect', enabled: true,
      publicClient: false, clientAuthenticatorType: 'client-secret', standardFlowEnabled: true,
      directAccessGrantsEnabled: false, implicitFlowEnabled: false, serviceAccountsEnabled: false,
      fullScopeAllowed: false, redirectUris: [g.rootUrl + 'login/generic_oauth'], webOrigins: [],
      defaultClientScopes: ['profile', 'email'], attributes: { 'pkce.code.challenge.method': 'S256' },
      protocolMappers: [{ name: realmRoles ? 'monitoring-realm-roles' : 'monitoring-client-roles', protocol: 'openid-connect', protocolMapper: realmRoles ? 'oidc-usermodel-realm-role-mapper' : 'oidc-usermodel-client-role-mapper', consentRequired: false,
        config: { ...(realmRoles ? { 'usermodel.realmRoleMapping.rolePrefix': '' } : { 'usermodel.clientRoleMapping.clientId': g.clientId, 'usermodel.clientRoleMapping.rolePrefix': '' }), 'claim.name': realmRoles ? 'realm_access.roles' : `resource_access.${g.clientId}.roles`,
          'jsonType.label': 'String', multivalued: 'true', 'id.token.claim': 'true', 'access.token.claim': 'false', 'userinfo.token.claim': 'false', 'introspection.token.claim': 'false' } }]
    },
    ...(realmRoles ? { realmRoles: roles.map(name => ({ name })), realmRoleScopeMappings: roles } : { clientRoles: roles.map(name => ({ name })), clientRoleScopeMappings: roles }),
    clientSecretReference: g.clientSecretFile,
    roleAssignment: 'Explicit configured roles in the independent management realm only; no ordinary-account mappings.'
  };
}

export function lokiConfiguration(config) {
  return {
    auth_enabled: false,
    server: { http_listen_address: '127.0.0.1', http_listen_port: config.loki.port, grpc_listen_address: '127.0.0.1', grpc_listen_port: config.loki.grpcPort, log_level: 'warn' },
    common: { path_prefix: '/loki', instance_addr: '127.0.0.1', replication_factor: 1, ring: { instance_addr: '127.0.0.1', kvstore: { store: 'inmemory' } } },
    schema_config: { configs: [{ from: '2026-10-01', store: 'tsdb', object_store: 'filesystem', schema: 'v13', index: { prefix: 'galaxy_', period: '24h' } }] },
    storage_config: { filesystem: { directory: '/loki/chunks' } },
    compactor: { working_directory: '/loki/compactor', compaction_interval: '10m', retention_enabled: true, retention_delete_delay: '2h', retention_delete_worker_count: 2, delete_request_store: 'filesystem' },
    limits_config: { retention_period: `${config.loki.retentionDays * 24}h`, ingestion_rate_mb: 2, ingestion_burst_size_mb: 4, max_query_parallelism: 4, max_entries_limit_per_query: 2000, max_query_series: 500, allow_structured_metadata: true },
    ingester: { chunk_idle_period: '10m', max_chunk_age: '1h' },
    querier: { max_concurrent: 2 }, analytics: { reporting_enabled: false }
  };
}

export { alloyConfiguration } from './log-pipeline.mjs';

export function operationsCompose(config) {
  const root = config.directories.configuration, data = config.directories.data;
  const logging = { driver: 'local', options: { 'max-size': '10m', 'max-file': '3' } };
  const common = { restart: 'unless-stopped', network_mode: 'host', read_only: true, security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'], logging, pids_limit: 256, tmpfs: ['/tmp:rw,noexec,nosuid,size=64m'] };
  return { name: config.projectName, services: {
    grafana: { ...common, image: config.images.grafana, container_name: config.projectName + '-grafana', user: '472:472', mem_limit: '512m', cpus: '0.75',
      environment: { GF_PATHS_CONFIG: '/etc/grafana/grafana.ini', GF_PATHS_DATA: '/var/lib/grafana', GF_PATHS_PROVISIONING: '/etc/grafana/provisioning' },
      volumes: [bind(root + '/grafana', '/etc/grafana'), bind(data + '/grafana', '/var/lib/grafana', false)],
      secrets: ['grafana_oauth_client_secret', 'grafana_secret_key', 'grafana_bootstrap_password'] },
    loki: { ...common, image: config.images.loki, container_name: config.projectName + '-loki', user: '10001:10001', mem_limit: '768m', cpus: '0.75',
      command: ['-config.file=/etc/loki/loki.json', '-target=all'], volumes: [bind(root + '/loki.json', '/etc/loki/loki.json'), bind(data + '/loki', '/loki', false)] },
    alloy: { ...common, image: config.images.alloy, container_name: config.projectName + '-alloy', user: '0:0', mem_limit: '192m', cpus: '0.5', cap_add: ['DAC_READ_SEARCH'],
      command: ['run', '--server.http.listen-addr=127.0.0.1:' + config.alloy.port, '--storage.path=/var/lib/alloy', '/etc/alloy/config.alloy'],
      volumes: [bind(root + '/config.alloy', '/etc/alloy/config.alloy'), bind(data + '/alloy', '/var/lib/alloy', false),
        ...[...new Set(logFileSources(config).map(log => posix.dirname(log.path)))].map(path => bind(path, path)),
        ...(config.journals.length ? [bind('/var/log/journal', '/var/log/journal'), bind('/run/log/journal', '/run/log/journal'), bind('/etc/machine-id', '/etc/machine-id')] : [])] }
  }, secrets: {
    grafana_oauth_client_secret: { file: config.grafana.clientSecretFile }, grafana_secret_key: { file: config.grafana.secretKeyFile }, grafana_bootstrap_password: { file: config.grafana.bootstrapPasswordFile }
  } };
}

function panel(id, title, expression, x, y, width = 12, unit) {
  return { id, title, type: 'timeseries', datasource: { type: 'prometheus', uid: 'galaxy-prometheus' }, gridPos: { x, y, w: width, h: 8 }, targets: [{ refId: 'A', expr: expression }], fieldConfig: { defaults: { ...(unit ? { unit } : {}) }, overrides: [] }, options: { legend: { displayMode: 'list', placement: 'bottom' } } };
}
export function operationsDashboard() {
  return { uid: 'galaxy-operations', title: '银河运行', schemaVersion: 40, version: 1, editable: false, tags: ['galaxy'], timezone: 'browser', time: { from: 'now-6h', to: 'now' }, refresh: '30s', panels: [
    panel(1, 'API 与 Worker', 'up{job=~"galaxy-api|galaxy-worker"}', 0, 0),
    panel(2, '官网与服务探测', 'probe_success{job=~"galaxy-external-.*"}', 12, 0),
    panel(3, '待处理工作', 'galaxy_jobs', 0, 8),
    panel(4, '可用存储', 'galaxy_storage_bytes{kind="available"}', 12, 8, 12, 'bytes'),
    panel(5, '备份最近成功时间', 'galaxy_backup_last_success_timestamp_seconds', 0, 16, 12, 'dateTimeAsIso'),
    panel(6, '备份本次结果', 'galaxy_backup_last_attempt_success', 12, 16),
    panel(7, '请求被拒绝', 'sum by(component,status)(rate(galaxy_http_requests_total{status=~"401|403"}[5m]))', 0, 24),
    { id: 8, title: '运行诊断', type: 'logs', gridPos: { x: 12, y: 24, w: 12, h: 8 }, datasource: { type: 'loki', uid: 'galaxy-loki' }, targets: [{ refId: 'A', expr: '{component=~".+"}' }], options: { showTime: true, wrapLogMessage: true, sortOrder: 'Descending' } }
  ] };
}

export function pgBackRestConfiguration(pg, { repository = '/var/lib/pgbackrest', dataPath = pg.dataPath, logPath = '/var/log/pgbackrest', lockPath = '/var/run/pgbackrest' } = {}) {
  return `[global]
repo1-path=${repository}
repo1-cipher-type=aes-256-cbc
repo1-retention-full=${pg.retentionFull}
repo1-retention-archive-type=full
start-fast=y
process-max=2
compress-type=zst
log-level-console=warn
log-level-file=off
log-path=${logPath}
lock-path=${lockPath}
spool-path=/var/spool/pgbackrest

[${pg.id}]
pg1-path=${dataPath}
pg1-socket-path=${pg.socketPath}
pg1-user=${pg.administrator}
`;
}
export function postgresServerCommand(pg) {
  const existing = pg.serverCommand ?? ['postgres'], clean = [];
  for (let index = 0; index < existing.length; index++) {
    if (existing[index] === '-c' && /^(archive_mode|archive_command|archive_timeout)=/.test(existing[index + 1] ?? '')) { index++; continue; }
    if (/^--(archive_mode|archive_command|archive_timeout)=/.test(existing[index])) continue;
    clean.push(existing[index]);
  }
  return [...clean, '-c', 'archive_mode=on', '-c', `archive_command=/usr/local/bin/galaxy-pgbackrest --stanza=${pg.id} archive-push %p`, '-c', 'archive_timeout=60s'];
}
export function postgresOverlay(config, pg) {
  const root = config.directories.configuration + '/postgres/' + pg.id;
  return { services: { [pg.service]: {
    image: config.images.postgresBackup, command: postgresServerCommand(pg),
    volumes: [bind(root + '/pgbackrest.conf', '/etc/pgbackrest/pgbackrest.conf'), bind(pg.repository, '/var/lib/pgbackrest', false), bind(pg.cipherFile, '/run/secrets/pgbackrest_repository_cipher')],
    tmpfs: ['/var/log/pgbackrest:rw,nosuid,size=16m,uid=' + pg.uid + ',gid=' + pg.gid, '/var/run/pgbackrest:rw,nosuid,size=16m,uid=' + pg.uid + ',gid=' + pg.gid, '/var/spool/pgbackrest:rw,nosuid,size=64m,uid=' + pg.uid + ',gid=' + pg.gid]
  } } };
}

function monitorUnit(config, binary, args, dataDirectory, memory) {
  return `[Unit]
Description=Galaxy ${posix.basename(binary ?? 'monitor')}
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=${config.monitoring.serviceUser}
Group=${config.monitoring.serviceUser}
ExecStart=${command([binary ?? '/CONFIGURE_BINARY', ...args])}
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
UMask=0077
${dataDirectory ? 'ReadWritePaths=' + dataDirectory : ''}
MemoryMax=${memory}
CPUQuota=50%
[Install]
WantedBy=multi-user.target
`;
}
export function systemdFiles(config) {
  const root = config.directories.configuration;
  const files = {
    'systemd/galaxy-operations.service': `[Unit]
Description=Galaxy Grafana, Loki and Alloy
After=docker.service network-online.target
Requires=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${command([config.tools.docker, 'compose', '--project-name', config.projectName, '-f', root + '/compose.json', 'up', '-d', '--remove-orphans'])}
ExecStop=${command([config.tools.docker, 'compose', '--project-name', config.projectName, '-f', root + '/compose.json', 'stop'])}
[Install]
WantedBy=multi-user.target
`,
    'systemd/galaxy-operations-backup.service': `[Unit]
Description=Galaxy database and product backup
After=docker.service network-online.target
Requires=docker.service
[Service]
Type=oneshot
User=root
UMask=0077
ExecStart=${command([config.tools.node, (config.tools.stackDirectory ?? '/CONFIGURE_OPERATIONS_STACK_SOURCE') + '/manage.mjs', 'backup', '--config', root + '/configuration.json', '--type', 'auto'])}
ExecStopPost=${command([config.tools.node, (config.tools.stackDirectory ?? '/CONFIGURE_OPERATIONS_STACK_SOURCE') + '/manage.mjs', 'resume-writers', '--config', root + '/configuration.json'])}
TimeoutStartSec=6h
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
`,
    'systemd/galaxy-operations-backup.timer': `[Unit]
Description=Galaxy daily backup
[Timer]
OnCalendar=${config.backup.calendar}
RandomizedDelaySec=10m
Persistent=true
Unit=galaxy-operations-backup.service
[Install]
WantedBy=timers.target
`
  };
  if (config.dockerLogs.length) files['systemd/galaxy-component-logs.service'] = `[Unit]
Description=Galaxy component log projection
After=docker.service
Requires=docker.service
[Service]
Type=simple
User=root
UMask=0077
ExecStart=${command([config.tools.node, (config.tools.stackDirectory ?? '/CONFIGURE_OPERATIONS_STACK_SOURCE') + '/component-logs.mjs', '--config', root + '/configuration.json'])}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX
ReadWritePaths=${config.directories.data}/component-logs
MemoryMax=128M
CPUQuota=50%
[Install]
WantedBy=multi-user.target
`;
  if (config.monitoring.mode === 'managed') {
    const m = config.monitoring;
    files['systemd/galaxy-prometheus.service'] = monitorUnit(config, m.prometheusBinary, ['--config.file=' + root + '/monitoring/prometheus.json', '--storage.tsdb.path=' + m.prometheusData, '--storage.tsdb.retention.time=15d', '--web.listen-address=' + new URL(m.prometheusUrl).host], m.prometheusData, '256M');
    files['systemd/galaxy-alertmanager.service'] = monitorUnit(config, m.alertmanagerBinary, ['--config.file=/run/credentials/galaxy-alertmanager.service/alertmanager.json', '--storage.path=' + m.alertmanagerData, '--web.listen-address=' + new URL(m.alertmanagerUrl).host, '--cluster.listen-address='], m.alertmanagerData, '96M')
      .replace('[Service]\n', '[Service]\nLoadCredential=alertmanager.json:' + m.receiverConfigurationFile + '\n');
    files['systemd/galaxy-blackbox-exporter.service'] = monitorUnit(config, m.blackboxBinary, ['--config.file=' + root + '/monitoring/blackbox.json', '--web.listen-address=' + m.blackboxTarget], null, '64M');
  }
  return files;
}

export async function renderOperationsFiles(config) {
  const readJson = async path => JSON.parse(await readFile(new URL(path, repositoryDocs), 'utf8'));
  const [prometheus, blackbox, rules, externalRules, alertmanagerExample] = await Promise.all([
    readJson('monitoring/prometheus.example.json'), readJson('monitoring/blackbox.json'), readJson('alerts/galaxy.rules.json'), readJson('monitoring/external.rules.json'), readJson('alerts/alertmanager.example.json')
  ]);
  const m = config.monitoring;
  prometheus.rule_files = [config.directories.configuration + '/monitoring/galaxy.rules.json', config.directories.configuration + '/monitoring/external.rules.json'];
  prometheus.alerting.alertmanagers[0].static_configs[0].targets = [new URL(m.alertmanagerUrl).host];
  for (const scrape of prometheus.scrape_configs) {
    if (scrape.job_name === 'galaxy-blackbox-exporter') scrape.static_configs[0].targets = [m.blackboxTarget];
    else {
      scrape.static_configs[0].targets = [({ 'galaxy-external-website': m.website, 'galaxy-external-liveness': m.liveness, 'galaxy-external-readiness': m.readiness })[scrape.job_name]];
      scrape.relabel_configs.find(rule => rule.target_label === '__address__').replacement = m.blackboxTarget;
    }
  }
  for (const component of ['api', 'worker']) prometheus.scrape_configs.push({ job_name: 'galaxy-' + component, static_configs: [{ targets: config.monitoring[component + 'Target'] ? [config.monitoring[component + 'Target']] : [] }] });
  const datasources = { apiVersion: 1, datasources: [
    { name: 'Galaxy metrics', uid: 'galaxy-prometheus', type: 'prometheus', access: 'proxy', url: m.prometheusUrl, isDefault: true, editable: false },
    { name: 'Galaxy logs', uid: 'galaxy-loki', type: 'loki', access: 'proxy', url: 'http://127.0.0.1:' + config.loki.port, editable: false, jsonData: { maxLines: 500 } },
    { name: 'Galaxy alerts', uid: 'galaxy-alertmanager', type: 'alertmanager', access: 'proxy', url: m.alertmanagerUrl, editable: false, jsonData: { implementation: 'prometheus', handleGrafanaManagedAlerts: false } }
  ] };
  const notification = renderEmailLayout({ category: '运行通知', title: '运行告警',
    bodyHtml: '<h1 style="margin:0 0 18px;font-size:24px;line-height:34px;font-weight:500;">运行告警</h1><p>{{ .CommonAnnotations.summary }}</p><p>{{ .CommonAnnotations.description }}</p><p><a href="https://admin.agigalaxy.org/monitoring/">查看运行情况</a></p>',
    bodyText: '运行告警\n\n{{ .CommonAnnotations.summary }}\n\n{{ .CommonAnnotations.description }}\n\nhttps://admin.agigalaxy.org/monitoring/' });
  const deliveryTest = renderGalaxyEmail({ subject: '[AGI Galaxy] 运行告警投递测试 / Monitoring delivery test', title: '运行告警投递测试', category: '运行通知',
    paragraphs: ['这是一封已获授权的运行告警投递测试邮件，无需处理。', '此邮件不报告生产故障。实际告警将通过同一管理通知连接发送。'], note: 'This is an authorized monitoring email delivery test, not a production incident.' });
  const files = {
    'compose.json': json(operationsCompose(config)), 'grafana/grafana.ini': grafanaIni(config),
    'keycloak-grafana.json': json(grafanaClientContract(config)),
    'grafana/provisioning/datasources/galaxy.yml': json(datasources),
    'grafana/provisioning/dashboards/galaxy.yml': json({ apiVersion: 1, providers: [{ name: 'Galaxy', orgId: 1, folder: 'Galaxy', type: 'file', disableDeletion: true, editable: false, options: { path: '/etc/grafana/dashboards' } }] }),
    'grafana/dashboards/galaxy-operations.json': json(operationsDashboard()),
    'grafana/dashboards/galaxy-logs.json': json(loggingDashboard()),
    'loki.json': json(lokiConfiguration(config)), 'config.alloy': alloyConfiguration(config),
    'monitoring/prometheus.json': json(prometheus), 'monitoring/blackbox.json': json(blackbox),
    'monitoring/galaxy.rules.json': json(rules), 'monitoring/external.rules.json': json(externalRules),
    'monitoring/galaxy-email.html': notification.html, 'monitoring/galaxy-email.txt': notification.text,
    'monitoring/mail-identity.json': json(officialMailIdentity('notice')),
    'monitoring/galaxy-test-email.html': deliveryTest.html, 'monitoring/galaxy-test-email.txt': deliveryTest.text,
    'monitoring/alertmanager.unconfigured.example.json': json(alertmanagerExample),
    'caddy-monitoring.fragment': `# Include inside the existing admin.agigalaxy.org site block. No path stripping.\nredir /monitoring /monitoring/ 308\nhandle /monitoring/* {\n  reverse_proxy 127.0.0.1:${config.grafana.port}\n}\n`,
    ...systemdFiles(config)
  };
  for (const pg of config.postgres) if (pg.dataPath && pg.administrator && pg.cipherFile && pg.uid !== null && pg.gid !== null) {
    files['postgres/' + pg.id + '/pgbackrest.conf'] = pgBackRestConfiguration(pg);
    files['postgres/' + pg.id + '/compose.json'] = json(postgresOverlay(config, pg));
  }
  return files;
}
