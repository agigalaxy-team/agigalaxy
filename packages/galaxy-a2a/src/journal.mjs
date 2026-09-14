import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { withLocalRead, withLocalWrite } from '../../galaxy-core/src/storage/write-lock.mjs';
import { writeJson } from '../../galaxy-core/src/storage/files.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
const LIMIT = 8 * 1024 * 1024;

// One private journal per local actor, Official, peer, tenant and peer principal.
// A dispatch reservation survives restart: an unknown send is never replayed.
export function createJournal(directory, scope) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('Explicit A2A data directory required.');
  const scopeHash = hash(JSON.stringify(scope));
  const filename = `a2a-${scopeHash}.json`;
  async function load(root) {
    let file;
    try {
      file = await open(join(root, filename), 'r');
      const { size } = await file.stat();
      if (size > LIMIT) throw new Error('A2A journal limit exceeded.');
      const bytes = Buffer.alloc(size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > size) throw new Error('A2A journal changed while reading.');
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)));
      if (data.version !== 1 || data.scopeHash !== scopeHash || !Array.isArray(data.links) || data.links.length > 1000)
        throw new Error('Invalid A2A journal.');
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, scopeHash, links: [] };
      throw error;
    } finally { await file?.close(); }
  }
  const read = () => withLocalRead(directory, load);
  async function get(id) {
    const link = (await read()).links.find(item => item.id === id);
    if (!link) throw new Error('A2A association not found in this scope.');
    return link;
  }
  async function change(id, revision, update) {
    return withLocalWrite(directory, async root => {
      const data = await load(root);
      const index = data.links.findIndex(item => item.id === id);
      const previous = index < 0 ? null : data.links[index];
      if ((previous?.revision ?? 0) !== revision) throw new Error('A2A association changed; refresh before retrying.');
      const next = update(previous);
      if (index < 0) {
        if (data.links.length >= 1000 || data.links.some(item => item.caseId === next.caseId && item.attemptId === next.attemptId))
          throw new Error('A2A Attempt already dispatched or journal full.');
        data.links.push(next);
      } else data.links[index] = next;
      next.revision = revision + 1;
      if (Buffer.byteLength(JSON.stringify(data, null, 2)) + 1 > LIMIT) throw new Error('A2A journal limit exceeded.');
      await writeJson(join(root, filename), data);
      return structuredClone(next);
    });
  }
  return { get, change, list: async () => (await read()).links, scopeHash };
}
