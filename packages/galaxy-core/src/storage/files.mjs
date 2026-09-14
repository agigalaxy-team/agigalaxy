import {readFile, rename, writeFile, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

export const DEFAULT_DIRECTORY_NAME = '.galaxy';

export const DEFAULT_DATA_DIR = join(homedir(), DEFAULT_DIRECTORY_NAME);

export function localPaths(dataDir) {
  return {
    dataDir,
    identity: join(dataDir, 'galaxy-id.json'),
    privateKey: join(dataDir, 'galaxy-id-private-key.pem'),
    publicKey: join(dataDir, 'galaxy-id-public-key.pem'),
    state: join(dataDir, 'galaxy-local-state.json'),
    initializationJournal: join(dataDir, '.galaxy-initialization.json'),
    resetJournal: join(dataDir, '.galaxy-reset.json'),
    legacyIdentity: join(dataDir, 'node.json'),
    legacyPrivateKey: join(dataDir, 'node-private-key.pem'),
    legacyPublicKey: join(dataDir, 'node-public-key.pem'),
    legacyState: join(dataDir, 'local-state.json'),
  };
}

export function resolveDataDir(dataDir) {
  return resolve(dataDir || process.env.GALAXY_DATA_DIR || DEFAULT_DATA_DIR);
}

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

export async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function migrateLegacyFile(legacyPath, canonicalPath) {
  if (await fileExists(canonicalPath) || !(await fileExists(legacyPath))) {
    return false;
  }
  await rename(legacyPath, canonicalPath);
  return true;
}

export async function migrateLegacyLocalFiles(paths) {
  return Promise.all([
    migrateLegacyFile(paths.legacyIdentity, paths.identity),
    migrateLegacyFile(paths.legacyPrivateKey, paths.privateKey),
    migrateLegacyFile(paths.legacyPublicKey, paths.publicKey),
    migrateLegacyFile(paths.legacyState, paths.state),
  ]);
}

export async function writePrivateText(filePath, content) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally { await rm(temporaryPath, { force: true }); }
}

export async function writeJson(filePath, value) {
  await writePrivateText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
