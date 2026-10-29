import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Small, explicit component regressions. The full domain suites remain directly
// selectable with go test; compilation and platform acceptance are separate.
export const componentPackages = Object.freeze({
  hub: ['./internal/databaseschema', './internal/runtimeconfig', './internal/httpboundary',
    './internal/operationspermissions', './internal/operationsstrategies'],
  'native-client': ['./internal/native', './internal/localdata'],
});

export function checkGo(component, { env = process.env } = {}) {
  const packages = componentPackages[component];
  if (!packages) throw new Error('Usage: node scripts/check-go.mjs hub|native-client');
  console.log(`[galaxy-go-check] ${component}: ${packages.join(' ')}`);
  if (!env.GALAXY_GO_TEST_PG_BIN)
    console.log('[galaxy-go-check] Isolated PostgreSQL integration is not configured; its skipped tests are not behavior acceptance.');
  const result = spawnSync(env.GALAXY_BUILD_GO || 'go', ['test', '-count=1', ...packages], {
    cwd: fileURLToPath(new URL('../go/', import.meta.url)), env, stdio: 'inherit', shell: false, windowsHide: true,
  });
  if (result.error) console.error(`[galaxy-go-check] ${result.error.message}`);
  return result.status ?? 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = checkGo(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
