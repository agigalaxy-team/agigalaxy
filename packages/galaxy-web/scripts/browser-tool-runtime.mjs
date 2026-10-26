import { chromium as installedChromium } from 'playwright';
import { statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

// Tools get a new disposable browser; never attach to a person's browser/profile.
export const chromium = Object.freeze({
  launch(options = {}) {
    if (options.headless === false || options.channel || options.executablePath ||
        (options.args ?? []).some(arg => /^--(?:user-data-dir|profile-directory|remote-debugging|load-extension)/.test(arg))) {
      throw new Error('Browser tools require an isolated managed headless browser.');
    }
    return installedChromium.launch({ ...options, headless: true });
  },
});

export function browserToolOutput(moduleUrl, directory, variant) {
  const name = basename(fileURLToPath(moduleUrl), '.mjs');
  if (directory) return resolve(repository, directory);
  const destination = resolve(repository, 'outputs', name, 'tmp');
  if (!variant) return destination;
  if (!/^[a-zA-Z0-9_-]+$/.test(variant)) throw new Error('Invalid browser tool output variant.');
  return resolve(destination, variant);
}

export function requiredToolInput(variable, kind = 'directory') {
  const value = process.env[variable];
  if (!value || !isAbsolute(value)) throw new Error(`Set ${variable} to the absolute path of the prepared ${kind}.`);
  const info = statSync(value, { throwIfNoEntry: false });
  if (!info || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) {
    throw new Error(`${variable} does not name an existing ${kind}.`);
  }
  return value;
}

export function browserSourceUrl(relativePath) {
  return '/app/@fs/' + resolve(repository, relativePath).replaceAll('\\', '/');
}

export async function loadToolMcpClient() {
  // The client is a test-tool dependency, not a dependency of the Native artifact.
  const require = createRequire(new URL('../../../integrations/native-v2/compact-app/package.json', import.meta.url));
  return import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
}
