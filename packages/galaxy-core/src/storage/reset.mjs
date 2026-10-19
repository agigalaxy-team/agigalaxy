import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { readJson, writeJson } from './files.mjs';

// A reset has already been explicitly requested before entering this helper.
// The fixed allowlist is code-owned; journal data never supplies deletion paths.
export async function resetLocalFiles(paths, afterRemove = async () => {}) {
  const expected = { version: 1, operation: 'reset' };
  const marker = await readJson(paths.resetJournal, null);
  if (marker !== null && JSON.stringify(marker) !== JSON.stringify(expected)) throw new Error('Invalid local reset journal.');
  if (marker === null) await writeJson(paths.resetJournal, expected);
  const files = [paths.initializationJournal, paths.identity, paths.privateKey, paths.publicKey, paths.state,
    paths.legacyIdentity, paths.legacyPrivateKey, paths.legacyPublicKey, paths.legacyState];
  for (const path of files) {
    await rm(path, { force: true });
    await afterRemove(basename(path));
  }
  await rm(paths.resetJournal);
  return { dataDir: paths.dataDir, removedFiles: [...files, paths.resetJournal].map(path => basename(path)),
    retainedLocalAreas: ['work-history', 'conversation-archive', 'native-v2', 'workers', 'galaxy-upload-privacy.json'],
    message: 'Reset removes the listed local identity/configuration files. Separate work history, private conversation archives, Native records and Worker directories remain in their original locations. Export or delete owned work/archives through their dedicated tools before resetting if needed.',
    localOnly: true };
}
