import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLocalContextExcerpt, CONTEXT_FILE_MAX_BYTES } from '../src/local-context-file.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-file-excerpt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, async write(name, text) { const path = join(directory, name); await writeFile(path, text); return path; } };
}

test('local file selection captures the requested Unicode lines, normalizes line endings and keeps an immutable text snapshot', async t => {
  const f = await fixture(t), path = await f.write('build.log', '\ufeffunselected header\r\n编译结果 ✓\r\nselected second line\r\nunselected tail\r\n');
  const excerpt = await readLocalContextExcerpt({ path, startLine: 2, endLine: 3 });
  assert.equal(excerpt.content, '编译结果 ✓\nselected second line'); assert.equal(excerpt.totalLines, 4);
  assert.equal(excerpt.label, 'build.log:2-3');
  assert.equal(excerpt.sha256, createHash('sha256').update(excerpt.content).digest('hex'));
  await writeFile(path, 'a changed file');
  assert.equal(excerpt.content, '编译结果 ✓\nselected second line');
});

test('file selection has explicit bounded lines, bytes and UTF-8 plain text, without implicit whole-file fallback', async t => {
  const f = await fixture(t), path = await f.write('range.txt', Array.from({ length: 201 }, () => 'line').join('\n'));
  for (const [startLine, endLine] of [[0,1],[2,1],[1,201],[1,202],[NaN,1],[1.5,2],[1,Number.MAX_SAFE_INTEGER + 1]])
    await assert.rejects(readLocalContextExcerpt({ path, startLine, endLine }), /line range/);
  assert.equal((await readLocalContextExcerpt({ path, startLine: 2, endLine: 201 })).content.split('\n').length, 200);
  await assert.rejects(readLocalContextExcerpt({ path, startLine: 202, endLine: 202 }), /201 lines/);
  const cases = [
    ['empty.txt','',/0 lines/], ['long.txt','x'.repeat(4001),/4000 characters/],
    ['large.log',Buffer.alloc(CONTEXT_FILE_MAX_BYTES + 1, 65),/8 MiB/],
    ['binary.log',Buffer.from([65,0,66]),/Binary/], ['invalid.txt',Buffer.from([0xff,0xfe,65]),/UTF-8/],
    ['ansi.log','\u001b[31mred\u001b[0m',/terminal-control/],
  ];
  for (const [name, text, error] of cases)
    await assert.rejects(readLocalContextExcerpt({ path: await f.write(name, text), startLine: 1, endLine: 1 }), error);
  await assert.rejects(readLocalContextExcerpt({ path: f.directory, startLine: 1, endLine: 1 }), /regular text file/);
  for (const path of ['relative.log','https://example.org/log','\\\\server\\share\\log.txt'])
    await assert.rejects(readLocalContextExcerpt({ path, startLine: 1, endLine: 1 }), /absolute local file/);
});

test('obvious credential locations are rejected before reading and selected secret-shaped text is rejected without redaction', async t => {
  const f = await fixture(t);
  for (const name of ['.env','.env.local','id_ed25519','private.pem','credentials.json','secrets.yaml'])
    await assert.rejects(readLocalContextExcerpt({ path: join(f.directory, name), startLine: 1, endLine: 1 }), /Credential files/);
  await mkdir(join(f.directory, '.ssh'));
  await assert.rejects(readLocalContextExcerpt({ path: join(f.directory, '.ssh', 'custom.txt'), startLine: 1, endLine: 1 }), /Credential files/);
  const path = await f.write('synthetic.log', '-----BEGIN PRIVATE KEY-----\nselected harmless diagnostic');
  await assert.rejects(readLocalContextExcerpt({ path, startLine: 1, endLine: 1 }), /Credential material/);
  assert.equal((await readLocalContextExcerpt({ path, startLine: 2, endLine: 2 })).content, 'selected harmless diagnostic');
});
