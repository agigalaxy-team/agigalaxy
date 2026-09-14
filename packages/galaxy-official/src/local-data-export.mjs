import { open, mkdtemp, writeFile, rename, lstat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { exportDatasets } from './shared/data-export-schema.mjs';
import { createHash } from 'node:crypto';

// Trusted host composition only; the portable client never writes a local file.
export async function saveDataExport(client, id, parent, { signal } = {}) {
  if (!isAbsolute(parent) || !(await lstat(parent)).isDirectory()) throw new Error('Choose an existing absolute export directory.');
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(parent, 'galaxy-export-')), handles = new Map(), hashes = new Map();
  let bytes = 0;
  try {
    const manifest = await client.download(id, { signal, onPage: async page => {
      if (!exportDatasets.includes(page.dataset)) throw new Error('Unknown export dataset.');
      signal?.throwIfAborted();
      if (!handles.has(page.dataset)) { handles.set(page.dataset, await open(join(directory, `${page.dataset}.ndjson.partial`), 'wx', 0o600)); hashes.set(page.dataset, createHash('sha256')); }
      const data = page.items.map(item => JSON.stringify(item) + '\n').join('');
      bytes += Buffer.byteLength(data);
      if (bytes > 1073741824) throw new Error('Local export exceeds1GiB; incomplete files retained.');
      await handles.get(page.dataset).writeFile(data); hashes.get(page.dataset).update(data);
    } });
    for (const handle of handles.values()) await handle.close(); handles.clear();
    signal?.throwIfAborted();
    const files = {};
    for (const [dataset, hash] of hashes) {
      await rename(join(directory, `${dataset}.ndjson.partial`), join(directory, `${dataset}.ndjson`));
      files[`${dataset}.ndjson`] = hash.digest('hex');
    }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest, files }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { directory, complete: true, files: Object.keys(files).length, totalRows: manifest.totalRows, bytes };
  } catch (error) {
    await writeFile(join(directory, 'incomplete.json'), JSON.stringify({ complete: false, bytes, partialFiles: [...hashes.keys()],
      reason: signal?.aborted ? 'canceled' : 'download-failed' }), { flag: 'wx', mode: 0o600 });
    const failure = new Error(`Export incomplete; partial files retained in ${directory}`); failure.cause = error; throw failure;
  } finally { await Promise.allSettled([...handles.values()].map(handle => handle.close())); }
}
