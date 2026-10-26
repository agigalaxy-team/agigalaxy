import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), options = new Map();
for (let i = 0; i < argv.length; i += 2) {
  if (!['--keycloak-dir', '--jdk-dir', '--out', '--with-tests', '--run-tests'].includes(argv[i])
    || argv[i + 1] === undefined || options.has(argv[i])) throw Error('Invalid provider build options.');
  options.set(argv[i], argv[i + 1]);
}
for (const key of ['--keycloak-dir', '--jdk-dir', '--out']) if (!options.has(key)) throw Error('Missing option: ' + key);
const keycloak = path.resolve(options.get('--keycloak-dir')), jdk = path.resolve(options.get('--jdk-dir'));
const output = path.resolve(options.get('--out'));
for (const protectedRoot of [here, keycloak]) if (output === protectedRoot || output.startsWith(protectedRoot + path.sep))
  throw Error('Build output must be a separate new candidate directory.');
try { if ((await readdir(output)).length) throw Error('Build output must be new or empty.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const libraries = path.join(keycloak, 'lib', 'lib', 'main');
if (!(await readdir(libraries)).includes('org.keycloak.keycloak-services-26.7.3.jar')) throw Error('Keycloak 26.7.3 is required.');
const executable = name => path.join(jdk, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
for (const name of ['javac', 'jar', 'java']) await stat(executable(name));
await mkdir(output, { recursive: true });
const classes = path.join(output, 'classes'); await mkdir(classes);
async function sources(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(item => item.isDirectory()
    ? sources(path.join(directory, item.name)) : item.name.endsWith('.java') ? [path.join(directory, item.name)] : []))).flat().sort();
}
function execute(name, args) {
  const result = spawnSync(executable(name), args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(name + ' exited with status ' + result.status);
}
const classpath = path.join(libraries, '*');
execute('javac', ['-encoding', 'UTF-8', '--release', '21', '-cp', classpath, '-d', classes,
  ...await sources(path.join(here, 'src', 'main', 'java'))]);
await cp(path.join(here, 'src', 'main', 'resources'), classes, { recursive: true });
const jar = path.join(output, 'galaxy-management-email-change-26.7.3.jar');
execute('jar', ['--create', '--file', jar, '-C', classes, '.']);
const testClasses = path.join(output, 'test-classes');
const withTests = options.get('--with-tests') === 'true' || options.get('--run-tests') === 'true';
if (withTests) {
  await mkdir(testClasses);
  execute('javac', ['-encoding', 'UTF-8', '--release', '21', '-cp', classes + path.delimiter + classpath,
    '-d', testClasses, ...await sources(path.join(here, 'src', 'test', 'java'))]);
}
if (options.get('--run-tests') === 'true') execute('java', ['-cp', [testClasses, classes, classpath, path.join(keycloak, 'lib', 'lib', 'boot', '*')].join(path.delimiter),
  'org.agigalaxy.keycloak.management.ManagementEmailChangeTest']);
await writeFile(path.join(output, 'provider.json'), JSON.stringify({
  keycloakVersion: '26.7.3', javaRelease: 21, jar: path.basename(jar), providerId: 'galaxy-management',
  realm: 'galaxy-operations', writerClientId: 'galaxy-management-account-maintenance',
  tokenType: 'update-email', template: 'email-update-confirmation.ftl',
  overridesBuiltInProvider: false, changesRealmPolicy: false, nativeTestsRun: options.get('--run-tests') === 'true',
}, null, 2) + '\n');
process.stdout.write(JSON.stringify({ jar, compiledTests: withTests, nativeTestsRun: options.get('--run-tests') === 'true' }) + '\n');
