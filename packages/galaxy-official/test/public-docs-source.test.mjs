import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function isolatedCopy() {
  const root = await mkdtemp(join(tmpdir(), 'galaxy-public-docs-source-'));
  await mkdir(join(root, 'scripts'));
  await cp(join(packageRoot, 'scripts/build_public_docs.py'), join(root, 'scripts/build_public_docs.py'));
  await cp(join(packageRoot, 'public-docs'), join(root, 'public-docs'), {recursive: true});
  return root;
}
async function cleanup(root) {
  const target = resolve(root), parent = resolve(tmpdir());
  assert.equal(dirname(target), parent);
  assert.ok(basename(target).startsWith('galaxy-public-docs-source-'));
  assert.notEqual(target, parent);assert.ok(target.startsWith(parent + sep));
  await rm(target, {recursive: true});
}
function build(root, check = false) {
  const executable = process.platform === 'win32' ? 'py' : 'python3';
  const args = [...(process.platform === 'win32' ? ['-3'] : []), join(root, 'scripts/build_public_docs.py'), ...(check ? ['--check'] : [])];
  const child = spawnSync(executable, args, {cwd: root, encoding: 'utf8', env: {...process.env, PYTHONUTF8: '1'}, windowsHide: true});
  if (child.error) throw child.error;
  return child;
}
function passed(child) {assert.equal(child.status, 0, child.stderr || child.stdout);}

test('standalone package-local public source produces identical bundle/indices and exact historical bytes without project build scripts', async () => {
  const root = await isolatedCopy();
  try {
    passed(build(root));passed(build(root, true));
    const target = join(root, 'public-docs.json'), first = await readFile(target);
    const data = JSON.parse(first), manifest = JSON.parse(await readFile(join(root, 'public-docs/manifest.json')));
    assert.equal(data.version, manifest.currentVersion);
    assert.equal(data.sourceSha256, hash(await readFile(join(root, 'public-docs/manifest.json'))));
    assert.deepEqual(Object.keys(data.versions), manifest.versions.map(x => x.version));
    assert.deepEqual(data.topics, ['overview', 'installation', 'compatibility', 'privacy']);
    for (const version of manifest.versions) for (const [topic, item] of Object.entries(version.documents)) {
      const raw = await readFile(join(root, 'public-docs', item.path));
      assert.equal(hash(raw), item.sha256);
      assert.deepEqual(Buffer.from(data.versions[version.version][topic], 'utf8'), raw);
      assert.equal(data.documentHashes[version.version][topic], item.sha256);
      assert.equal(data.versionDates[version.version], version.documentDate);
    }
    const indices = {};
    for (const name of ['agent.md', 'llms.txt']) {
      indices[name] = await readFile(join(root, 'public-docs/generated', name));
      const text = indices[name].toString('utf8');
      for (const topic of data.topics) assert.ok(text.includes(`${manifest.publicOrigin}/docs/${data.version}/${topic}.md`));
      assert.equal(text.includes('public-docs v0.2'), false);
    }
    passed(build(root));assert.deepEqual(await readFile(target), first);
    for (const name of Object.keys(indices)) assert.deepEqual(await readFile(join(root, 'public-docs/generated', name)), indices[name]);
    await writeFile(join(root, 'public-docs/generated/agent.md'), 'stale index');
    assert.notEqual(build(root, true).status, 0, 'check rejects channel drift');
  } finally {await cleanup(root);}
});

test('public source rejects unreviewed topic/unknown metadata, missing current version, path escape and source byte drift', async () => {
  const root = await isolatedCopy();
  try {
    const path = join(root, 'public-docs/manifest.json'), original = await readFile(path), base = JSON.parse(original);
    const edits = [
      x => {x.topics.push('private');},
      x => {x.internalSource = '../internal-discussion.md';},
      x => {x.versions[0].documents.overview.internalField = 'not-reviewed';},
      x => {x.versions[0].documents.overview.path = '../outside.md';},
      x => {x.currentVersion = '0.1.999';},
      x => {x.versions.push(structuredClone(x.versions[0]));},
    ];
    for (const edit of edits) {
      const changed = structuredClone(base);edit(changed);await writeFile(path, JSON.stringify(changed));
      assert.notEqual(build(root).status, 0);
    }
    await writeFile(path, original);
    const source = join(root, 'public-docs', base.versions[0].documents.overview.path);
    const before = await readFile(source);await writeFile(source, Buffer.concat([before, Buffer.from('\nUnreviewed change\n')]));
    assert.notEqual(build(root).status, 0, 'hash pins reviewed bytes');
    await writeFile(source, before);passed(build(root));
  } finally {await cleanup(root);}
});
