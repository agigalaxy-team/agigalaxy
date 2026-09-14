import { officialRoutes } from './caddy-routes.mjs';
import { environmentFile, parseRuntimeSettings, runtimePolicyFiles } from './runtime-settings.mjs';

// Render ordinary systemd/Compose files. This module never connects to a host,
// creates credentials, starts services, or edits a running proxy.
export function linuxDeploymentFiles({ release, pins, settings }) {
  const runtimeSettings = parseRuntimeSettings(settings);
  if (!release.filesVerified || !release.entries.migration
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(release.releaseId)
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(release.configurationVersion)
    || !/^\d+\.\d+\.\d+$/.test(pins.node?.version)
    || !/^[a-f0-9]{64}$/.test(pins.node.sha256)
    || pins.node.url !== `https://nodejs.org/dist/v${pins.node.version}/node-v${pins.node.version}-linux-x64.tar.xz`
    || !/^postgres@sha256:[a-f0-9]{64}$/.test(pins.postgres?.image)
    || pins.postgres.platform !== 'linux/amd64' || pins.postgres.version !== '18.6')
    throw new Error('Verified release and explicit Linux runtime pins required.');
  const [major, minor] = pins.node.version.split('.').map(Number);
  if (major < 24 || major === 24 && minor < 13) throw new Error('Node24.13+ required.');
  const directory = `/opt/galaxy/releases/${release.releaseId}`;
  const node = `/opt/galaxy/runtime/node-v${pins.node.version}-linux-x64/bin/node`;
  const files = {};
  const json = value => JSON.stringify(value, null, 2) + '\n';
  for (const [stage, offset] of [['local', -100], ['integration', 0], ['pilot', 100]]) {
    const port = 3101 + offset;
    const dbPort = 15432 + offset;
    const endpoint = stage === 'pilot' ? 'https://official.agigalaxy.org' : `https://official.${stage}.invalid`;
    const apiDirectory = `/var/lib/galaxy/api/${stage}`;
    const policies = runtimePolicyFiles(stage, runtimeSettings.stages[stage]);
    const common = { GALAXY_ENVIRONMENT: stage, GALAXY_ENDPOINT: endpoint,
      GALAXY_RELEASE_DIRECTORY: directory, GALAXY_RELEASE_SHA256: release.manifestSha256,
      GALAXY_CONFIGURATION_VERSION: release.configurationVersion };
    for (const role of ['api', 'worker', 'migration']) {
      const values = { ...common, DATABASE_URL: `postgresql://galaxy_${stage}_${role}:REPLACE_WITH_ENCODED_PASSWORD@127.0.0.1:${dbPort}/galaxy_${stage}` };
      if (role !== 'migration') {
        Object.assign(values, policies.common);
        values.GALAXY_RUNTIME_LOG_DIRECTORY = `/var/log/galaxy/${stage}/${role}`;
        values.GALAXY_METRICS_STORAGE_DIRECTORY = values.GALAXY_RUNTIME_LOG_DIRECTORY;
        values.GALAXY_RUNTIME_LOG_INSTANCE = 'primary';
        values.GALAXY_RUNTIME_LOG_ROTATE_BYTES = '10485760';
        values.GALAXY_RUNTIME_LOG_MAX_FILES = '14';
        values.GALAXY_METRICS_PORT = String(9311 + offset + (role === 'worker' ? 1 : 0));
        values.GALAXY_OPERATOR_REF = policies.settings.operatorRef ?? 'REPLACE_WITH_OPERATOR_REFERENCE';
      }
      if (role === 'api') Object.assign(values, { PORT: String(port), GALAXY_LISTEN_HOST: '127.0.0.1',
        GALAXY_ENVIRONMENT_DIRECTORY: apiDirectory,
        GALAXY_SIGNING_KEY_FILE: `${apiDirectory}/signing-key.pem`, GALAXY_SIGNING_KEY_ID: 'REPLACE_WITH_KEY_ID',
        GALAXY_ROOT_PINS_FILE: `${apiDirectory}/root-pins.json`, GALAXY_KEYRING_FILE: `${apiDirectory}/keyring.json`,
        GALAXY_TRUST_DIRECTORY: `${apiDirectory}/trust`,
        GALAXY_OPERATOR: policies.settings.operator ?? 'REPLACE_WITH_OPERATOR_NAME',
        GALAXY_REGION: policies.settings.region ?? (stage === 'local' ? 'local-development' : 'ap-kulai-2'), ...policies.api });
      if (role === 'worker' && policies.settings.searchIndexEnabled !== undefined)
        values.GALAXY_SEARCH_INDEX_ENABLED = String(policies.settings.searchIndexEnabled);
      // Keep search opt-in; deployment preparation does not enable new capabilities.
      files[`${stage}/${role}.env.example`] = '# Copy to the matching /etc/galaxy environment only after supplying its own values.\n' + environmentFile(values);
    }
    for (const [name, value] of Object.entries(policies.files)) files[`${stage}/runtime/${name}`] = json(value);
    files[`${stage}/configuration.json`] = json({ version: 1, stage, endpoint, configurationDirectory: policies.configurationDirectory,
      configurationVersion: release.configurationVersion, ...policies.decision,
      secretMaterial: 'environment-specific database credentials and signing material remain external',
      operatorContact: 'not supplied by this runtime template; complete operational records before pilot' });
    files[`${stage}/database.compose.json`] = json({ name: `galaxy-${stage}`, services: { database: {
      image: pins.postgres.image, platform: 'linux/amd64', restart: 'unless-stopped',
      environment: { POSTGRES_DB: `galaxy_${stage}`, POSTGRES_USER: `galaxy_${stage}_migration`,
        POSTGRES_PASSWORD_FILE: '/run/secrets/database_password', POSTGRES_HOST_AUTH_METHOD: 'scram-sha-256' },
      secrets: ['database_password'], ports: [`127.0.0.1:${dbPort}:5432`],
      volumes: [{ type: 'volume', source: 'database', target: '/var/lib/postgresql' }],
      shm_size: '256m', mem_limit: '4g', cpus: 2, pids_limit: 256,
      healthcheck: { test: ['CMD-SHELL', `pg_isready -U galaxy_${stage}_migration -d galaxy_${stage}`],
        interval: '5s', timeout: '3s', retries: 12, start_period: '10s' },
      logging: { driver: 'local', options: { 'max-size': '10m', 'max-file': '5' } },
    } }, volumes: { database: {} }, secrets: { database_password: { file: `/etc/galaxy/${stage}/database.password` } } });
    // Explicit first-install SQL, after the migration CLI has installed NOLOGIN roles.
    // Password assignment is supplied through the selected credential channel.
    files[`${stage}/database-logins.sql`] = `BEGIN;
CREATE ROLE galaxy_${stage}_api LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE galaxy_${stage}_worker LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT galaxy_api TO galaxy_${stage}_api;
GRANT galaxy_evidence_worker TO galaxy_${stage}_worker;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE galaxy_${stage} FROM PUBLIC;
GRANT CONNECT ON DATABASE galaxy_${stage} TO galaxy_${stage}_api, galaxy_${stage}_worker;
COMMIT;
`;
    files[`${stage}/official-routes.json`] = json(officialRoutes({ endpoint, apiPort: port }));
  }
  for (const [role, account, memory] of [['api', 'api', '1G'], ['worker', 'worker', '2G'], ['migration', 'migrate', '1G']]) {
    const entry = release.entries[role];
    const isMigration = role === 'migration';
    files[`systemd/galaxy-${role}@.service`] = `[Unit]
Description=Galaxy ${role} (%i)
Requires=galaxy-database@%i.service
After=galaxy-database@%i.service network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=${isMigration ? 'oneshot' : 'simple'}
User=galaxy-${account}-%i
Group=galaxy-${account}-%i
WorkingDirectory=/opt/galaxy
EnvironmentFile=/etc/galaxy/%i/${role}.env
ExecStart=${node} ${'${GALAXY_RELEASE_DIRECTORY}'}/${entry}${isMigration ? ' --roles=api,worker,deletion-review' : ''}
${isMigration ? 'TimeoutStartSec=1200' : 'Restart=on-failure\nRestartSec=5'}
TimeoutStopSec=25
KillSignal=SIGTERM
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
${isMigration ? '' : `ReadWritePaths=/var/log/galaxy/%i/${role}${role === 'api' ? ' /var/lib/galaxy/api/%i/trust' : ''}\n`}MemoryMax=${memory}
CPUQuota=200%
LimitNOFILE=8192
TasksMax=256
StandardOutput=journal
StandardError=journal
${isMigration ? '' : '\n[Install]\nWantedBy=multi-user.target\n'}`;
  }
  files['systemd/galaxy-database@.service'] = `[Unit]
Description=Galaxy isolated PostgreSQL (%i)
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=true
ExecStart=/usr/bin/docker compose -f /etc/galaxy/%i/database.compose.json up -d --wait
ExecStop=/usr/bin/docker compose -f /etc/galaxy/%i/database.compose.json stop -t 25
TimeoutStartSec=300
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
`;
  files['prepare-layout.sh'] = `#!/bin/sh
set -eu
test "$(id -u)" = 0
test "$#" = 1
case "$1" in local|integration|pilot) stage=$1 ;; *) exit 2 ;; esac
test "$(uname -m)" = x86_64
bundle=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for path in /opt/galaxy /opt/galaxy/runtime /opt/galaxy/releases /etc/galaxy /var/lib/galaxy /var/lib/galaxy/api /var/lib/galaxy/config /var/log/galaxy; do
  test ! -L "$path"
  install -d -o root -g root -m 0755 "$path"
done
for role in api worker migrate; do
  account="galaxy-$role-$stage"
  if ! getent passwd "$account" >/dev/null; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$account"
  fi
  test "$(id -u "$account")" -ne 0
done
for path in "/etc/galaxy/$stage" "/var/lib/galaxy/api/$stage" "/var/lib/galaxy/api/$stage/trust" "/var/lib/galaxy/config/$stage" "/var/log/galaxy/$stage" "/var/log/galaxy/$stage/api" "/var/log/galaxy/$stage/worker"; do
  test ! -L "$path"
done
install -d -o root -g root -m 0700 "/etc/galaxy/$stage"
install -d -o root -g root -m 0755 "/var/lib/galaxy/config/$stage"
install -d -o root -g "galaxy-api-$stage" -m 0750 "/var/lib/galaxy/api/$stage"
install -d -o "galaxy-api-$stage" -g "galaxy-api-$stage" -m 0700 "/var/lib/galaxy/api/$stage/trust"
install -d -o root -g root -m 0755 "/var/log/galaxy/$stage"
for role in api worker; do
  install -d -o "galaxy-$role-$stage" -g "galaxy-$role-$stage" -m 0700 "/var/log/galaxy/$stage/$role"
done
for source in "$bundle/$stage/runtime/"*.json; do
  destination="/var/lib/galaxy/config/$stage/$(basename -- "$source")"
  test ! -L "$destination"
  if test -e "$destination"; then cmp "$source" "$destination"; else install -o root -g root -m 0644 "$source" "$destination"; fi
done
for unit in "$bundle"/systemd/*.service; do
  destination="/etc/systemd/system/$(basename -- "$unit")"
  if test -e "$destination"; then cmp "$unit" "$destination"; else install -m 0644 "$unit" "$destination"; fi
done
destination="/etc/galaxy/$stage/database.compose.json"
if test -e "$destination"; then cmp "$bundle/$stage/database.compose.json" "$destination"; else install -m 0600 "$bundle/$stage/database.compose.json" "$destination"; fi
systemctl daemon-reload
printf '%s\\n' 'Layout prepared. Runtime, credentials, migrations and service activation are separate steps.'
`;
  files['install-node.sh'] = `#!/bin/sh
set -eu
test "$(id -u)" = 0
test "$(uname -m)" = x86_64
target=/opt/galaxy/runtime/node-v${pins.node.version}-linux-x64
test ! -e "$target"
test ! -L /opt/galaxy/runtime
install -d -o root -g root -m 0755 /opt/galaxy/runtime
archive=$(mktemp /opt/galaxy/runtime/node-download.XXXXXX)
trap 'rm -f "$archive"' EXIT HUP INT TERM
curl --fail --location --proto '=https' --tlsv1.2 '${pins.node.url}' --output "$archive"
printf '%s  %s\\n' '${pins.node.sha256}' "$archive" | sha256sum --check --status
tar --extract --xz --file "$archive" --directory /opt/galaxy/runtime --no-same-owner
"$target/bin/node" --version
`;
  files['deployment.json'] = json({ version: 1, kind: 'galaxy-linux-deployment-candidate',
    releaseId: release.releaseId, manifestSha256: release.manifestSha256,
    configurationVersion: release.configurationVersion, releaseDirectory: directory,
    schema: release.migrations.at(-1).version, runtimePins: pins,
    environments: ['local', 'integration', 'pilot'], databaseIsolation: 'separate PostgreSQL containers and named volumes',
    configurationDirectory: '/var/lib/galaxy/config/<environment>; public policy only, root-owned',
    network: 'loopback API, metrics and PostgreSQL; existing host Caddy',
    applied: false, dynamicDeployed: false, secretsIncluded: false,
    remainingInputs: ['environment-specific database passwords and API/Worker logins', 'independent signing roots and service key per environment',
      'operator and operational policy', 'immutable release installation', 'target activation and lifecycle verification',
      'Caddy admin-off cutover decision and public DNS/TLS', 'offsite backup destination'] });
  return files;
}
