import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyGalaxyGenesis } from '../galaxy-guid.mjs';
import { writeJson, writePrivateText } from './files.mjs';

export const INITIALIZATION_JOURNAL = '.galaxy-initialization.json';
const json = value => `${JSON.stringify(value, null, 2)}\n`;

function validate(record) {
  try {
    if (record.version !== 1 || !verifyGalaxyGenesis(record.identity.id, record.identity.genesisProof)
      || record.publicKeyPem !== record.identity.genesisProof.publicKeyPem
      || createPublicKey(createPrivateKey(record.privateKeyPem)).export({ type: 'spki', format: 'pem' }) !== record.publicKeyPem
      || !Array.isArray(record.state.auditEvents) || record.state.auditEvents.length !== 1
      || record.state.auditEvents[0].subjectId !== record.identity.id
      || record.state.auditEvents[0].action !== 'galaxy_id.initialized') throw new Error();
  } catch { throw new Error('Invalid local initialization journal; preserve it for recovery review.'); }
}

async function optionalText(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Caller holds the Core write lock. Identity is the final public commit marker.
// Hooks are local test fault injection, never loaded from files or environment.
export async function publishInitialization(paths, record, afterWrite = async () => {}) {
  validate(record);
  const journal = join(paths.dataDir, INITIALIZATION_JOURNAL);
  const saved = await optionalText(journal);
  if (saved === null) await writeJson(journal, record);
  else if (saved !== json(record)) throw new Error('Conflicting local initialization journal.');
  await afterWrite('journal');
  const files = [
    ['private-key', paths.privateKey, record.privateKeyPem],
    ['public-key', paths.publicKey, record.publicKeyPem],
    ['state', paths.state, json(record.state)],
    ['identity', paths.identity, json(record.identity)],
  ];
  // Detect all conflicts before filling any missing file. Never replace material
  // that could belong to a different identity or contain later user facts.
  const present = await Promise.all(files.map(async ([, path, expected]) => {
    const current = await optionalText(path);
    if (current !== null && current !== expected) throw new Error('Conflicting local initialization files; recovery stopped.');
    return current !== null;
  }));
  for (let i = 0; i < files.length; i++) {
    const [phase, path, text] = files[i];
    if (!present[i]) await writePrivateText(path, text);
    await afterWrite(phase);
  }
  await unlink(journal);
  return record.identity;
}

export async function resumeInitialization(paths) {
  const journal = join(paths.dataDir, INITIALIZATION_JOURNAL);
  let info;
  try { info = await stat(journal); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!info.isFile() || info.size > 32768 || (process.platform !== 'win32' && (info.mode & 0o077)))
    throw new Error('Unsafe local initialization journal; recovery stopped.');
  let record;
  try { record = JSON.parse(await readFile(journal, 'utf8')); }
  catch { throw new Error('Unreadable local initialization journal; preserve for recovery review.'); }
  await publishInitialization(paths, record);
  return true;
}
