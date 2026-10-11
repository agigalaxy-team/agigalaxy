import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = process.platform === 'win32' ? [['py', '-3'], ['python']] : [['python3'], ['python']];
const python = candidates.find(([command, ...args]) => spawnSync(command, [...args, '--version'], { stdio: 'ignore', windowsHide: true }).status === 0);
if (!python) throw new Error('Website builds require Python 3.11 or newer. Install Python, then run npm run build again.');
const siteOnly = process.argv.includes('--site-only');
const websiteArgs = process.argv.slice(2).filter((value) => value !== '--site-only');

for (const [command, args] of [
  [python[0], [...python.slice(1), '-X', 'utf8', 'apps/galaxy-site/build.py', ...websiteArgs]],
  ...(siteOnly ? [] : [[process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'packages/galaxy-web/vite.config.mjs']]]),
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
