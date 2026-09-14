import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { decodeJwt } from 'jose';
import * as z from 'zod/v4';
import { withLocalRead, withLocalWrite } from '../../galaxy-core/src/storage/write-lock.mjs';
import { localPaths, writeJson } from '../../galaxy-core/src/storage/files.mjs';
import { verifyGalaxyGenesis } from '../../galaxy-core/src/galaxy-guid.mjs';
import { verifyBindingReceipt } from './verification/connection.mjs';

export const BINDING_RECEIPTS_FILE = 'galaxy-binding-receipts.json';
const recordSchema = z.strictObject({ version: z.literal(1), endpoint: z.string().max(2048),
  subjectId: z.string().regex(/^GUID[0-9A-Z]{28}$/), installationId: z.uuid(), bindingId: z.uuid(),
  scopes: z.array(z.string().regex(/^[a-z][a-z-]{0,63}$/)).min(1).max(16), bindingExpiresAt: z.number().int().nonnegative(),
  control:z.strictObject({deviceId:z.uuid(),keyId:z.string().regex(/^[a-f0-9]{64}$/),epoch:z.number().int().positive()}).optional(),
  receipt: z.string().min(1).max(24000), receivedAt: z.number().int().nonnegative() });
const archiveSchema = z.strictObject({ version: z.literal(1), records: z.array(recordSchema).max(128) });

async function readArchive(directory) {
  const path = join(directory, BINDING_RECEIPTS_FILE);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4194304) throw new Error('Invalid receipt archive.');
    return archiveSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) { if (error.code === 'ENOENT') return { version: 1, records: [] }; throw error; }
}

// Local historical records only. They never restore credentials or grant access.
async function readReceiptIdentity(directory) {
  const paths = localPaths(directory);
  for (const path of [paths.initializationJournal, paths.resetJournal]) {
    try { await lstat(path); throw new Error('Local recovery required.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const info = await lstat(paths.identity);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new Error('Invalid local identity.');
  const identity = JSON.parse(await readFile(paths.identity, 'utf8'));
  if (!verifyGalaxyGenesis(identity.id, identity.genesisProof)) throw new Error('Valid local identity required.');
  return identity;
}
export function createLocalBindingReceipts({ dataDirectory, endpoint, installationId, scopes, trustedKeys, now, readIdentity = readReceiptIdentity, assertCurrent = async () => false }) {
  async function verify(record, identity) {
    const claims = decodeJwt(record.receipt);
    return verifyBindingReceipt({ bindingId: record.bindingId, receipt: record.receipt }, {
      endpoint: record.endpoint, trustedKeys, now: record.receivedAt,
      challenge: { id: claims.data?.auditReference, data: { subjectId: identity.id, genesisProof: identity.genesisProof,
        installationId: record.installationId, scopes: record.scopes, bindingExpiresAt: record.bindingExpiresAt,...(record.control?{control:record.control}:{}) } },
    });
  }
  async function save(result, isCurrent) {
    // Pick fields explicitly: no takeCredential(), challenge, token or key body.
    const record = recordSchema.parse({ version: 1, endpoint: result.endpoint, subjectId: result.subjectId,
      installationId, bindingId: result.bindingId, scopes: [...result.scopes], bindingExpiresAt: result.bindingExpiresAt,
      ...(result.control?{control:result.control}:{}),
      receipt: result.receipt, receivedAt: now() });
    if (record.endpoint !== endpoint || !isDeepStrictEqual(record.scopes, scopes)) throw new Error('Receipt target changed.');
    return withLocalWrite(dataDirectory, async directory => {
      if (!isCurrent() || !await assertCurrent(directory)) throw new Error('Receipt recording canceled.');
      const identity = await readIdentity(directory);
      if (identity.id !== record.subjectId) throw new Error('Receipt identity changed.');
      await verify(record, identity);
      const archive = await readArchive(directory);
      const previous = archive.records.find(item => item.bindingId === record.bindingId && item.endpoint === endpoint);
      if (previous) {
        if (previous.receipt !== record.receipt) throw new Error('Conflicting binding receipt.');
        return { state: 'saved-locally', bindingId: record.bindingId };
      }
      if (archive.records.length >= 128) throw new Error('Binding receipt archive full.');
      archive.records.push(record);
      if (!isCurrent() || !await assertCurrent(directory)) throw new Error('Receipt recording canceled.');
      await writeJson(join(directory, BINDING_RECEIPTS_FILE), archive);
      return { state: 'saved-locally', bindingId: record.bindingId };
    });
  }
  async function list() {
    return withLocalRead(dataDirectory, async directory => {
      const identity = await readIdentity(directory), archive = await readArchive(directory);
      const records = [];
      for (const record of archive.records.filter(item => item.endpoint === endpoint && item.subjectId === identity.id)) {
        let verification = 'unverified';
        try { await verify(record, identity); verification = 'signature-verified-at-recorded-time'; } catch { /* Preserve the record, never promote it to active authorization. */ }
        records.push({ bindingId: record.bindingId, endpoint, subjectId: record.subjectId,
          installationId: record.installationId, scopes: [...record.scopes], receivedAt: record.receivedAt,
          bindingExpiresAt: record.bindingExpiresAt, verification,
          lifetime: now() >= record.bindingExpiresAt ? 'expired' : 'within-recorded-lifetime',
          configurationMatches: record.installationId === installationId && isDeepStrictEqual(record.scopes, scopes),
          remoteState: 'not-checked', connected: false, authorized: false });
      }
      return { records: records.reverse(), source: 'local-history', connected: false, authorized: false };
    });
  }
  return Object.freeze({ save, list });
}
