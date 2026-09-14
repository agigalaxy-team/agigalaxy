import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { linuxDeploymentFiles } from '../deploy/linux-plan.mjs';
import { environmentFile } from '../deploy/runtime-settings.mjs';
import { assertRuntimeEnvironment } from '../src/runtime-environment.mjs';
import { loadRequestQuotaPolicy } from '../src/adapters/http/request-quotas.mjs';
import { loadResourceBudgetPolicy } from '../src/infrastructure/resource-budgets.mjs';
import { loadGovernanceForRuntime } from '../src/operations/governance-review.mjs';
import { loadIdentityProviders } from '../src/identity-config.mjs';
import { loadNetworkProfile } from '../src/network-profile.mjs';
import { loadMetricsConfiguration } from '../src/operations/metrics.mjs';

const release = { filesVerified: true, releaseId: 'fixture-1', configurationVersion: 'fixture-config-1',
  manifestSha256: 'a'.repeat(64), entries: { api: 'packages/galaxy-official/src/server.mjs',
    worker: 'packages/galaxy-official/src/worker.mjs', migration: 'packages/galaxy-official/src/migrate.mjs' }, migrations: [{ version: 41 }] };
const pins = { node: { version: '24.19.0', sha256: 'b'.repeat(64), url: 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz' },
  postgres: { version: '18.6', platform: 'linux/amd64', image: 'postgres@sha256:' + 'c'.repeat(64) } };
function parseTemplate(content) {
  return Object.fromEntries(content.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const separator = line.indexOf('='), value = line.slice(separator + 1);
    return [line.slice(0, separator), value.startsWith('"') ? JSON.parse(value) : value];
  }));
}

test('three isolated environment bundles load actual runtime policies and keep per-role fields separate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-environment-policies-'));
  const settings = { version: 1, stages: { local: { operator: 'Synthetic 银河 "Team" \\ $literal', operatorRef: 'fixture-local', searchIndexEnabled: true } } };
  const files = linuxDeploymentFiles({ release, pins, settings });
  const ports = new Set(), identities = new Set();
  let loadedPolicies = 0;
  try {
    for (const stage of ['local', 'integration', 'pilot']) {
      const policyDirectory = join(directory, stage); await mkdir(policyDirectory);
      for (const name of ['request-quotas', 'resource-budgets', 'governance', 'network-profile', 'identity'])
        await writeFile(join(policyDirectory, name + '.json'), files[`${stage}/runtime/${name}.json`]);
      const api = parseTemplate(files[`${stage}/api.env.example`]);
      const worker = parseTemplate(files[`${stage}/worker.env.example`]);
      const migration = parseTemplate(files[`${stage}/migration.env.example`]);
      for (const [role, env] of Object.entries({ api, worker, migration })) {
        assert.deepEqual(assertRuntimeEnvironment(env, role), { environment: stage, role });
        const database = new URL(env.DATABASE_URL);
        assert.equal(database.pathname, '/galaxy_' + stage);
        assert.equal(database.username, `galaxy_${stage}_${role}`);
        identities.add(database.username);
        if (role !== 'api') assert.ok(!Object.keys(env).some(name => /SIGNING|ROOT_PINS|KEYRING|TRUST_DIRECTORY|IDENTITY_CONFIG/.test(name)));
        if (role !== 'migration') {
          assert.equal(env.GALAXY_RESOURCE_BUDGET_FILE, `/var/lib/galaxy/config/${stage}/resource-budgets.json`);
          ports.add(env.GALAXY_METRICS_PORT);
          assert.equal((await loadMetricsConfiguration(env)).storageDirectory, env.GALAXY_RUNTIME_LOG_DIRECTORY);
        }
      }
      ports.add(api.PORT); ports.add(new URL(api.DATABASE_URL).port);
      assert.equal((await loadRequestQuotaPolicy(join(policyDirectory, 'request-quotas.json'))).version, 1);
      assert.equal((await loadResourceBudgetPolicy(join(policyDirectory, 'resource-budgets.json'))).version, 1);
      assert.equal((await loadNetworkProfile(join(policyDirectory, 'network-profile.json'))).networkType, 'official');
      assert.deepEqual((await loadIdentityProviders(join(policyDirectory, 'identity.json'), { endpoint: api.GALAXY_ENDPOINT })).providers, []);
      const governance = await loadGovernanceForRuntime({ configurationPath: join(policyDirectory, 'governance.json'),
        endpoint: api.GALAXY_ENDPOINT, environment: stage });
      assert.equal(governance.configuration.moderatorIds.length, 0);
      assert.equal(governance.configuration.honorRules.length, 0);
      loadedPolicies += 5;
      const declaration = JSON.parse(files[`${stage}/configuration.json`]);
      assert.equal(declaration.activated, false); assert.equal(declaration.productionBudgetAccepted, false);
      assert.equal(declaration.resourceBudgetBasis, 'existing-development-default');
      assert.equal(declaration.operatorConfigured, stage === 'local');
      assert.equal(worker.GALAXY_SEARCH_INDEX_ENABLED, stage === 'local' ? 'true' : undefined);
      const compose = JSON.parse(files[`${stage}/database.compose.json`]);
      assert.equal(compose.name, 'galaxy-' + stage);
      assert.ok(compose.services.database.ports.every(value => value.startsWith('127.0.0.1:')));
      assert.equal(api.GALAXY_LISTEN_HOST, '127.0.0.1');
      const otherStage = stage === 'local' ? 'integration' : 'local';
      assert.throws(() => assertRuntimeEnvironment({ ...api, GALAXY_ROOT_PINS_FILE: `/var/lib/galaxy/api/${otherStage}/root-pins.json` }, 'api'));
    }
    assert.equal(ports.size, 12); assert.equal(identities.size, 9); assert.equal(loadedPolicies, 15);
    assert.equal(parseTemplate(files['local/api.env.example']).GALAXY_OPERATOR, settings.stages.local.operator);
    assert.ok(files['prepare-layout.sh'].includes('local|integration|pilot'));
    assert.ok(files['prepare-layout.sh'].includes('install -o root -g root -m 0644 "$source" "$destination"'));
    assert.ok(!files['prepare-layout.sh'].includes('systemctl start'));
    console.log(JSON.stringify({ event: 'linux_environment_matrix_verified', environments: 3, roles: 9, distinctPorts: 12,
      nativePolicyLoads: loadedPolicies, hostInstalled: false, signingMaterialCreated: false, activated: false }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('runtime setting overrides stay per environment and secret or malformed settings never enter the public bundle', () => {
  const original = linuxDeploymentFiles({ release, pins });
  const policy = JSON.parse(original['local/runtime/resource-budgets.json']);
  const settings = { version: 1, stages: { pilot: { resourceBudgetPolicy: { ...policy, maxActiveJobsGlobal: 2 } } } };
  const changed = linuxDeploymentFiles({ release, pins, settings });
  assert.equal(JSON.parse(changed['pilot/runtime/resource-budgets.json']).maxActiveJobsGlobal, 2);
  assert.equal(changed['local/runtime/resource-budgets.json'], original['local/runtime/resource-budgets.json']);
  for (const stages of [{ unknown: {} }, { local: { databasePassword: 'synthetic-rejected' } },
    { pilot: { operator: 'line\nPORT=4000' } }, { local: { resourceBudgetPolicy: { ...policy, maxActiveJobsGlobal: 0 } } }])
    assert.throws(() => linuxDeploymentFiles({ release, pins, settings: { version: 1, stages } }));
  assert.throws(() => environmentFile({ GALAXY_OPERATOR: 'line\nOTHER=value' }));
  assert.equal(JSON.parse(original['deployment.json']).secretsIncluded, false);
  assert.equal(JSON.parse(original['pilot/configuration.json']).operatorConfigured, false);
});
