import { fetchPublicJson, validatePublicUrl } from './public-fetch.mjs';
import { verifyNetworkManifest } from './verification/manifest.mjs';
import { acceptKeyring } from './trust-store.mjs';

export function discoverOfficialWithRoot(endpoint,rootPins,options){return discoverNetworkWithRoot(endpoint,rootPins,{...options,networkType:'official'});}
export function discoverHubWithRoot(endpoint,rootPins,options){return discoverNetworkWithRoot(endpoint,rootPins,{...options,networkType:'hub'});}
async function discoverNetworkWithRoot(endpoint, rootPins, { trustDirectory,networkType,
  now = Math.floor(Date.now() / 1000) } = {}) {
  try {
    const url = validatePublicUrl(endpoint);
    if (url.origin !== endpoint) throw new Error('Canonical origin required.');
    const keyring = await fetchPublicJson(`${endpoint}/.well-known/galaxy-signing-keys.json`);
    const trusted = await acceptKeyring(keyring, { endpoint, rootPins, directory: trustDirectory, now });
    return discoverNetwork(endpoint, trusted.keys, { now,networkType });
  } catch (error) {
    return { state: error.code === 'ERR_JWT_EXPIRED' ? 'expired' : 'unverified',
      connected: false, authorized: false, checkedAt: now };
  }
}

// No local store, identity, credential or telemetry dependency. Call explicitly
// from the connection page; configuration alone never triggers a network call.
export function discoverOfficial(endpoint,trustedKeys,options){return discoverNetwork(endpoint,trustedKeys,{...options,networkType:'official'});}
export function discoverHub(endpoint,trustedKeys,options){return discoverNetwork(endpoint,trustedKeys,{...options,networkType:'hub'});}
async function discoverNetwork(endpoint, trustedKeys, { networkType,now = Math.floor(Date.now() / 1000) } = {}) {
  try {
    const url = validatePublicUrl(endpoint);
    if (url.origin !== endpoint) throw new Error('Canonical origin required.');
  } catch { return { state: 'invalid-endpoint', connected: false, authorized: false }; }
  let document;
  try { document = await fetchPublicJson(`${endpoint}/.well-known/galaxy-network.json`); }
  catch { return { state: 'unreachable', connected: false, authorized: false, checkedAt: now }; }
  try { return { ...await verifyNetworkManifest(document, { endpoint, trustedKeys, now,networkType }), checkedAt: now }; }
  catch (error) {
    return { state: error.code === 'ERR_JWT_EXPIRED' ? 'expired' : 'unverified',
      connected: false, authorized: false, checkedAt: now };
  }
}
