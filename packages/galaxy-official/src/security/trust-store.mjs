import { open, readFile, lstat, rename, unlink, mkdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { verifyKeyring } from "../verification/keyring.mjs";

// Public trust metadata only. This store is distinct from the local identity,
// connection intentions and credential store. Call only on explicit discovery.
export async function acceptKeyring(document, { endpoint, rootPins, directory, now }) {
  if (!isAbsolute(directory)) throw new Error('Absolute trust-state directory required.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe trust-state directory.');
  const name = createHash('sha256').update(endpoint).digest('hex');
  const path = join(directory, `${name}.json`);
  const lockPath = join(directory, `${name}.lock`);
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
  // A stale lock is an explicit recovery condition, not permission to overwrite.
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    let previousState = null;
    try {
      const stateInfo = await lstat(path);
      if (!stateInfo.isFile() || stateInfo.isSymbolicLink() || stateInfo.size > 1048576)
        throw new Error('Invalid trust state.');
      previousState = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const accepted = await verifyKeyring(document, { endpoint, rootPins, previousState, now });
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(accepted.nextState) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    // Keys are returned only after state persistence succeeded.
    return accepted;
  } finally {
    try { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    finally { await lock.close(); await unlink(lockPath); }
  }
}
