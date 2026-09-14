import { verifyEnvelope } from './envelope.mjs';
import canonicalize from 'canonicalize';
import { digest } from '../shared/digest.mjs';
import { validatePublicUrl } from '../public-fetch.mjs';

const CAPABILITIES = ['binding', 'sessions', 'docs-mcp'];
export function validateManifest(data, endpoint) {
  return validateNetworkManifest(data,endpoint,'official');
}
export const HUB_MANIFEST_PROFILE='galaxy-hub/1';
export function validateHubManifest(data,endpoint){return validateNetworkManifest(data,endpoint,'hub');}
export function validateNetworkManifest(data,endpoint,networkType){
  if(!['official','hub'].includes(networkType))throw new Error('Unsupported network type.');
  const keys = ['schemaVersion', 'networkType', 'displayName', 'operator', 'endpoint', 'capabilities',
    'policy', 'region', 'serviceVersion', 'signingKeyId', 'revocationPath',...(networkType==='hub'?['hub']:[])];
  if (!data || Object.getPrototypeOf(data) !== Object.prototype
    || Object.keys(data).sort().join(',') !== keys.sort().join(',')
    || data.schemaVersion !== 1 || data.networkType !== networkType || data.endpoint !== endpoint
    || (networkType==='official'?data.serviceVersion !== '0.1.0':typeof data.serviceVersion!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(data.serviceVersion)||data.serviceVersion.length>80)
    || data.revocationPath !== '/v1/signing-keys/status'
    || !Array.isArray(data.capabilities) || new Set(data.capabilities).size !== data.capabilities.length
    || data.capabilities.some(c => !CAPABILITIES.includes(c))) throw new Error('Invalid Manifest schema.');
  for (const field of ['displayName', 'operator', 'region', 'signingKeyId']) {
    if (typeof data[field] !== 'string' || data[field].length < 1 || data[field].length > 240)
      throw new Error('Invalid Manifest metadata.');
  }
  if (!data.policy || Object.keys(data.policy).sort().join(',') !== 'automaticUpload,privateKeyCustody,url'
    || data.policy.automaticUpload !== false || data.policy.privateKeyCustody !== 'client') throw new Error('Invalid Manifest policy.');
  const policyUrl = new URL(data.policy.url);
  if (policyUrl.origin !== endpoint || policyUrl.username || policyUrl.password || policyUrl.search || policyUrl.hash)
    throw new Error('Invalid Manifest policy URL.');
  if(networkType==='hub'){
    if(validatePublicUrl(endpoint).origin!==endpoint)throw new Error('Canonical Hub origin required.');
    const hub=data.hub;
    if(!hub||Object.getPrototypeOf(hub)!==Object.prototype||Object.keys(hub).sort().join(',')!=='charter,exit,export,profile,scope'||hub.profile!==HUB_MANIFEST_PROFILE)
      throw new Error('Unsupported Hub Manifest profile.');
    for(const name of ['scope','exit','export'])if(typeof hub[name]!=='string'||hub[name].trim().length===0||hub[name].length>1500||/\p{Cc}/u.test(hub[name]))throw new Error('Invalid Hub policy statement.');
    if(typeof hub.charter!=='string'||hub.charter.length>500)throw new Error('Invalid Hub charter reference.');
    validatePublicUrl(hub.charter);
  }
  return data;
}

export function hubManifestDigest(data){validateHubManifest(data,data?.endpoint);return digest(canonicalize(data));}
export function verifyManifest(document,options){return verifyNetworkManifest(document,{...options,networkType:'official'});}
export function verifyHubManifest(document,options){return verifyNetworkManifest(document,{...options,networkType:'hub'});}
export async function verifyNetworkManifest(document, { endpoint, trustedKeys, networkType, now = Math.floor(Date.now() / 1000) }) {
  if (!document || Object.keys(document).join(',') !== 'signed') throw new Error('Invalid Manifest envelope.');
  const opened = await verifyEnvelope(document.signed, { type: 'manifest', issuer: endpoint,
    audience: endpoint, trustedKeys, now, maxAge: 300 });
  const data = validateNetworkManifest(opened.data, endpoint,networkType);
  if (data.signingKeyId !== opened.kid) throw new Error('Manifest signing key mismatch.');
  return { state: 'verified', data, expiresAt: opened.expiresAt, connected: false, authorized: false,
    ...(networkType==='hub'?{profile:HUB_MANIFEST_PROFILE,manifestSha256:hubManifestDigest(data)}:{}) };
}
