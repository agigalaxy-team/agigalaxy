import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDirectory, '..');
const repositoryRoot = process.env.GALAXY_INTEGRATION_REPO_ROOT
  ? resolve(process.env.GALAXY_INTEGRATION_REPO_ROOT)
  : resolve(pluginRoot, '../../../..');
const mcpEntry = resolve(repositoryRoot, 'packages/galaxy-edge-mcp/src/index.mjs');

if (!existsSync(mcpEntry)) {
  throw new Error(
    'Galaxy Integration Pack runtime is not present. This source plugin must be installed together with the Galaxy Founding Beta repository or a future bundled runtime.',
  );
}

const child = spawn(process.execPath, [mcpEntry], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => {
  console.error(`Galaxy Integration Pack could not start: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 0;
  }
});
