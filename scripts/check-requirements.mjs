import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const project = process.env.GALAXY_PROJECT_ROOT
  ? resolve(process.env.GALAXY_PROJECT_ROOT) : resolve(repository, '../../..');
const checker = resolve(project, '05-build/tools/galaxy_docs.py');
const manifest = resolve(project, '02-architecture/current/manifest.json');
if (!existsSync(checker) || !existsSync(manifest)) {
  console.error('Current project documentation unavailable. Supply its matching GALAXY_PROJECT_ROOT; validation cannot be skipped.');
  process.exit(2);
}
/** @type {Array<[string, string[]]>} */
const candidates = process.env.GALAXY_PYTHON
  ? [[process.env.GALAXY_PYTHON, []]]
  : process.platform === 'win32' ? [['py', ['-3']]] : [['python3', []]];
const runtime = candidates.find(([binary, args]) => {
  const probe = spawnSync(binary, [...args, '-B', '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'],
    { cwd: project, windowsHide: true, shell: false, stdio: 'ignore' });
  return !probe.error && probe.status === 0;
});
if (!runtime) {
  console.error('Python >=3.10 is required. Set GALAXY_PYTHON to an installed interpreter.');
  process.exit(2);
}
for (const args of [[checker, 'validate']]) {
  const result = spawnSync(runtime[0], [...runtime[1], '-B', '-X', 'utf8', ...args],
    { cwd: project, windowsHide: true, shell: false, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
console.log('Current documentation assembly, links and decision mappings checked. Historical modules are source locators. Semantic understanding, product behavior, user acceptance and deployment require separate evidence.');
