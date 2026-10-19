import {resetLocalFiles} from '../storage/reset.mjs';
import {publishInitialization, resumeInitialization} from '../storage/initialization.mjs';
import {withLocalWrite,withLocalRead} from '../storage/write-lock.mjs';
import {generateKeyPairSync} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createGalaxyGenesis} from '../galaxy-guid.mjs';
import {listIntegrationModules,resolveGalaxyInitialization} from '../integration-modules.mjs';
import {localPaths,resolveDataDir,readJson,fileExists,migrateLegacyLocalFiles,writeJson} from '../storage/files.mjs';
import {STORE_VERSION,FORBIDDEN_DISCLOSURE_ITEMS,PERMITTED_DISCLOSURE_ITEMS,now,makeId,fingerprint,emptyState,normalizeState,addAuditEvent,assertText,requiredRecord,permittedIncludeList} from '../domain/local-model.mjs';
import {listUploadPrivacyLevels,normalizeUploadPrivacy,selectUploadPrivacy,allowedUploadDataTypes} from '../upload-privacy.mjs';

const localError = code => Object.assign(new Error(code), {code});

async function initializeUnlocked(dataDirectory, {subjectType, clientKind = 'normal'} = {}) {
  if (clientKind === 'worker' ? subjectType !== 'agent' : subjectType !== undefined && !['person', 'organization'].includes(subjectType))
    throw localError('local_identity_subject_type_invalid');
  const dataDir = resolveDataDir(dataDirectory);
  const paths = localPaths(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (await fileExists(paths.resetJournal)) await resetLocalFiles(paths);
  await migrateLegacyLocalFiles(paths);
  await resumeInitialization(paths);

  let identity = await readJson(paths.identity);
  if (identity && subjectType !== undefined && identity.subjectType !== subjectType)
    throw localError(identity.subjectType ? 'local_identity_type_immutable' : 'local_identity_legacy_type_unconfirmed');
  if (identity && identity.clientKind && identity.clientKind !== clientKind)
    throw localError('local_identity_client_kind_mismatch');
  if (!identity) {
    // A previous initializer may have stopped between writes. Never silently
    // replace its key material or attach old facts to a newly generated identity.
    const remnants = await Promise.all([paths.privateKey, paths.publicKey, paths.state].map(fileExists));
    if (remnants.some(Boolean)) throw new Error('Local Galaxy initialization is incomplete; preserve existing files and recover before creating an identity.');
    const keys = generateKeyPairSync('ed25519');
    const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicKeyFingerprint = fingerprint(publicKeyPem);
    const createdAt = now();
    const createdAtMs = Date.parse(createdAt);
    const genesis = createGalaxyGenesis({ publicKeyPem, issuedAtMs: createdAtMs, originCode: '0' });

    identity = {
      version: STORE_VERSION,
      id: genesis.id,
      genesisProof: genesis.genesisProof,
      idFormat: 'guid-32-v1',
      birthOrigin: 'local',
      birthOriginCode: '0',
      subjectType: subjectType ?? 'person',
      clientKind,
      publicKeyFingerprint,
      keyAlgorithm: 'Ed25519',
      createdAt,
      localOnly: true,
      transport: 'none',
      note: 'This Galaxy ID was created locally. It has not been registered, verified, or uploaded.',
    };

    const state = emptyState();
    addAuditEvent(state, 'galaxy_id.initialized', identity.id, { localOnly: true });
    await publishInitialization(paths, { version: 1, identity, privateKeyPem, publicKeyPem, state });
  }

  let state = await readJson(paths.state);
  if (!state) {
    state = emptyState();
    addAuditEvent(state, 'galaxy_id.initialized', identity.id, { localOnly: true });
    await writeJson(paths.state, state);
  } else {
    const normalizedState = normalizeState(state);
    if (JSON.stringify(normalizedState) !== JSON.stringify(state)) {
      state = normalizedState;
      await writeJson(paths.state, state);
    }
  }

  return { dataDir, identity, state };
}

export async function initializeLocalGalaxyId(dataDirectory, input = {}) {
  if (input.subjectType !== undefined && !['person', 'organization'].includes(input.subjectType)) throw localError('local_identity_subject_type_invalid');
  return withLocalWrite(dataDirectory, directory => initializeUnlocked(directory, {subjectType: input.subjectType}));
}

/** A Worker gets an isolated local identity directory. This does not start an
 * Agent, change the normal client's ID, or create a cloud account. */
export async function initializeLocalWorkerGalaxyId(dataDirectory, {workerId} = {}) {
  if (typeof workerId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(workerId)) throw localError('local_worker_id_invalid');
  const workerDirectory = join(resolveDataDir(dataDirectory), 'workers', workerId);
  const snapshot = await withLocalWrite(workerDirectory, directory => initializeUnlocked(directory, {subjectType: 'agent', clientKind: 'worker'}));
  return {...snapshot, workerId, runtimeStarted: false, localOnly: true};
}

export async function getLocalSnapshot(dataDirectory) {
  return withLocalRead(dataDirectory, async dataDir => {
    const paths = localPaths(dataDir);
    if (await fileExists(paths.initializationJournal) || await fileExists(paths.resetJournal))
      return { dataDir, identity: null, state: emptyState(), recoveryRequired: true };
    const identity = await readJson(paths.identity, null) ?? await readJson(paths.legacyIdentity, null);
    const state = await readJson(paths.state, null) ?? await readJson(paths.legacyState, null);
    return { dataDir, identity, state: normalizeState(state ?? emptyState()) };
  });
}

export const initializeLocalNode = initializeLocalGalaxyId;

export function previewGalaxyIntegration(input = {}) {
  return resolveGalaxyInitialization({ ...input, allowPlanned: true });
}

export function listGalaxyIntegrationModules() {
  return listIntegrationModules();
}

export async function getGalaxyIntegrationStatus(dataDirectory) {
  const { dataDir, identity, state, recoveryRequired = false } = await getLocalSnapshot(dataDirectory);
  const integration = state?.integration && Array.isArray(state.integration.modules)
    ? state.integration
    : null;
  const normalizedState = normalizeState(state ?? emptyState());

  return {
    dataDir,
    initialized: Boolean(integration),
    recoveryRequired,
    galaxyId: identity,
    integration,
    uploadPrivacy: normalizeUploadPrivacy(state.uploadPrivacy),
    catalog: listIntegrationModules(),
    recordCounts: {
      cases: normalizedState.cases.length,
      disclosurePlans: normalizedState.disclosurePlans.length,
      consentGrants: normalizedState.consentGrants.length,
      localProofDrafts: normalizedState.localProofDrafts.length,
      auditEvents: normalizedState.auditEvents.length,
    },
    localOnly: true,
  };
}

async function resetUnlocked(dataDirectory) {
  return resetLocalFiles(localPaths(resolveDataDir(dataDirectory)));
}

export async function initializeGalaxyIntegration(dataDirectory, input = {}) {
  const requestedPlan = resolveGalaxyInitialization(input);
  const { createConnectionProfile } = await import('../connection-profile.mjs');
  const update = await updateState(dataDirectory, (state, identity) => {
    const wasInitialized = Boolean(state.integration);
    const currentModules = state.integration?.modules ?? [];
    const currentModuleIds = currentModules.map((module) => module.id);
    const mergedPlan = resolveGalaxyInitialization({
      modules: [...currentModuleIds, ...requestedPlan.modules.map((module) => module.id)],
    });
    const occurredAt = now();
    if (input.uploadPrivacy !== undefined) state.uploadPrivacy = selectUploadPrivacy(state.uploadPrivacy, input.uploadPrivacy, occurredAt);
    const explicitModuleIds = new Set(requestedPlan.requestedModuleIds);
    const currentById = new Map(currentModules.map((module) => [module.id, module]));
    const modules = mergedPlan.modules.map((module) => {
      const current = currentById.get(module.id);
      return {
        id: module.id,
        enabledAt: current?.enabledAt ?? occurredAt,
        selectedExplicitly: current?.selectedExplicitly ?? explicitModuleIds.has(module.id),
      };
    });
    const addedModuleIds = modules
      .map((module) => module.id)
      .filter((moduleId) => !currentModuleIds.includes(moduleId));

    const previousInitializationPath = state.integration?.initializationPath ?? null;
    const initializationPath = requestedPlan.initializationPath ?? previousInitializationPath;
    const change = {
      kind: wasInitialized ? 'configuration-change' : 'first-initialization',
      fromInitializationPathId: previousInitializationPath?.id ?? null,
      toInitializationPathId: initializationPath?.id ?? null,
    };

    state.integration = {
      version: STORE_VERSION,
      initializedAt: state.integration?.initializedAt ?? occurredAt,
      updatedAt: occurredAt,
      source: typeof input.source === 'string' && input.source.trim() ? input.source.trim().slice(0, 80) : 'mcp',
      profile: requestedPlan.profile,
      capabilityProfile: requestedPlan.capabilityProfile ?? state.integration?.capabilityProfile ?? null,
      enabledModuleSnapshot: requestedPlan.capabilityProfile ? modules.map((module) => module.id) : state.integration?.enabledModuleSnapshot ?? null,
      connectionProfile: state.integration?.connectionProfile ?? (requestedPlan.capabilityProfile ? createConnectionProfile({}, occurredAt) : null),
      initializationPath,
      lastChange: { ...change, occurredAt },
      modules,
      localOnly: true,
      remoteEffects: 'none',
    };
    addAuditEvent(state, 'integration.initialized', identity.id, {
      capabilityProfile: state.integration.capabilityProfile,
      requestedModuleIds: requestedPlan.requestedModuleIds,
      addedModuleIds,
      initializationPathId: initializationPath?.id ?? null,
      change,
      localOnly: true,
    });

    return { integration: state.integration, uploadPrivacy: normalizeUploadPrivacy(state.uploadPrivacy), addedModuleIds, plan: mergedPlan, change };
  }, {subjectType: input.subjectType});

  return {
    dataDir: update.dataDir,
    galaxyId: update.identity,
    ...update.result,
    localOnly: true,
  };
}

export async function assertGalaxyModulesEnabled(dataDirectory, moduleIds) {
  const requestedModuleIds = Array.isArray(moduleIds) ? moduleIds : [moduleIds];
  const status = await getGalaxyIntegrationStatus(dataDirectory);
  if (status.recoveryRequired) throw new Error('Local Galaxy recovery is required before using enabled modules.');
  if (!status.initialized) {
    throw new Error('Galaxy Integration Pack is not initialized. Preview and confirm module selection first.');
  }
  const enabledModuleIds = new Set(status.integration.modules.map((module) => module.id));
  const missingModuleIds = requestedModuleIds.filter((moduleId) => !enabledModuleIds.has(moduleId));
  if (missingModuleIds.length > 0) {
    throw new Error(`Galaxy Integration modules are not enabled: ${missingModuleIds.join(', ')}.`);
  }
  return status;
}

export async function updateState(dataDirectory, mutator, identityOptions) {
  return withLocalWrite(dataDirectory, async directory => {
    const snapshot = await initializeUnlocked(directory, identityOptions);
    const result = await mutator(snapshot.state, snapshot.identity);
    await writeJson(localPaths(snapshot.dataDir).state, snapshot.state);
    return { ...snapshot, result };
  });
}

async function privacyContext(directory, getIdentity) {
  const paths = localPaths(directory);
  const identity = await readJson(paths.identity, null) ?? await readJson(paths.legacyIdentity, null);
  const selected = getIdentity ? await getIdentity(directory) : identity;
  const owner = typeof selected === 'string' ? selected : selected?.id ?? selected?.subjectId ?? null;
  const state = normalizeState(await readJson(paths.state, null) ?? await readJson(paths.legacyState, null) ?? emptyState());
  const separatePath=join(directory,'galaxy-upload-privacy.json');
  const separate=await readJson(separatePath,{version:1,identities:{}});
  if(separate?.version!==1||!separate.identities||typeof separate.identities!=='object'||Array.isArray(separate.identities))throw localError('local_upload_privacy_file_invalid');
  const settings = normalizeUploadPrivacy(owner && owner !== identity?.id ? separate.identities[owner]??state.uploadPrivacyByIdentity?.[owner] : state.uploadPrivacy);
  return {paths, identity, owner, state, settings,separatePath,separate};
}

export async function getLocalUploadPrivacy(dataDirectory, {getIdentity} = {}) {
  return withLocalRead(dataDirectory, async directory => {
    const paths = localPaths(directory);
    const recoveryRequired = await fileExists(paths.initializationJournal) || await fileExists(paths.resetJournal);
    const context = await privacyContext(directory, getIdentity);
    return {galaxyId: context.owner, initialized: Boolean(context.owner), recoveryRequired,
      settings: context.settings, levels: listUploadPrivacyLevels(), allowedDataTypes: allowedUploadDataTypes(context.settings),
      uploadStarted: false, changesOnlineVisibility: false, localOnly: true};
  });
}

export async function setLocalUploadPrivacy(dataDirectory, input = {}, {getIdentity} = {}) {
  return withLocalWrite(dataDirectory, async directory => {
    const paths = localPaths(directory);
    if (await fileExists(paths.initializationJournal) || await fileExists(paths.resetJournal)) throw localError('local_recovery_required');
    const {identity,owner,state,settings: old,separatePath,separate} = await privacyContext(directory, getIdentity);
    if (!owner) throw localError('local_identity_required');
    if (input.galaxyId !== undefined && input.galaxyId !== owner) throw localError('local_identity_mismatch');
    const settings = selectUploadPrivacy(old, input, now());
    if (owner === identity?.id) {
      state.uploadPrivacy = settings;
      addAuditEvent(state, 'upload_privacy.changed', owner, {level: settings.level, includeFullConversations: settings.includeFullConversations, selectedSessionCount: settings.sessionIds.length});
      await writeJson(paths.state, state);
    } else await writeJson(separatePath,{version:1,identities:{...separate.identities,[owner]:settings}});
    return {galaxyId: owner, settings, levels: listUploadPrivacyLevels(), allowedDataTypes: allowedUploadDataTypes(settings), uploadStarted: false, changesOnlineVisibility: false, localOnly: true};
  });
}

export async function createCaseDraft(dataDirectory, input) {
  const title = assertText(input.title, 'title', 120);
  const failureSummary = assertText(input.failureSummary, 'failureSummary', 1200);
  const attemptedApproaches = Array.isArray(input.attemptedApproaches)
    ? input.attemptedApproaches
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 8)
        .map((item) => item.slice(0, 240))
    : [];

  const update = await updateState(dataDirectory, (state, identity) => {
    const caseDraft = {
      id: makeId('case'),
      galaxyId: identity.id,
      title,
      failureSummary,
      attemptedApproaches,
      status: 'draft',
      createdAt: now(),
      updatedAt: now(),
      localOnly: true,
    };
    state.cases.push(caseDraft);
    addAuditEvent(state, 'case.draft_created', caseDraft.id, { galaxyId: identity.id });
    return caseDraft;
  });

  return update.result;
}

export async function createDisclosurePlan(dataDirectory, input) {
  const recipient = assertText(input.recipient || 'selected-future-resolver', 'recipient', 100);
  const purpose = assertText(input.purpose || 'private AI Coding review', 'purpose', 160);
  const expiresInHours = Number.isFinite(input.expiresInHours)
    ? Math.min(Math.max(Math.trunc(input.expiresInHours), 1), 24 * 30)
    : 24;
  const include = permittedIncludeList(input.include);

  const update = await updateState(dataDirectory, (state) => {
    const caseDraft = requiredRecord(state.cases, input.caseId, 'Case Draft');
    const disclosurePlan = {
      id: makeId('disclosure'),
      caseId: caseDraft.id,
      recipient,
      purpose,
      include,
      exclude: FORBIDDEN_DISCLOSURE_ITEMS,
      createdAt: now(),
      expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString(),
      transport: 'not-configured',
      status: 'preview',
      localOnly: true,
      summary: 'This preview does not send any Case content or create a public record.',
    };
    state.disclosurePlans.push(disclosurePlan);
    addAuditEvent(state, 'disclosure.preview_created', disclosurePlan.id, {
      caseId: caseDraft.id,
      recipient,
    });
    return disclosurePlan;
  });

  return update.result;
}

export async function issueConsentGrant(dataDirectory, disclosurePlanId) {
  const update = await updateState(dataDirectory, (state) => {
    const disclosurePlan = requiredRecord(state.disclosurePlans, disclosurePlanId, 'Disclosure Plan');
    if (new Date(disclosurePlan.expiresAt).getTime() <= Date.now()) {
      throw new Error('This Disclosure Plan has expired and cannot be confirmed.');
    }

    const consentGrant = {
      id: makeId('grant'),
      disclosurePlanId: disclosurePlan.id,
      caseId: disclosurePlan.caseId,
      recipient: disclosurePlan.recipient,
      purpose: disclosurePlan.purpose,
      include: disclosurePlan.include,
      exclude: disclosurePlan.exclude,
      issuedAt: now(),
      expiresAt: disclosurePlan.expiresAt,
      status: 'active',
      localOnly: true,
      note: 'This is a local Consent Grant receipt. No data transfer has occurred.',
    };
    state.consentGrants.push(consentGrant);
    disclosurePlan.status = 'confirmed';
    addAuditEvent(state, 'consent.granted', consentGrant.id, {
      disclosurePlanId: disclosurePlan.id,
      caseId: disclosurePlan.caseId,
    });
    return consentGrant;
  });

  return update.result;
}

export async function revokeConsentGrant(dataDirectory, consentGrantId) {
  const update = await updateState(dataDirectory, (state) => {
    const consentGrant = requiredRecord(state.consentGrants, consentGrantId, 'Consent Grant');
    if (consentGrant.status === 'revoked') {
      return consentGrant;
    }
    consentGrant.status = 'revoked';
    consentGrant.revokedAt = now();
    addAuditEvent(state, 'consent.revoked', consentGrant.id, { caseId: consentGrant.caseId });
    return consentGrant;
  });

  return update.result;
}

export async function createLocalProofDraft(dataDirectory, input) {
  const verificationNote = assertText(input.verificationNote, 'verificationNote', 800);
  const update = await updateState(dataDirectory, (state, identity) => {
    const caseDraft = requiredRecord(state.cases, input.caseId, 'Case Draft');
    const consentGrant = requiredRecord(state.consentGrants, input.consentGrantId, 'Consent Grant');
    if (consentGrant.caseId !== caseDraft.id) {
      throw new Error('Consent Grant does not belong to this Case Draft.');
    }
    if (consentGrant.status !== 'active') {
      throw new Error('An active Consent Grant is required to create a shareable Local Proof Draft.');
    }
    if (new Date(consentGrant.expiresAt).getTime() <= Date.now()) {
      throw new Error('Consent Grant has expired. Create a new Disclosure Plan first.');
    }

    const localProofDraft = {
      id: makeId('proof'),
      caseId: caseDraft.id,
      galaxyId: identity.id,
      consentGrantId: consentGrant.id,
      verificationNote,
      visibility: 'local-only',
      status: 'draft',
      createdAt: now(),
      limitations: [
        'No remote recipient received data.',
        'No third-party verification occurred.',
        'This draft is not public Evidence or a Track Record entry.',
      ],
    };
    state.localProofDrafts.push(localProofDraft);
    caseDraft.status = 'local-proof-draft';
    caseDraft.updatedAt = now();
    addAuditEvent(state, 'proof.local_draft_created', localProofDraft.id, {
      caseId: caseDraft.id,
      consentGrantId: consentGrant.id,
    });
    return localProofDraft;
  });

  return update.result;
}

export async function listLocalHistory(dataDirectory, limit = 20) {
  const snapshot = await getLocalSnapshot(dataDirectory);
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return {
    galaxyId: snapshot.identity,
    recoveryRequired: snapshot.recoveryRequired ?? false,
    cases: snapshot.state.cases.slice(-safeLimit).reverse(),
    disclosurePlans: snapshot.state.disclosurePlans.slice(-safeLimit).reverse(),
    consentGrants: snapshot.state.consentGrants.slice(-safeLimit).reverse(),
    localProofDrafts: snapshot.state.localProofDrafts.slice(-safeLimit).reverse(),
    auditEvents: snapshot.state.auditEvents.slice(-safeLimit).reverse(),
  };
}

export async function exportLocalData(dataDirectory) {
  const snapshot = await getLocalSnapshot(dataDirectory);
  return {
    exportVersion: STORE_VERSION,
    exportedAt: now(),
    localOnly: true,
    identity: snapshot.identity,
    recoveryRequired: snapshot.recoveryRequired ?? false,
    state: snapshot.state,
    excluded: ['galaxy-id-private-key.pem', 'raw source files', 'environment variables', 'tokens', 'credentials'],
  };
}

export const disclosurePolicy = {
  permitted: PERMITTED_DISCLOSURE_ITEMS,
  alwaysExcluded: FORBIDDEN_DISCLOSURE_ITEMS,
};

export async function resetGalaxyIntegration(dataDirectory) {
  return withLocalWrite(dataDirectory, resetUnlocked);
}
