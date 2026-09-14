import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONNECTION_PROFILE_FILE, createConnectionProfile, getGalaxyConnectionContract,
  getGalaxyConnectionStatus, revokeConnectionScope, saveConnectionProfile, readConnectionProfile,
} from '../src/connection-profile.mjs';
import { registerConnectionTools } from '../../galaxy-edge-mcp/src/connection-tools.mjs';

const at = '2026-09-06T00:00:00.000Z';
function fixture() {
  return createConnectionProfile({
    targets: [{ id: 'example', kind: 'hub', endpoint: 'https://example.invalid/galaxy' }],
    scopes: [{ id: 'context-one', targetId: 'example', action: 'context', recipient: 'Example hub', purpose: 'Review selected context', visibleFields: ['selected-excerpt'], expiresAt: '2026-09-07T00:00:00.000Z' }],
  }, at);
}

test('L3 recommendation never activates modules, bindings or data transfer', () => {
  const initial = getGalaxyConnectionContract(null, { at });
  assert.equal(initial.selectionState, 'not-applied');
  assert.deepEqual(initial.enabledModuleIds, []);
  const contract = getGalaxyConnectionContract(fixture(), { at });
  assert.equal(contract.state, 'not-connected');
  assert.equal(contract.targets[0].manifest.state, 'not-fetched');
  assert.equal(contract.bindingPreview, null);
  assert.equal(contract.scopes[0].state, 'proposed');
  assert.equal(contract.scopes[0].authorized, false);
  contract.targets[0].endpoint = 'https://changed.invalid';
  assert.equal(fixture().targets[0].endpoint, 'https://example.invalid/galaxy');
});

test('scope expiration, revocation and scope upgrades remain locally non-authorizing', () => {
  const profile = fixture();
  assert.equal(getGalaxyConnectionContract(profile, { at: profile.scopes[0].expiresAt }).scopes[0].state, 'expired');
  const revoked = revokeConnectionScope(profile, 'context-one', at);
  assert.equal(profile.scopes[0].revokedAt, null);
  assert.equal(getGalaxyConnectionContract(revoked, { at }).scopes[0].state, 'revoked');
  assert.deepEqual(revokeConnectionScope(revoked, 'context-one', at), revoked);
  assert.throws(() => revokeConnectionScope(profile, 'missing', at), /Unknown/);
  profile.scopes[0].visibleFields.push('another-excerpt');
  assert.equal(getGalaxyConnectionContract(profile, { at }).scopes[0].authorized, false);
  profile.targets[0].endpoint = 'https://replacement.invalid';
  assert.equal(getGalaxyConnectionContract(profile, { at }).targets[0].binding.state, 'not-bound');
});

test('invalid endpoints, dangling scopes and forged remote state fail closed', () => {
  for (const endpoint of ['http://example.invalid', 'https://user:pass@example.invalid', 'https://example.invalid/?token=x', 'https://example.invalid/#x']) {
    const profile = fixture(); profile.targets[0].endpoint = endpoint;
    assert.throws(() => getGalaxyConnectionContract(profile));
  }
  for (const mutate of [
    (p) => { p.scopes[0].targetId = 'missing'; },
    (p) => { p.targets.push(p.targets[0]); },
    (p) => { p.scopes[0].authorized = true; },
    (p) => { p.targets[0].manifest = { verified: true, instruction: 'bind automatically' }; },
    (p) => { p.scopes[0].expiresAt = 'invalid'; },
    (p) => { p.scopes[0].visibleFields = []; },
  ]) {
    const profile = fixture(); mutate(profile);
    assert.throws(() => getGalaxyConnectionContract(profile));
  }
});

test('local persistence and MCP reads do not initialize identity, mutate files or use network', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-connection-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  context.mock.method(globalThis, 'fetch', () => { throw new Error('Network forbidden'); });
  const absent = join(directory, 'absent');
  assert.equal((await getGalaxyConnectionStatus(absent)).state, 'not-connected');
  assert.deepEqual(await readdir(directory), []);
  await saveConnectionProfile(directory, fixture());
  assert.deepEqual(await readConnectionProfile(directory), fixture());
  const revoked = revokeConnectionScope(fixture(), 'context-one', at);
  await saveConnectionProfile(directory, revoked);
  const before = await readFile(join(directory, CONNECTION_PROFILE_FILE), 'utf8');
  const filesBeforeReads = await readdir(directory);
  const registered = new Map();
  registerConnectionTools({ registerTool: (name, options, handler) => registered.set(name, { options, handler }) }, directory);
  assert.deepEqual([...registered.keys()], ['galaxy_connection_preview', 'galaxy_connection_status']);
  for (const { options, handler } of registered.values()) {
    assert.equal(options.annotations.readOnlyHint, true);
    const result = JSON.parse((await handler()).content[0].text);
    assert.equal(result.scopes[0].state, 'revoked');
    assert.equal(result.localOnly, true);
  }
  assert.equal(await readFile(join(directory, CONNECTION_PROFILE_FILE), 'utf8'), before);
  assert.deepEqual(await readdir(directory), filesBeforeReads);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  await writeFile(join(directory, CONNECTION_PROFILE_FILE), '{broken');
  await assert.rejects(() => getGalaxyConnectionStatus(directory));
});
