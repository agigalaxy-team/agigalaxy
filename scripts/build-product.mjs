import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = process.platform === 'win32' ? [['py', '-3'], ['python']] : [['python3'], ['python']];
const python = candidates.find(([command, ...args]) => spawnSync(command, [...args, '--version'], { stdio: 'ignore', windowsHide: true }).status === 0);
if (!python) throw new Error('Website builds require Python 3.11 or newer. Install Python, then run npm run build again.');
const siteOnly = process.argv.includes('--site-only');
const websiteArgs = process.argv.slice(2).filter((value) => value !== '--site-only');
const webOutputIndex=websiteArgs.indexOf('--web-output');
let webOutput=path.join(root,'packages/galaxy-web/dist');
if(webOutputIndex!==-1){
  const selected=websiteArgs[webOutputIndex+1];
  if(!selected||selected.startsWith('--'))throw Error('Select an explicit Web output directory.');
  webOutput=path.resolve(root,selected);websiteArgs.splice(webOutputIndex,2);
  if(webOutput===root||root.startsWith(webOutput+path.sep))throw Error('Web output must be separate from repository sources.');
}
if(!siteOnly&&websiteArgs.includes('--web-dist'))throw Error('Use --web-output for a unified build; --web-dist selects an already completed Web build only with --site-only.');

for (const [command, args] of [
  ...(siteOnly ? [] : [[process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'packages/galaxy-web/vite.config.mjs','--outDir',webOutput]]]),
  [python[0], [...python.slice(1), '-X', 'utf8', 'apps/galaxy-site/build.py', ...websiteArgs,...(siteOnly?[]:['--web-dist',webOutput])]],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
