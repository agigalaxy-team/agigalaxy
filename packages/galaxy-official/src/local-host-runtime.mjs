import { createBuilderClient } from './builder-client.mjs';
import { createAuditClient } from './audit-client.mjs';
import { createDataExportClient } from './data-export-client.mjs';
import { createDeletionClient, createDeletionStatusClient } from './deletion-client.mjs';
import { deletionIntentSchema, deletionStatusIntentSchema } from './shared/deletion-schema.mjs';
import { saveDataExport } from './local-data-export.mjs';
import { auditGrantSchema } from './shared/audit-schema.mjs';
import { createBuilderFlow } from './builder-flow.mjs';
import { createNodeControlProofFlow } from './node-control-proof-flow.mjs';
import { nodeProofClaimsSchema,nodeControlProofSchema } from './shared/node-control-proof-schema.mjs';
import { createProfileFlow } from './profile-flow.mjs';
import { createCaseReviewFlow } from './case-review-flow.mjs';
import { createCapsuleClient } from './capsule-client.mjs';
import { createCapsuleFlow } from './capsule-flow.mjs';
import { createHonorClient } from './honor-client.mjs';
import { createModerationClient } from './moderation-client.mjs';
import { createModerationFlow } from './moderation-flow.mjs';
import { createNotificationsClient } from './notifications-client.mjs';
import { createProjectDiscoveryClient } from './project-discovery-client.mjs';
import { createContextFlow } from './context-flow.mjs';
import { createContextClient } from './context-client.mjs';
import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { CompactSign, decodeJwt } from 'jose';
import { withLocalRead,withLocalWrite } from '../../galaxy-core/src/storage/write-lock.mjs';
import { localPaths } from '../../galaxy-core/src/storage/files.mjs';
import { validateConnectionProfile, CONNECTION_PROFILE_FILE } from '../../galaxy-core/src/connection-profile.mjs';
import { verifyGalaxyGenesis } from '../../galaxy-core/src/galaxy-guid.mjs';
import { verifyNetworkManifest } from './verification/manifest.mjs';
import { validatePublicUrl } from './public-fetch.mjs';
import { createConnectionClient } from './connection-client.mjs';
import { createSessionMemory } from './session-memory.mjs';
import { createBindingStatusClient } from './binding-status-client.mjs';
import { createBindingManagementClient } from './binding-management-client.mjs';
import { createIdentityLinkClient } from './identity-link-client.mjs';
import { identityIntentSchema } from './shared/identity-link-schema.mjs';
import { createHostConnectionController } from './host-connection-controller.mjs';
import { createHistoryClient,createSearchClient } from './history-client.mjs';
import { createAssistanceFlow } from './assistance-flow.mjs';
import { createAssistanceClient } from './assistance-client.mjs';
import { createCaseClient } from './case-client.mjs';
import { createLocalPublicationFlow } from './local-publication-flow.mjs';
import { assertConsentPolicy } from './domain/consent-policy.mjs';
import { consentSchema } from './shared/consents-schema.mjs';
import { saveLocalSearchFeedback, readLocalSearchFeedback, editLocalSearchFeedback } from './local-search-feedback.mjs';
import { createLocalBindingReceipts } from './local-binding-receipts.mjs';
import { createLocalBuilderJournal } from './local-builder-journal.mjs';
import { createLocalAssistanceStore } from './local-assistance-store.mjs';
import { createLocalContextStore } from './local-context-store.mjs';
import { createHelpRuntimeV2 } from './help-runtime-v2.mjs';

async function readBounded(path, maximum, optional = false) {
  let handle;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error('Invalid local file.');
    handle = await open(path, 'r');
    const bytes = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maximum) throw new Error('Local file too large.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw new Error('Local material unavailable.'); }
  finally { await handle?.close(); }
}

// Explicit trusted host assembly. Publication preparation persists local drafts;
// key use and network writes occur only on confirmed execution. No key generation.
export function createLocalHostRuntime({ dataDirectory, endpoint, installationId, scopes, networkType = 'official',
  bindingScopeId, trustedKeys, manifest, hubTrustedKeys, readHubManifest, now = () => Math.floor(Date.now() / 1000),
  connectionSend, statusSend, bindingManagementSend, identitySend, historySend, searchSend, projectDiscoverySend, caseSend, caseRead, consentSend, assistanceSend, assistanceRead, contextSend, contextRead, notificationsSend, moderationSend, honorSend, capsuleSend, builderSend, auditSend, dataExportSend, deletionSend, helpSend, helpRead, a2aHostFactory }) {
  if (!isAbsolute(dataDirectory) || validatePublicUrl(endpoint).origin !== endpoint
    || typeof bindingScopeId !== 'string' || !bindingScopeId || !(trustedKeys instanceof Map) || !['official','hub'].includes(networkType))
    throw new Error('Invalid local host configuration.');
  const requestedScopes = Object.freeze([...scopes]);
  const document = JSON.parse(JSON.stringify(manifest));
  let baseline = null, closed = false;
  let receiptSaveState = 'not-attempted', connectionGeneration = 0;
  async function trust() {
    if (closed) throw new Error('Local host closed.');
    const result = await verifyNetworkManifest(document, { endpoint, trustedKeys, networkType, now: now() });
    if (!['binding', 'sessions'].every(scope => result.data.capabilities.includes(scope)))
      throw new Error('Endpoint does not advertise connection support.');
  }
  async function readIdentity(directory) {
    const paths = localPaths(directory);
    for (const path of [paths.initializationJournal, paths.resetJournal]) {
      try { await lstat(path); throw new Error('Local recovery required.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const identity = JSON.parse(await readBounded(paths.identity, 16384));
    if (!verifyGalaxyGenesis(identity.id, identity.genesisProof)) throw new Error('Valid local identity required.');
    return identity;
  }
  async function load(directory) {
    const paths = localPaths(directory);
    const identity = await readIdentity(directory);
    const state = JSON.parse(await readBounded(paths.state, 4194304));
    if (!verifyGalaxyGenesis(identity.id, identity.genesisProof) || !state.integration)
      throw new Error('Initialized local identity required.');
    const stored = await readBounded(join(directory, CONNECTION_PROFILE_FILE), 131072, true);
    const profile = validateConnectionProfile(stored ? JSON.parse(stored) : state.integration.connectionProfile);
    const intent = profile.scopes.find(item => item.id === bindingScopeId);
    const target = profile.targets.find(item => item.id === intent?.targetId);
    const time = now();
    if (!Number.isSafeInteger(time) || !intent || intent.action !== 'binding' || intent.revokedAt
      || Date.parse(intent.expiresAt) <= time * 1000 || target?.endpoint !== endpoint
      || target.kind !== networkType || intent.recipient !== endpoint
      || !['subjectId', 'genesisProof', 'installationId', 'scopes'].every(field => intent.visibleFields.includes(field)))
      throw new Error('Current local binding intent required.');
    return { identity, state, intentExpiresAt: Math.floor(Date.parse(intent.expiresAt) / 1000), fingerprint: JSON.stringify({ identity, integration: state.integration, profile }) };
  }
  async function current() {
    await trust();
    const local = await withLocalRead(dataDirectory, load);
    return !closed && baseline !== null && local.fingerprint === baseline.fingerprint;
  }
  const connectionClient = createConnectionClient({ endpoint, trustedKeys, now, send: connectionSend,
    assertCurrent: async preview => {
      if (!await current()) return false;
      return preview.requestJson === JSON.stringify({ subjectId: baseline.identity.id,
        genesisProof: baseline.identity.genesisProof, installationId, scopes: requestedScopes });
    },
    sign: async (payload, typ) => {
      if (!['galaxy-binding-response+jws', 'galaxy-session-response+jws'].includes(typ))
        throw new Error('Unsupported local signing purpose.');
      await trust();
      return withLocalRead(dataDirectory, async directory => {
        const local = await load(directory);
        if (closed || !baseline || local.fingerprint !== baseline.fingerprint) throw new Error('Local identity changed.');
        const challenge = decodeJwt(payload);
        const expiration = typ === 'galaxy-binding-response+jws' ? challenge.data?.bindingExpiresAt : challenge.data?.credentialExpiresAt;
        if (!Number.isSafeInteger(expiration) || expiration > local.intentExpiresAt)
          throw new Error('Remote lifetime exceeds local intent.');
        // Key is read only here, under the same read lock as the public identity.
        const key = createPrivateKey(await readBounded(localPaths(directory).privateKey, 4096));
        const actual = createPublicKey(key).export({ type: 'spki', format: 'der' });
        const expected = createPublicKey(local.identity.genesisProof.publicKeyPem).export({ type: 'spki', format: 'der' });
        if (key.asymmetricKeyType !== 'ed25519' || !actual.equals(expected)) throw new Error('Local key mismatch.');
        const signature = await new CompactSign(Buffer.from(payload)).setProtectedHeader({ alg: 'Ed25519', typ }).sign(key);
        if (closed) throw new Error('Local host closed.');
        return signature;
      });
    } });
  const receipts = createLocalBindingReceipts({ dataDirectory, endpoint, installationId, scopes: requestedScopes, trustedKeys, now, readIdentity,
    assertCurrent: async directory => !closed && baseline !== null && (await load(directory)).fingerprint === baseline.fingerprint });
  const client = {
    prepare: connectionClient.prepare,
    cancel(preview) { connectionGeneration++; connectionClient.cancel(preview); },
    async execute(preview, confirmation) {
      const version = ++connectionGeneration;
      const result = await connectionClient.execute(preview, confirmation);
      try {
        await receipts.save(result, () => !closed && version === connectionGeneration);
        receiptSaveState = 'saved-locally';
      } catch { receiptSaveState = 'save-failed'; }
      return result;
    },
  };
  const sessions = createSessionMemory({ now, isCurrent: async state =>
    await current() && state.subjectId === baseline.identity.id });
  const statusClient = createBindingStatusClient({ endpoint, sessions, now, send: statusSend });
  const bindingManagementClient=createBindingManagementClient({endpoint,sessions,send:bindingManagementSend});
  const identityClient=createIdentityLinkClient({endpoint,sessions,now,send:identitySend,sign:async(payload,typ)=>{
    if(typ!=='galaxy-identity-link+jws'||!identityClient.isSigningPayload(payload))throw new Error('Confirmed identity association required.');
    const intent=identityIntentSchema.parse(JSON.parse(payload)),actor=await sessions.readAuthorization(endpoint);
    if(!actor||intent.subjectId!==actor.subjectId||intent.bindingId!==actor.bindingId||intent.endpoint!==endpoint||intent.expiresAt<=now())throw new Error('Current identity association required.');
    return withLocalRead(dataDirectory,async directory=>{
      const local=await load(directory);
      if(closed||!baseline||local.fingerprint!==baseline.fingerprint||local.identity.id!==intent.subjectId
        ||intent.expiresAt>local.intentExpiresAt||!identityClient.isSigningPayload(payload))throw new Error('Local identity association changed.');
      const key=createPrivateKey(await readBounded(localPaths(directory).privateKey,4096));
      if(key.asymmetricKeyType!=='ed25519'||!createPublicKey(key).export({type:'spki',format:'der'}).equals(createPublicKey(local.identity.genesisProof.publicKeyPem).export({type:'spki',format:'der'})))throw new Error('Local key mismatch.');
      return new CompactSign(Buffer.from(payload)).setProtectedHeader({alg:'Ed25519',typ}).sign(key);
    });
  }});
  const historyClient = createHistoryClient({ endpoint, sessions, send: historySend });
  const searchClient=createSearchClient({endpoint,sessions,send:searchSend??historySend});
  const dataExportClient = createDataExportClient({ endpoint, sessions, send: dataExportSend, now });
  const deletionClient = createDeletionClient({ endpoint, sessions, send: deletionSend, now,
    signIntent: async (payload, typ) => {
      if (typ !== 'galaxy-deletion-intent+jws' || !deletionClient.isSigningIntent(payload)) throw new Error('Confirmed deletion intent required');
      const actor = await sessions.readAuthorization(endpoint), intent = deletionIntentSchema.parse(JSON.parse(payload));
      if (!actor?.scopes.includes('data-delete') || intent.subjectId !== actor.subjectId || intent.bindingId !== actor.bindingId
        || intent.endpoint !== endpoint || intent.expiresAt <= now()) throw new Error('Deletion intent changed');
      return withLocalRead(dataDirectory, async directory => {
        const local = await load(directory);
        if (closed || !baseline || local.fingerprint !== baseline.fingerprint || intent.expiresAt > local.intentExpiresAt
          || !deletionClient.isSigningIntent(payload)) throw new Error('Local deletion authorization changed');
        const key = createPrivateKey(await readBounded(localPaths(directory).privateKey, 4096));
        const expected = createPublicKey(local.identity.genesisProof.publicKeyPem).export({ type: 'spki', format: 'der' });
        if (key.asymmetricKeyType !== 'ed25519' || !createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(expected)) throw new Error('Local key mismatch');
        return new CompactSign(Buffer.from(payload)).setProtectedHeader({ alg: 'Ed25519', typ }).sign(key);
      });
    } });
  const deletionStatusClient = createDeletionStatusClient({ endpoint, send: deletionSend, now,
    readSubjectId: () => withLocalRead(dataDirectory, async directory => { if(closed)throw new Error('Local host closed');return (await load(directory)).identity.id; }),
    signIntent: async (payload,typ) => {
      if(typ!=='galaxy-deletion-status+jws'||!deletionStatusClient.isSigningIntent(payload))throw new Error('Confirmed status intent required');
      const intent=deletionStatusIntentSchema.parse(JSON.parse(payload));
      return withLocalRead(dataDirectory,async directory=>{
        const local=await load(directory);
        if(closed||intent.subjectId!==local.identity.id||intent.endpoint!==endpoint||intent.expiresAt<=now()||!deletionStatusClient.isSigningIntent(payload))throw new Error('Local status identity changed');
        const key=createPrivateKey(await readBounded(localPaths(directory).privateKey,4096));
        const expected=createPublicKey(local.identity.genesisProof.publicKeyPem).export({type:'spki',format:'der'});
        if(key.asymmetricKeyType!=='ed25519'||!createPublicKey(key).export({type:'spki',format:'der'}).equals(expected))throw new Error('Local key mismatch');
        return new CompactSign(Buffer.from(payload)).setProtectedHeader({alg:'Ed25519',typ}).sign(key);
      });
    } });
  const auditClient = createAuditClient({ endpoint, sessions, send: auditSend, now,
    signApproval: async (payload, typ) => {
      if (typ !== 'galaxy-audit-approval+jws' || !auditClient.isSigningApproval(payload)) throw new Error('Confirmed audit approval required.');
      const actor = await sessions.readAuthorization(endpoint), grant = auditGrantSchema.parse(JSON.parse(payload));
      if (!actor?.scopes.includes('audit-review') || grant.reviewerId !== actor.subjectId
        || grant.reviewerBindingId !== actor.bindingId || grant.endpoint !== endpoint || grant.expiresAt <= now()) throw new Error('Audit approval changed.');
      return withLocalRead(dataDirectory, async directory => {
        const local = await load(directory);
        if (closed || !baseline || local.fingerprint !== baseline.fingerprint || grant.expiresAt > local.intentExpiresAt
          || !auditClient.isSigningApproval(payload)) throw new Error('Local audit authorization changed.');
        const key = createPrivateKey(await readBounded(localPaths(directory).privateKey, 4096));
        const expected = createPublicKey(local.identity.genesisProof.publicKeyPem).export({ type: 'spki', format: 'der' });
        if (key.asymmetricKeyType !== 'ed25519' || !createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(expected)) throw new Error('Local key mismatch.');
        return new CompactSign(Buffer.from(payload)).setProtectedHeader({ alg: 'Ed25519', typ }).sign(key);
      });
    } });
  const assistanceClient = createAssistanceClient({ endpoint, sessions, send: assistanceSend, read: assistanceRead });
  const caseClient = createCaseClient({ endpoint, sessions, send: caseSend, read: caseRead });
  const assistanceStore = createLocalAssistanceStore({ dataDirectory, endpoint, assertOpen: () => !closed });
  const assistanceFlow = createAssistanceFlow({ endpoint, sessions, now, consentSend, assistanceSend, assistanceRead, journal: assistanceStore,
    signIntent: async (payload, typ) => {
      if (typ !== 'galaxy-consent+jws' || !assistanceFlow.isSigningIntent(payload)) throw new Error('Confirmed collaboration intent required.');
      const actor = await sessions.readAuthorization(endpoint), intent = consentSchema.parse(JSON.parse(payload));
      if (!actor || intent.action !== 'assistance.publish') throw new Error('Collaboration authorization required.');
      assertConsentPolicy(intent, { actor, endpoint, now: now() });
      return withLocalRead(dataDirectory, async directory => {
        const local = await load(directory);
        if (closed || !baseline || local.fingerprint !== baseline.fingerprint || intent.expiresAt > local.intentExpiresAt
          || !assistanceFlow.isSigningIntent(payload)) throw new Error('Local collaboration authorization changed.');
        const key = createPrivateKey(await readBounded(localPaths(directory).privateKey, 4096));
        const expected = createPublicKey(local.identity.genesisProof.publicKeyPem).export({ type: 'spki', format: 'der' });
        if (key.asymmetricKeyType !== 'ed25519' || !createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(expected))
          throw new Error('Local key mismatch.');
        return new CompactSign(Buffer.from(payload)).setProtectedHeader({ alg: 'Ed25519', typ }).sign(key);
      });
    } });
  const honorClient = createHonorClient({ endpoint, sessions, send: honorSend });
  const notificationsClient = createNotificationsClient({ endpoint, sessions, send: notificationsSend });
  const projectDiscoveryClient = createProjectDiscoveryClient({ endpoint, sessions, send: projectDiscoverySend });
  const contextClient = createContextClient({ endpoint, sessions, send: contextSend, read: contextRead });
  const contextStore=createLocalContextStore({dataDirectory,endpoint,assertOpen:()=>!closed});
  const contextFlow = createContextFlow({ endpoint, sessions, now, consentSend, assistanceSend, assistanceRead, contextSend, contextRead, journal:contextStore,
    signIntent: async (payload, typ) => {
      if (typ !== 'galaxy-consent+jws' || !contextFlow.isSigningIntent(payload)) throw new Error('Confirmed collaboration intent required.');
      const actor = await sessions.readAuthorization(endpoint), intent = consentSchema.parse(JSON.parse(payload));
      if (!actor || intent.action !== 'context.grant') throw new Error('Collaboration authorization required.');
      assertConsentPolicy(intent, { actor, endpoint, now: now() });
      return withLocalRead(dataDirectory, async directory => {
        const local = await load(directory);
        if (closed || !baseline || local.fingerprint !== baseline.fingerprint || intent.expiresAt > local.intentExpiresAt
          || !contextFlow.isSigningIntent(payload)) throw new Error('Local collaboration authorization changed.');
        const key = createPrivateKey(await readBounded(localPaths(directory).privateKey, 4096));
        const expected = createPublicKey(local.identity.genesisProof.publicKeyPem).export({ type: 'spki', format: 'der' });
        if (key.asymmetricKeyType !== 'ed25519' || !createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(expected))
          throw new Error('Local key mismatch.');
        return new CompactSign(Buffer.from(payload)).setProtectedHeader({ alg: 'Ed25519', typ }).sign(key);
      });
    } });
  const moderationClient = createModerationClient({ endpoint, sessions, send: moderationSend });
  const moderationFlow = createModerationFlow({ endpoint, sessions, now, consentSend, moderationSend,
    signIntent: async (payload, typ) => {
      if (typ !== 'galaxy-consent+jws' || !moderationFlow.isSigningIntent(payload)) throw new Error('Confirmed collaboration intent required.');
      const actor = await sessions.readAuthorization(endpoint), intent = consentSchema.parse(JSON.parse(payload));
      if (!actor || intent.action !== 'moderation.publish') throw new Error('Collaboration authorization required.');
      assertConsentPolicy(intent, { actor, endpoint, now: now() });
      return withLocalRead(dataDirectory, async directory => {
        const local = await load(directory);
        if (closed || !baseline || local.fingerprint !== baseline.fingerprint || intent.expiresAt > local.intentExpiresAt
          || !moderationFlow.isSigningIntent(payload)) throw new Error('Local collaboration authorization changed.');
        const key = createPrivateKey(await readBounded(localPaths(directory).privateKey, 4096));
        const expected = createPublicKey(local.identity.genesisProof.publicKeyPem).export({ type: 'spki', format: 'der' });
        if (key.asymmetricKeyType !== 'ed25519' || !createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(expected))
          throw new Error('Local key mismatch.');
        return new CompactSign(Buffer.from(payload)).setProtectedHeader({ alg: 'Ed25519', typ }).sign(key);
      });
    } });
  const capsuleClient = createCapsuleClient({ endpoint, sessions, send: capsuleSend });
  const capsuleFlow = createCapsuleFlow({ endpoint, sessions, now, consentSend, capsuleSend, caseSend, caseRead,
    signIntent: async (payload, typ) => {
      if (typ !== 'galaxy-consent+jws' || !capsuleFlow.isSigningIntent(payload)) throw new Error('Confirmed collaboration intent required.');
      const actor = await sessions.readAuthorization(endpoint), intent = consentSchema.parse(JSON.parse(payload));
      if (!actor || !['capsule.publish','capsule.use'].includes(intent.action)) throw new Error('Collaboration authorization required.');
      assertConsentPolicy(intent, { actor, endpoint, now: now() });
      return withLocalRead(dataDirectory, async directory => {
        const local = await load(directory);
        if (closed || !baseline || local.fingerprint !== baseline.fingerprint || intent.expiresAt > local.intentExpiresAt
          || !capsuleFlow.isSigningIntent(payload)) throw new Error('Local collaboration authorization changed.');
        const key = createPrivateKey(await readBounded(localPaths(directory).privateKey, 4096));
        const expected = createPublicKey(local.identity.genesisProof.publicKeyPem).export({ type: 'spki', format: 'der' });
        if (key.asymmetricKeyType !== 'ed25519' || !createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(expected))
          throw new Error('Local key mismatch.');
        return new CompactSign(Buffer.from(payload)).setProtectedHeader({ alg: 'Ed25519', typ }).sign(key);
      });
    } });
  const builderClient = createBuilderClient({ endpoint, sessions, send: builderSend, trustedKeys, hubTrustedKeys, readHubManifest, now });
  const nodeControlProofFlow=createNodeControlProofFlow({endpoint,sessions,builders:builderClient,trustedKeys,now,
    signProof:async(payload,typ)=>{
      if(typ!=='galaxy-node-control-proof+jws'||!nodeControlProofFlow.isSigningProof(payload))throw new Error('Confirmed Node proof required.');
      const claims=nodeProofClaimsSchema.parse(JSON.parse(payload)),actor=await sessions.readAuthorization(endpoint);
      if(!actor||actor.subjectId!==claims.nodeId||claims.endpoint!==endpoint||claims.expiresAt<=now())throw new Error('Current Node authorization required.');
      return withLocalRead(dataDirectory,async directory=>{
        const local=await load(directory);
        if(closed||!baseline||local.fingerprint!==baseline.fingerprint||local.identity.id!==claims.nodeId||!nodeControlProofFlow.isSigningProof(payload))throw new Error('Local Node identity changed.');
        const key=createPrivateKey(await readBounded(localPaths(directory).privateKey,4096));
        if(key.asymmetricKeyType!=='ed25519'||!createPublicKey(key).export({type:'spki',format:'der'}).equals(createPublicKey(local.identity.genesisProof.publicKeyPem).export({type:'spki',format:'der'})))throw new Error('Local key mismatch.');
        return {signed:await new CompactSign(Buffer.from(payload)).setProtectedHeader({alg:'Ed25519',typ}).sign(key),genesisProof:local.identity.genesisProof};
      });
    },
    saveProof:(proof,{subjectId,assertCurrent})=>withLocalWrite(dataDirectory,async directory=>{
      const local=await load(directory);
      if(closed||!baseline||local.fingerprint!==baseline.fingerprint||local.identity.id!==subjectId||!assertCurrent())throw new Error('Local Node proof export changed.');
      const body=JSON.stringify(nodeControlProofSchema.parse(proof),null,2)+'\n',path=join(directory,`galaxy-node-control-proof-${randomUUID()}.json`);
      const file=await open(path,'wx',0o600);try{await file.writeFile(body,'utf8');await file.sync();}finally{await file.close();}return path;
    })});
  const builderFlow = createBuilderFlow({ endpoint, sessions, now, consentSend, builderSend,
    journal:createLocalBuilderJournal({dataDirectory,endpoint,assertOpen:()=>!closed}),
    signIntent: async (payload, typ) => {
      if (typ !== 'galaxy-consent+jws' || !builderFlow.isSigningIntent(payload)) throw new Error('Confirmed collaboration intent required.');
      const actor = await sessions.readAuthorization(endpoint), intent = consentSchema.parse(JSON.parse(payload));
      if (!actor || intent.action !== 'builder.publish') throw new Error('Collaboration authorization required.');
      assertConsentPolicy(intent, { actor, endpoint, now: now() });
      return withLocalRead(dataDirectory, async directory => {
        const local = await load(directory);
        if (closed || !baseline || local.fingerprint !== baseline.fingerprint || intent.expiresAt > local.intentExpiresAt
          || !builderFlow.isSigningIntent(payload)) throw new Error('Local collaboration authorization changed.');
        const key = createPrivateKey(await readBounded(localPaths(directory).privateKey, 4096));
        const expected = createPublicKey(local.identity.genesisProof.publicKeyPem).export({ type: 'spki', format: 'der' });
        if (key.asymmetricKeyType !== 'ed25519' || !createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(expected))
          throw new Error('Local key mismatch.');
        return new CompactSign(Buffer.from(payload)).setProtectedHeader({ alg: 'Ed25519', typ }).sign(key);
      });
    } });
  const profileFlow=createProfileFlow({endpoint,sessions,now,consentSend,historySend,
    signIntent:async(payload,typ)=>{
      if(typ!=='galaxy-consent+jws'||!profileFlow.isSigningIntent(payload))throw new Error('Confirmed Profile intent required.');
      const actor=await sessions.readAuthorization(endpoint),intent=consentSchema.parse(JSON.parse(payload));
      if(!actor||intent.action!=='profile.publish')throw new Error('Profile authorization required.');
      assertConsentPolicy(intent,{actor,endpoint,now:now()});
      return withLocalRead(dataDirectory,async directory=>{
        const local=await load(directory);
        if(closed||!baseline||local.fingerprint!==baseline.fingerprint||intent.expiresAt>local.intentExpiresAt||!profileFlow.isSigningIntent(payload))throw new Error('Local Profile authorization changed.');
        const key=createPrivateKey(await readBounded(localPaths(directory).privateKey,4096));
        const expected=createPublicKey(local.identity.genesisProof.publicKeyPem).export({type:'spki',format:'der'});
        if(key.asymmetricKeyType!=='ed25519'||!createPublicKey(key).export({type:'spki',format:'der'}).equals(expected))throw new Error('Local key mismatch.');
        return new CompactSign(Buffer.from(payload)).setProtectedHeader({alg:'Ed25519',typ}).sign(key);
      });
    }});
  const caseReviewFlow=createCaseReviewFlow({endpoint,sessions,now,consentSend,caseSend,caseRead,
    signIntent:async(payload,typ)=>{
      if(typ!=='galaxy-consent+jws'||!caseReviewFlow.isSigningIntent(payload))throw new Error('Confirmed Case review intent required.');
      const actor=await sessions.readAuthorization(endpoint),intent=consentSchema.parse(JSON.parse(payload));
      if(!actor||intent.action!=='case.teaser.publish')throw new Error('Case review authorization required.');
      assertConsentPolicy(intent,{actor,endpoint,now:now()});
      return withLocalRead(dataDirectory,async directory=>{
        const local=await load(directory);
        if(closed||!baseline||local.fingerprint!==baseline.fingerprint||intent.expiresAt>local.intentExpiresAt||!caseReviewFlow.isSigningIntent(payload))throw new Error('Local Case review authorization changed.');
        const key=createPrivateKey(await readBounded(localPaths(directory).privateKey,4096));
        const expected=createPublicKey(local.identity.genesisProof.publicKeyPem).export({type:'spki',format:'der'});
        if(key.asymmetricKeyType!=='ed25519'||!createPublicKey(key).export({type:'spki',format:'der'}).equals(expected))throw new Error('Local key mismatch.');
        return new CompactSign(Buffer.from(payload)).setProtectedHeader({alg:'Ed25519',typ}).sign(key);
      });
    }});
  const publicationFlow = createLocalPublicationFlow({ dataDirectory, endpoint, sessions, now, caseSend, caseRead, consentSend,
    signIntent: async (payload, typ) => {
      if (typ !== 'galaxy-consent+jws') throw new Error('Unsupported publication signature.');
      const actor = await sessions.readAuthorization(endpoint);
      if (!actor || !actor.scopes.includes('consent')) throw new Error('Publication authorization required.');
      const intent = consentSchema.parse(JSON.parse(payload));
      assertConsentPolicy(intent, { actor, endpoint, now: now() });
      return withLocalRead(dataDirectory, async directory => {
        const local = await load(directory);
        if (closed || !baseline || local.fingerprint !== baseline.fingerprint || intent.expiresAt > local.intentExpiresAt)
          throw new Error('Local publication authorization changed.');
        const saved = Object.values(local.state.casePublications ?? {}).some(record =>
          JSON.stringify(record.consentIntent) === payload && record.subjectId === local.identity.id && record.endpoint === endpoint);
        if (!saved || intent.action !== 'case.teaser.publish') throw new Error('Frozen publication intent required.');
        const key = createPrivateKey(await readBounded(localPaths(directory).privateKey, 4096));
        const expected = createPublicKey(local.identity.genesisProof.publicKeyPem).export({ type: 'spki', format: 'der' });
        if (key.asymmetricKeyType !== 'ed25519' || !createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(expected))
          throw new Error('Local key mismatch.');
        const signature = await new CompactSign(Buffer.from(payload)).setProtectedHeader({ alg: 'Ed25519', typ }).sign(key);
        if (closed) throw new Error('Local host closed.');
        return signature;
      });
    } });
  // Optional trusted composition keeps the A2A SDK dependency out of the
  // standalone Official client. It never discovers or configures external peers.
  const a2aFlow = a2aHostFactory?.({ dataDirectory, endpoint, sessions, cases: caseClient, consentSend, caseSend, caseRead, now,
    signIntent: async (payload, typ) => {
      if (typ !== 'galaxy-consent+jws' || !a2aFlow.isSigningIntent(payload)) throw new Error('Confirmed A2A import intent required.');
      const actor = await sessions.readAuthorization(endpoint), intent = consentSchema.parse(JSON.parse(payload));
      if (!actor || intent.action !== 'case.teaser.publish') throw new Error('A2A import authorization required.');
      assertConsentPolicy(intent, { actor, endpoint, now: now() });
      return withLocalRead(dataDirectory, async directory => {
        const local = await load(directory);
        if (closed || !baseline || local.fingerprint !== baseline.fingerprint || intent.expiresAt > local.intentExpiresAt
          || !a2aFlow.isSigningIntent(payload)) throw new Error('Local A2A import authorization changed.');
        const key = createPrivateKey(await readBounded(localPaths(directory).privateKey, 4096));
        const expected = createPublicKey(local.identity.genesisProof.publicKeyPem).export({ type: 'spki', format: 'der' });
        if (key.asymmetricKeyType !== 'ed25519' || !createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(expected))
          throw new Error('Local key mismatch.');
        return new CompactSign(Buffer.from(payload)).setProtectedHeader({ alg: 'Ed25519', typ }).sign(key);
      });
    } });
  const controller = createHostConnectionController({ endpoint, client, sessions, statusClient, bindingManagementClient, identityClient, historyClient, searchClient, projectDiscoveryClient, profileFlow, caseReviewFlow, caseClient, assistanceClient, assistanceFlow, contextClient, contextFlow, notificationsClient, honorClient, capsuleClient, capsuleFlow, builderClient, builderFlow, nodeControlProofFlow, auditClient, dataExportClient, deletionClient, deletionStatusClient,
    saveExportToDirectory: (id, directory, options) => saveDataExport(dataExportClient, id, directory, options), moderationClient, moderationFlow, publicationFlow, a2aFlow,
    saveSearchFeedback: input => saveLocalSearchFeedback(dataDirectory, {...input,assertCurrent:async directory=>{
      await trust();const local=await load(directory);
      return !closed&&baseline!==null&&local.fingerprint===baseline.fingerprint&&input.assertCurrent();
    }}),
    readRequest: async () => {
      await trust();
      const local = await withLocalRead(dataDirectory, load);
      if (closed) throw new Error('Local host closed.');
      // A new preview never upgrades existing credentials to a changed identity.
      if (baseline && baseline.fingerprint !== local.fingerprint) sessions.close();
      baseline = local;
      return { subjectId: local.identity.id, genesisProof: local.identity.genesisProof, installationId, scopes: requestedScopes };
    } });
  const hostController = Object.freeze({ ...controller,
    createContextDraft: record=>contextStore.createDraft(record),
    getContextDraft: id=>contextStore.getDraft(id),
    previewContextFile: input=>contextStore.previewFile(input),
    saveContextDraft: input=>contextStore.saveDraft(input),
    rebaseContextDraft: input=>contextStore.rebaseDraft(input),
    listContextDrafts: ()=>contextStore.listDrafts(),
    forgetContextDraft: id=>contextStore.forgetDraft(id),
    getLocalContextOperation: id=>contextStore.get(id),
    createAssistanceDraft: () => assistanceStore.createDraft(),
    createAssistanceEventDraft: input => assistanceStore.createEventDraft(input),
    rebaseAssistanceDraft: input => assistanceStore.rebaseDraft(input),
    getAssistanceDraft: id => assistanceStore.getDraft(id),
    saveAssistanceDraft: input => assistanceStore.saveDraft(input),
    listAssistanceDrafts: () => assistanceStore.listDrafts(),
    forgetAssistanceDraft: id => assistanceStore.forgetDraft(id),
    async querySearchFeedback(input={}) { if(closed)throw new Error('Local host closed.');return readLocalSearchFeedback(dataDirectory,{...input,endpoint}); },
    async editSearchFeedback(input) { if(closed)throw new Error('Local host closed.');return editLocalSearchFeedback(dataDirectory,{...input,endpoint,assertCurrent:()=>!closed}); },
    async listBindingReceipts() { if (closed) throw new Error('Local host closed.'); return receipts.list(); },
    async status() { return { ...await controller.status(), networkType, receiptSaveState }; },
  });
  // Local help survives process restarts; credentials remain in this runtime's
  // existing session memory. Resolve the identity for every operation, including
  // offline reads, so a switched identity cannot reuse a previous help folder.
  let helpInstance = null, helpSubject = null;
  const helpFlow = Object.freeze(Object.fromEntries(
    ['start', 'get', 'query', 'compose', 'select', 'pause', 'publish', 'reconcile', 'refresh', 'returnToTask', 'forget']
      .map(method => [method, async (...args) => {
        if (closed) throw new Error('Local host closed.');
        const identity = await withLocalRead(dataDirectory, readIdentity);
        if (closed) throw new Error('Local host closed.');
        if (helpSubject !== identity.id) {
          helpInstance = createHelpRuntimeV2({ dataDirectory, endpoint, subjectId: identity.id, sessions, now,
            send: helpSend, read: helpRead });
          helpSubject = identity.id;
        }
        return helpInstance[method](...args);
      }])));
  return Object.freeze({ controller: hostController, helpFlow,
    close() { closed = true; controller.cancel(); sessions.close(); baseline = null; helpInstance = null; helpSubject = null; } });
}
