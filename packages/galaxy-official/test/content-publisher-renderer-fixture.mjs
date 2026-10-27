// Legacy renderer sentinel used to prove that dynamic publication never executes a renderer process.
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {isAbsolute, join, relative, sep} from 'node:path';

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) options.set(process.argv[index], process.argv[index + 1]);
const site = options.get('--site'), input = options.get('--snapshot'), media = options.get('--media-dir');
if (![site, input, media].every(value => typeof value === 'string' && isAbsolute(value))) process.exit(24);
const snapshot = JSON.parse(await readFile(input, 'utf8'));
if (snapshot.settings.siteTitle === '__fixture_renderer_failure__') process.exit(23);
const local = path => {const value = relative(site, path); return value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value);};
await writeFile(join(site, 'renderer-invocation.json'), JSON.stringify({
  selectedFiles: (await readdir(media)).sort(), inputInsideCandidate: local(input), mediaInsideCandidate: local(media),
}));
await writeFile(join(site, 'index.html'), 'Rendered selected publication: ' + snapshot.settings.siteTitle);
