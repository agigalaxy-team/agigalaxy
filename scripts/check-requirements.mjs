import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const project = process.env.GALAXY_PROJECT_ROOT
  ? resolve(process.env.GALAXY_PROJECT_ROOT) : resolve(repository, '../../..');
const checker = resolve(project, '05-build/tools/galaxy_requirements.py');
const baseline = resolve(project, '05-build/tools/check_execution_plan.py');
const execution = resolve(project, '05-build/tools/galaxy_execution.py');
if (!existsSync(checker) || !existsSync(baseline)) {
  console.error('Requirements corpus unavailable. Supply the matching project documentation with GALAXY_PROJECT_ROOT; validation cannot be skipped.');
  process.exit(2);
}
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
for (const args of [[checker, 'validate'], [checker, 'selftest'], [baseline],
  ...(existsSync(execution) ? [[execution, 'validate'], [execution, 'selftest']] : [])]) {
  const result = spawnSync(runtime[0], [...runtime[1], '-B', '-X', 'utf8', ...args],
    { cwd: project, windowsHide: true, shell: false, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
console.log('Reference integrity and preserved baseline checked; semantic understanding, user acceptance and deployment remain separate.');
