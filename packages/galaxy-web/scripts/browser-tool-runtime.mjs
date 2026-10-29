import { chromium as installedChromium } from 'playwright';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

