import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argumentsList = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < argumentsList.length; index += 2) {
  const name = argumentsList[index];
  const value = argumentsList[index + 1];
  if (!['--keycloak-dir', '--jdk-dir', '--out', '--with-tests'].includes(name) || value === undefined) {
    throw new Error('Usage: node build.mjs --keycloak-dir <26.7.3> --jdk-dir <JDK21> --out <new-directory> [--with-tests true]');
  }
  if (options.has(name)) throw new Error(`Duplicate option: ${name}`);
  options.set(name, value);
}
for (const required of ['--keycloak-dir', '--jdk-dir', '--out']) {
  if (!options.has(required)) throw new Error(`Missing option: ${required}`);
}
const keycloak = path.resolve(options.get('--keycloak-dir'));
const jdk = path.resolve(options.get('--jdk-dir'));
const output = path.resolve(options.get('--out'));
if (output === here || output.startsWith(`${here}${path.sep}`) || output === keycloak || output.startsWith(`${keycloak}${path.sep}`)) {
  throw new Error('Output must be a separate new candidate directory');
}
const libraries = path.join(keycloak, 'lib', 'lib', 'main');
const libraryNames = await readdir(libraries);
if (!libraryNames.includes('org.keycloak.keycloak-services-26.7.3.jar')) throw new Error('This provider targets Keycloak 26.7.3');
const executable = (name) => path.join(jdk, 'bin', `${name}${process.platform === 'win32' ? '.exe' : ''}`);
for (const name of ['javac', 'jar', 'java']) await stat(executable(name));
try {
  if ((await readdir(output)).length) throw new Error('Output directory must be new or empty');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(output, { recursive: true });
const classes = path.join(output, 'classes');
await mkdir(classes);

async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? sources(path.join(directory, entry.name))
    : entry.name.endsWith('.java') ? [path.join(directory, entry.name)] : []));
  return nested.flat().sort();
}
function execute(name, args) {
  const result = spawnSync(executable(name), args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} exited with status ${result.status}`);
}
const classpath = path.join(libraries, '*');
const mainSources = await sources(path.join(here, 'src', 'main', 'java'));
execute('javac', ['-encoding', 'UTF-8', '--release', '21', '-cp', classpath, '-d', classes, ...mainSources]);
await cp(path.join(here, 'src', 'main', 'resources'), classes, { recursive: true });
const jarPath = path.join(output, 'galaxy-email-code-26.7.3.jar');
execute('jar', ['--create', '--file', jarPath, '-C', classes, '.']);
let testClasses;
if (options.get('--with-tests') === 'true') {
  testClasses = path.join(output, 'test-classes');
  await mkdir(testClasses);
  const tests = await sources(path.join(here, 'src', 'test', 'java'));
  execute('javac', ['-encoding', 'UTF-8', '--release', '21', '-cp', `${classes}${path.delimiter}${classpath}`, '-d', testClasses, ...tests]);
}
await writeFile(path.join(output, 'provider.json'), `${JSON.stringify({
  keycloakVersion: '26.7.3',
  javaRelease: 21,
  jar: path.basename(jarPath),
  requiredAction: 'VERIFY_EMAIL',
  requiredActionOrder: 100,
  defaultCodeRealms: ['galaxy'],
  defaultActive: false,
  enableKey: 'email-code-enabled',
  resetAuthenticator: 'galaxy-reset-email-code',
  resetChooseUser: 'galaxy-reset-choose-user',
  registrationAction: 'galaxy-registration-user-creation',
  registrationPasswordGuard: 'UPDATE_PASSWORD',
  templates: { login: 'galaxy-email-code.ftl', email: 'galaxy-email-code.ftl' },
  defaults: { 'code-ttl-seconds': '600', 'resend-seconds': '60', 'max-attempts': '5' },
  testClasses: testClasses ? path.basename(testClasses) : null,
}, null, 2)}\n`, 'utf8');
// Read only our own package metadata; the build never reads a realm export,
// provider configuration, SMTP setting, database or user session.
const metadata = JSON.parse(await readFile(path.join(output, 'provider.json'), 'utf8'));
process.stdout.write(`${JSON.stringify({ jar: jarPath, keycloakVersion: metadata.keycloakVersion, compiledTests: Boolean(testClasses) })}\n`);
