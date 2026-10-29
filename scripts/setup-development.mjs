import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || major === 24 && minor < 13) throw new Error('Full product development requires Node.js 24.13 or newer.');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run setup from the repository root.');

for (const directory of ['.', 'packages/galaxy-contracts', 'packages/galaxy-client', 'packages/galaxy-official', 'packages/galaxy-a2a', 'integrations/native-v2/compact-app']) {
  process.stdout.write(`Installing locked development dependencies: ${directory}\n`);
  const result = spawnSync(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: path.resolve(root, directory), stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
