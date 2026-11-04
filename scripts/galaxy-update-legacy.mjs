import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origin = 'https://agigalaxy.org';
// Pin the existing standalone verifier before invoking downloaded JavaScript.
const verifierHash = '13276924d1bc06ec580e99b536c23767686fed50c89bf413b7e8457610262a1e';
const os = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];

async function download(path, limit) {
  const response = await fetch(origin + path, {
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok || !response.body) throw Error(`Download failed with HTTP ${response.status}`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw Error('Official download exceeds size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

let temp;
try {
  if (!os || !arch) throw Error('Unsupported system or processor');
  const index = JSON.parse(await download('/release.json', 2 << 20));
  const version = index.currentNativeClient?.version;
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw Error('Invalid official version');
  }
  const base = `/downloads/native/${version}/`;
  const filename = `galaxy-native-go-${version}-${os}-${arch}.tgz`;
  const verifier = 'verify-native-client-download.mjs';
  temp = await mkdtemp(join(tmpdir(), 'galaxy-update-'));
  const verifiedScript = await download(base + verifier, 2 << 20);
  if (createHash('sha256').update(verifiedScript).digest('hex') !== verifierHash) {
    throw Error('Official release verifier differs from the trusted copy');
  }
  await writeFile(join(temp, verifier), verifiedScript);
  await Promise.all([
    [filename, 64 << 20],
    [filename + '.jws', 64 << 10],
    [filename + '.report.json', 256 << 10],
  ].map(async ([name, limit]) => writeFile(join(temp, name), await download(base + name, limit))));
  execFileSync(process.execPath, [join(temp, verifier), temp, filename], { stdio: 'inherit' });
  const candidate = join(temp, 'client');
  await mkdir(candidate);
  execFileSync('tar', ['-xf', join(temp, filename), '-C', candidate], { stdio: 'inherit' });
  const executable = join(candidate, os === 'windows' ? 'galaxy.exe' : 'galaxy');
  execFileSync(executable, ['update', ...process.argv.slice(2), '--package-dir', candidate], { stdio: 'inherit' });
} catch (error) {
  console.error(error.message);
  process.exitCode = error.status || 1;
} finally {
  if (temp) await rm(temp, { recursive: true, force: true });
}
