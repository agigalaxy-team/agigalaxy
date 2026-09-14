import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectNativeHostAcceptance } from '../native-host-release.mjs';

test('host evidence binds installed bytes and emits no paths or terminal contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-native-release-test-'));
  try {
    const installed = join(directory, 'consumer');
    const input = { scenario: 'initialization', originalIdentityUsed: false, globalConfigurationChanged: false,
      syntheticFixture: true, installedEntry: join(installed, 'galaxy.js'), files: { [join(installed, 'galaxy.js')]: 'a'.repeat(64) } };
    const report = { passed: true, hostVersion: '1.18.29', syntheticDirectory: true, identityCreatedByNativeUi: true,
      postInitializationFilesUnchanged: true, savedFileCount: 5, connectionState: 'not-connected', layoutFindings: [],
      events: [{ missingVisibleText: [], terminal: { width: 80, height: 24, text: 'PRIVATE-TERMINAL-FIXTURE' } }] };
    const candidate = { receipt: { installed }, manifest: { artifacts: { 'galaxy.js': 'a'.repeat(64) } }, artifact: Buffer.from('fixture'),
      sourceSha256: 'b'.repeat(64), artifactsSha256: 'c'.repeat(64) };
    const save = async (i, r) => {
      await writeFile(join(directory, 'input.json'), JSON.stringify(i));
      await writeFile(join(directory, 'host-report.json'), JSON.stringify(r));
    };
    await save(input, report);
    const bytes = await collectNativeHostAcceptance(candidate, [directory]);
    assert.equal(bytes.includes('PRIVATE-TERMINAL-FIXTURE'), false);
    assert.equal(bytes.includes(directory), false);
    assert.equal(JSON.parse(bytes).humanReview, false);
    for (const changed of [{ ...input, originalIdentityUsed: true }, { ...input, files: {} },
      { ...input, installedEntry: join(directory, 'other.js') }]) {
      await save(changed, report);
      await assert.rejects(collectNativeHostAcceptance(candidate, [directory]));
    }
    await save(input, { ...report, layoutFindings: ['hidden confirmation'] });
    await assert.rejects(collectNativeHostAcceptance(candidate, [directory]));
    await assert.rejects(collectNativeHostAcceptance(candidate, [directory, directory]));
    assert.ok(await readFile(join(directory, 'input.json')));
  } finally {
    // This exact directory was created by this test beneath the OS temp directory.
    await rm(directory, { recursive: true, force: true });
  }
});
