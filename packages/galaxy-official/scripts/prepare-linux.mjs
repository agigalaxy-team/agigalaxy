import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectServiceRelease } from '../src/operations/service-release.mjs';
import { linuxDeploymentFiles } from '../deploy/linux-plan.mjs';

try {
  const [directory, digest, pinsFile, destination, settingsFile, ...extra] = process.argv.slice(2);
  if (extra.length || ![directory, pinsFile, destination, ...(settingsFile ? [settingsFile] : [])].every(value => typeof value === 'string' && isAbsolute(value)))
    throw new Error('Explicit absolute paths required.');
  const release = await inspectServiceRelease(directory, digest);
  const pins = JSON.parse((await readFile(pinsFile, 'utf8')).replace(/^\uFEFF/, ''));
  const settings = settingsFile ? JSON.parse((await readFile(settingsFile, 'utf8')).replace(/^\uFEFF/, '')) : undefined;
  const files = linuxDeploymentFiles({ release, pins, settings });
  await mkdir(destination, { mode: 0o700 });
  const hashes = {};
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(destination, name)), { recursive: true });
    await writeFile(join(destination, name), content, { flag: 'wx', mode: name.endsWith('.sh') ? 0o700 : 0o600 });
    hashes[name] = createHash('sha256').update(content).digest('hex');
  }
  await writeFile(join(destination, 'files.sha256.json'), JSON.stringify(hashes, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ event: 'linux_deployment_prepared', files: Object.keys(files).length,
    releaseId: release.releaseId, schema: release.migrations.at(-1).version, applied: false, secretsIncluded: false }));
} catch {
  console.error(JSON.stringify({ event: 'linux_deployment_preparation_failed', help: 'See docs/linux-deployment-v1.md' }));
  process.exitCode = 1;
}
