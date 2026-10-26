import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const checker = fileURLToPath(new URL('../tools/docs.py', import.meta.url));
/** @type {Array<[string, string[]]>} */
const candidates = process.env.GALAXY_PYTHON
  ? [[process.env.GALAXY_PYTHON, []]]
  : process.platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []]];
const runtime = candidates.find(([binary, args]) => {
  const probe = spawnSync(binary, [...args, '-B', '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'],
    { cwd: root, windowsHide: true, shell: false, stdio: 'ignore' });
  return !probe.error && probe.status === 0;
});
if (!runtime) {
  console.error('Python >=3.10 is required. Set GALAXY_PYTHON to an installed interpreter.');
  process.exit(2);
}
const result = spawnSync(runtime[0], [...runtime[1], '-B', '-X', 'utf8', checker, ...process.argv.slice(2)],
  { cwd: root, windowsHide: true, shell: false, stdio: 'inherit' });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exitCode = result.status ?? 1;
