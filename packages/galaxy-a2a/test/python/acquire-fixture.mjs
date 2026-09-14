import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const commit = '1bb0871294af52fdb2c7e5173e43fade0eb008ba';
const root = new URL('./vendor/', import.meta.url); await mkdir(root, { recursive: true });
const sources = [];
for (const [path, target] of [['samples/python/agents/helloworld/agent_executor.py', 'agent_executor.py'], ['LICENSE', 'LICENSE']]) {
  const url = `https://api.github.com/repos/a2aproject/a2a-samples/contents/${path}?ref=${commit}`;
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github.raw+json' } });
  if (!response.ok) throw new Error(`Public sample unavailable: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer()); await writeFile(new URL(target, root), bytes);
  sources.push({ path, url, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
}
const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
const requirements = report.install.map(p => `${p.metadata.name}==${p.metadata.version} --hash=sha256:${p.download_info.archive_info.hashes.sha256}`).sort();
await writeFile(new URL('./requirements.lock', import.meta.url), '# Python 3.12 isolated protocol test; exact wheels from the pip installation report.\n' + requirements.join('\n') + '\n');
await writeFile(new URL('./provenance.json', import.meta.url), JSON.stringify({ schemaVersion: 1, checkedAt: new Date().toISOString(),
  pythonSdk: '1.1.2', protocol: '1.0', jsSdk: '1.1.0', upstreamSampleSdkPin: '1.1.0',
  sampleCommit: commit, sampleLicense: 'Apache-2.0', sampleChanges: 'executor bytes unchanged; separate ephemeral HTTP wrapper',
  pypi: 'https://pypi.org/pypi/a2a-sdk/1.1.2/json',
  releaseDistinction: 'GitHub release 1.1.4 observed; PyPI latest available distribution was 1.1.2 at verification.', sources }, null, 2) + '\n');
