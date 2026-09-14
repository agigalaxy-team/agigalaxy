import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import * as z from 'zod/v4';
import { withLocalRead, withLocalWrite } from '../../galaxy-core/src/storage/write-lock.mjs';
import { readJson, writeJson, localPaths } from '../../galaxy-core/src/storage/files.mjs';
import { verifyGalaxyGenesis } from '../../galaxy-core/src/galaxy-guid.mjs';
import { helpSessionCreateSchema, helpSessionSchema } from './shared/help-schema-v2.mjs';
import { validatePublicUrl } from './public-fetch.mjs';

// Selected references and brief user-visible explanations stay on the user's
// device. No credentials, signed payloads, raw search pages or private reasoning.
export function createLocalHelpStoreV2({ dataDirectory, endpoint, subjectId, now = () => Math.floor(Date.now() / 1000), readIdentityWithin }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !/^GUID[0-9A-Z]{28}$/.test(subjectId)) throw new Error('help_scope_invalid');
  const scope = createHash('sha256').update(JSON.stringify([endpoint, subjectId])).digest('hex');
  const folder = directory => join(directory, 'help-v2', scope);
  const path = (directory, id) => join(folder(directory), z.uuid().parse(id) + '.json');
  async function guard(directory) {
    const paths = localPaths(directory), identity = readIdentityWithin ? await readIdentityWithin(directory) : await readJson(paths.identity, null);
    if (!identity || identity.id !== subjectId || !verifyGalaxyGenesis(identity.id, identity.genesisProof)
      || await readJson(paths.initializationJournal, null) || await readJson(paths.resetJournal, null)) throw new Error('help_identity_changed');
  }
  async function load(directory, id) {
    await guard(directory);
    const raw = await readJson(path(directory, id), null);
    if (!raw) throw new Error('help_session_not_found');
    const row = helpSessionSchema.parse(raw);
    if (row.endpoint !== endpoint || row.subjectId !== subjectId || row.id !== id) throw new Error('help_scope_mismatch');
    return row;
  }
  const get = id => withLocalRead(dataDirectory, directory => load(directory, id));
  async function create(input) {
    const values = helpSessionCreateSchema.parse(input);
    return withLocalWrite(dataDirectory, async directory => {
      await guard(directory); const at = now();
      const row = helpSessionSchema.parse({ schemaVersion: 2, id: randomUUID(), revision: 1, endpoint, subjectId, ...values,
        createdAt: at, updatedAt: at, pauseState: 'active', basis: [], offers: [], selectedHelpIds: [], queries: [],
        linkedOperations: [], selectionEffect: 'local-choice-only', cloudSync: 'off' });
      await mkdir(folder(directory), { recursive: true, mode: 0o700 }); await writeJson(path(directory, row.id), row); return row;
    });
  }
  // A synchronous mutator avoids holding the local write lock during remote I/O.
  async function update(id, change, expectedRevision) {
    return withLocalWrite(dataDirectory, async directory => {
      const row = await load(directory, id);
      if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new Error('help_session_changed');
      const original = { id: row.id, endpoint: row.endpoint, subjectId: row.subjectId, localTaskRef: row.localTaskRef, createdAt: row.createdAt };
      const result = change(row);
      if (result?.then) throw new Error('help_async_mutation_forbidden');
      Object.assign(row, original, { revision: row.revision + 1, updatedAt: now() });
      const parsed = helpSessionSchema.parse(row);
      if (Buffer.byteLength(JSON.stringify(parsed)) > 524288) throw new Error('help_local_storage_full');
      await writeJson(path(directory, id), parsed); return parsed;
    });
  }
  async function forget(id) {
    return withLocalWrite(dataDirectory, async directory => {
      await load(directory, id); await rm(path(directory, id));
      return { id, deleted: true, localOnly: true, remoteOperationsCanceled: false };
    });
  }
  return { create, get, update, forget, endpoint, subjectId };
}
