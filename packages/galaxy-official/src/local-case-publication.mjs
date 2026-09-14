import { randomUUID, createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { withLocalRead, withLocalWrite } from '../../galaxy-core/src/storage/write-lock.mjs';
import { localPaths, readJson, writeJson } from '../../galaxy-core/src/storage/files.mjs';
import { verifyGalaxyGenesis } from '../../galaxy-core/src/galaxy-guid.mjs';
import { caseEventSchema } from './shared/cases-schema.mjs';
import { validatePublicUrl } from './public-fetch.mjs';
import { consentSchema } from './shared/consents-schema.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function load(directory) {
  const paths = localPaths(directory);
  for (const path of [paths.initializationJournal, paths.resetJournal]) {
    try { await lstat(path); throw new Error('Local recovery required.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const identity = await readJson(paths.identity, null), state = await readJson(paths.state, null);
  if (!identity || !state?.integration || !verifyGalaxyGenesis(identity.id, identity.genesisProof))
    throw new Error('Initialized local identity required.');
  return { paths, identity, state };
}
function canonical(endpoint) {
  if (validatePublicUrl(endpoint).origin !== endpoint) throw new Error('Canonical endpoint required.');
}
function key(endpoint, subjectId, localCaseId) { return hash(JSON.stringify([endpoint, subjectId, localCaseId])); }

export async function getLocalCasePublication(dataDirectory, endpoint, localCaseId) {
  canonical(endpoint);
  return withLocalRead(dataDirectory, async directory => {
    const { state, identity } = await load(directory);
    return state.casePublications?.[key(endpoint, identity.id, localCaseId)] ?? null;
  });
}

// No network or key access. Only explicit prepare persists a frozen outbound draft.
export async function listLocalPublicationCases(dataDirectory, endpoint) {
  canonical(endpoint);
  return withLocalRead(dataDirectory, async directory => {
    const { state, identity } = await load(directory);
    return state.cases.filter(item => item.galaxyId === identity.id).map(item => {
      const record = state.casePublications?.[key(endpoint, identity.id, item.id)];
      return { localCaseId: item.id, title: item.title, status: record?.status ?? 'not-prepared',
        eventId: record?.eventId ?? null, endpoint };
    });
  });
}

export async function prepareLocalCasePublication(dataDirectory, endpoint, localCaseId) {
  canonical(endpoint);
  return withLocalWrite(dataDirectory, async directory => {
    const { paths, state, identity } = await load(directory);
    const local = state.cases.find(item => item.id === localCaseId && item.galaxyId === identity.id);
    if (!local) throw new Error('Local Case not found.');
    const mappingKey = key(endpoint, identity.id, localCaseId);
    const existing = state.casePublications?.[mappingKey];
    if (existing) return existing;
    const eventId = randomUUID();
    const event = caseEventSchema.parse({ kind: 'case', id: eventId, localRef: `local:${mappingKey}`,
      title: local.title, summary: local.failureSummary, source: { kind: 'local', reference: `local:${mappingKey}` },
      participants: [{ subjectId: identity.id, role: 'requester' }] });
    const payloadJson = JSON.stringify(event);
    const record = { version: 1, endpoint, subjectId: identity.id, localCaseId, eventId, payloadJson,
      payloadHash: hash(payloadJson), status: 'prepared', createdAt: new Date().toISOString(), receipt: null };
    state.casePublications ??= {};
    state.casePublications[mappingKey] = record;
    await writeJson(paths.state, state);
    return record;
  });
}

// Call only with the CaseClient acknowledgement, after its receipt checks succeed.
export async function recordLocalCasePublication(dataDirectory, endpoint, localCaseId, receipt) {
  canonical(endpoint);
  return withLocalWrite(dataDirectory, async directory => {
    const { paths, state, identity } = await load(directory);
    const record = state.casePublications?.[key(endpoint, identity.id, localCaseId)];
    if (!record || receipt?.caseId !== record.eventId || receipt.eventId !== record.eventId
      || receipt.version !== 1 || receipt.verification !== 'unverified') throw new Error('Publication receipt mismatch.');
    record.status = 'acknowledged';
    record.receipt = { caseId: receipt.caseId, eventId: receipt.eventId, version: 1, verification: 'unverified' };
    record.acknowledgedAt = new Date().toISOString();
    await writeJson(paths.state, state);
    return record;
  });
}

export async function saveLocalCasePublicationConsent(dataDirectory, endpoint, localCaseId, input) {
  canonical(endpoint);
  const intent = consentSchema.parse(input);
  return withLocalWrite(dataDirectory, async directory => {
    const { paths, state, identity } = await load(directory);
    const record = state.casePublications?.[key(endpoint, identity.id, localCaseId)];
    if (!record || intent.subjectId !== identity.id || intent.endpoint !== endpoint || intent.recipient !== endpoint
      || intent.objectId !== record.eventId || intent.payloadHash !== record.payloadHash || intent.action !== 'case.teaser.publish'
      || JSON.stringify(intent.fields) !== JSON.stringify(Object.keys(JSON.parse(record.payloadJson))))
      throw new Error('Publication Consent mismatch.');
    if (record.consentIntent) {
      if (JSON.stringify(record.consentIntent) !== JSON.stringify(intent)) throw new Error('Publication Consent already frozen.');
      return record;
    }
    record.consentIntent = intent;
    await writeJson(paths.state, state);
    return record;
  });
}
