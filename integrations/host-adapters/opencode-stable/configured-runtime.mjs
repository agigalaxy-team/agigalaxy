import { fetchPublicJson, validatePublicUrl } from '../../../packages/galaxy-official/src/public-fetch.mjs';
import { verifyNetworkManifest } from '../../../packages/galaxy-official/src/verification/manifest.mjs';
import { createLocalHostRuntime } from '../../../packages/galaxy-official/src/local-host-runtime.mjs';
import { createLocalBindingReceipts } from '../../../packages/galaxy-official/src/local-binding-receipts.mjs';
import { createLocalAssistanceStore } from '../../../packages/galaxy-official/src/local-assistance-store.mjs';
import { createLocalContextStore } from '../../../packages/galaxy-official/src/local-context-store.mjs';
import { readLocalSearchFeedback, editLocalSearchFeedback } from '../../../packages/galaxy-official/src/local-search-feedback.mjs';
import { acceptKeyring } from '../../../packages/galaxy-official/src/trust-store.mjs';
import { isAbsolute } from 'node:path';

// Trusted host configuration only. Construction does not read identity or fetch.
export function createConfiguredRuntime(configuration, { readManifest = fetchPublicJson, readKeyring = fetchPublicJson } = {}) {
  const { endpoint, scopes, trustedKeys, rootPins, trustDirectory, networkType = 'official', now = () => Math.floor(Date.now() / 1000) } = configuration;
  if (validatePublicUrl(endpoint).origin !== endpoint || !(trustedKeys instanceof Map)
    || !Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string') || !['official','hub'].includes(networkType))
    throw new Error('Invalid configured endpoint.');
  const rootManaged=rootPins!==undefined||trustDirectory!==undefined;
  if(rootManaged&&(!(rootPins instanceof Map)||rootPins.size===0||typeof trustDirectory!=='string'||!isAbsolute(trustDirectory)))
    throw new Error('Root-managed discovery requires root pins and an absolute trust directory.');
  const requestedScopes = Object.freeze([...scopes]);
  const config = { ...configuration, networkType, scopes: requestedScopes, now };
  const receipts = createLocalBindingReceipts(config);
  let runtime = null, generation = 0, closed = false, active = null;
  const assistanceStore = createLocalAssistanceStore({dataDirectory:config.dataDirectory,endpoint,assertOpen:()=>!closed});
  const contextStore=createLocalContextStore({dataDirectory:config.dataDirectory,endpoint,assertOpen:()=>!closed});
  let snapshot = { state: 'not-read', checkedAt: null, expiresAt: null }, verifiedPin = null;
  let trustSequence=null;
  const status = () => {
    let state = snapshot.state;
    if (state === 'verified') {
      const time = now(), pin = trustedKeys.get(verifiedPin.kid);
      if (!Number.isSafeInteger(time) || time < snapshot.checkedAt) state = 'unverified';
      else if (time >= snapshot.expiresAt) state = 'expired';
      else if (!pin || pin.revoked || pin.publicKeyPem !== verifiedPin.publicKeyPem
        || time < pin.notBefore || time >= pin.notAfter || (pin.trustedUntil !== undefined && time >= pin.trustedUntil)) state = 'unverified';
    }
    return Object.freeze({ ...snapshot, state, endpoint, networkType, connected: false, authorized: false,
      trustMode:rootManaged?'root-managed':'host-provided-keys',trustSequence });
  };
  return Object.freeze({
    endpoint, networkType, scopes: requestedScopes, status,
    createContextDraft: record=>contextStore.createDraft(record),
    getContextDraft: id=>contextStore.getDraft(id),
    previewContextFile: input=>contextStore.previewFile(input),
    saveContextDraft: input=>contextStore.saveDraft(input),
    rebaseContextDraft: input=>contextStore.rebaseDraft(input),
    listContextDrafts: ()=>contextStore.listDrafts(),
    forgetContextDraft: id=>contextStore.forgetDraft(id),
    listContextOperations: ()=>contextStore.list(),
    getLocalContextOperation: id=>contextStore.get(id),
    forgetContextOperation: id=>contextStore.forget(id),
    cancel() {},
    createAssistanceDraft: () => assistanceStore.createDraft(),
    createAssistanceEventDraft: input => assistanceStore.createEventDraft(input),
    rebaseAssistanceDraft: input => assistanceStore.rebaseDraft(input),
    getAssistanceDraft: id => assistanceStore.getDraft(id),
    saveAssistanceDraft: input => assistanceStore.saveDraft(input),
    listAssistanceDrafts: () => assistanceStore.listDrafts(),
    forgetAssistanceDraft: id => assistanceStore.forgetDraft(id),
    listCollaborationOperations: () => assistanceStore.list(),
    forgetCollaborationOperation: id => assistanceStore.forget(id),
    async querySearchFeedback(input={}) { if(closed)throw new Error('Configured runtime closed.');return readLocalSearchFeedback(config.dataDirectory,{...input,endpoint}); },
    async editSearchFeedback(input) { if(closed)throw new Error('Configured runtime closed.');return editLocalSearchFeedback(config.dataDirectory,{...input,endpoint,assertCurrent:()=>!closed}); },
    async listBindingReceipts() { if (closed) throw new Error('Configured runtime closed.'); return receipts.list(); },
    async read(signal) {
      if (closed) throw new Error('Configured runtime closed.');
      signal.throwIfAborted();
      const current = ++generation;
      active?.abort();
      const operation = new AbortController(); active = operation;
      const combined = AbortSignal.any([signal, operation.signal]);
      snapshot = { state: 'reading', checkedAt: null, expiresAt: null };
      let failure = 'unreachable';
      try {
        if(rootManaged){
          const keyring=await readKeyring(`${endpoint}/.well-known/galaxy-signing-keys.json`,{signal:combined});
          combined.throwIfAborted();failure='unverified';
          const accepted=await acceptKeyring(keyring,{endpoint,rootPins,directory:trustDirectory,now:now()});
          // Persistence is the commit point for trust. Cancellation after that
          // point must not leave revoked keys usable by an earlier controller.
          if(trustSequence===null||accepted.nextState.sequence>=trustSequence){
            runtime?.close();runtime=null;
            trustedKeys.clear();for(const [kid,pin] of accepted.keys)trustedKeys.set(kid,pin);
            trustSequence=accepted.nextState.sequence;
          }
          combined.throwIfAborted();
          if(closed||current!==generation)throw new Error('Service read superseded.');
          failure='unreachable';
        }
        const document = await readManifest(`${endpoint}/.well-known/galaxy-network.json`, { signal: combined });
        combined.throwIfAborted();
        const checkedAt = now();
        failure = 'unverified';
        const verified = await verifyNetworkManifest(document, { endpoint, trustedKeys, networkType, now: checkedAt });
        combined.throwIfAborted();
        if (closed || current !== generation) throw new Error('Service read superseded.');
        failure = 'unsupported';
        if (!['binding', 'sessions'].every(item => verified.data.capabilities.includes(item)))
          throw new Error('Endpoint does not advertise connection support.');
        failure = 'configuration-invalid';
        const next = createLocalHostRuntime({ ...config, manifest: document });
        runtime?.close(); runtime = next;
        verifiedPin = { kid: verified.data.signingKeyId, publicKeyPem: trustedKeys.get(verified.data.signingKeyId).publicKeyPem };
        snapshot = { state: 'verified', checkedAt, expiresAt: verified.expiresAt };
        return { controller: next.controller, operator: verified.data.operator, networkType,
          profile: verified.profile ?? null, manifestSha256: verified.manifestSha256 ?? null,
          displayName: verified.data.displayName, checkedAt, expiresAt: verified.expiresAt,
          connected: false, authorized: false };
      } catch (error) {
        if (!closed && current === generation) snapshot = { state: combined.aborted ? 'canceled'
          : error.code === 'ERR_JWT_EXPIRED' ? 'expired' : failure, checkedAt: now(), expiresAt: null };
        throw error;
      } finally { if (active === operation) active = null; }
    },
    close() { closed = true; generation++; active?.abort(); active = null; runtime?.close(); runtime = null;
      snapshot = { state: 'closed', checkedAt: null, expiresAt: null }; },
  });
}
