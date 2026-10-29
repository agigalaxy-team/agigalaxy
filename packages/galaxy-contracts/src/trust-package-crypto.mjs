import canonicalize from 'canonicalize';
import { compactVerify, importSPKI } from 'jose';
import * as z from 'zod/v4';
import { createBrowserGenesis } from './identity/guid-browser-adapter.mjs';
import { fromBase64Url } from './identity/identity-material.mjs';
import { verifyControlChainWith } from './trust-package-control-chain-engine.mjs';
import { controlSchemas } from './trust-package-control-schema-factory.mjs';

export const trustCanonical = value => { const text = canonicalize(value); if (typeof text !== 'string') throw new Error('Invalid canonical trust data.'); return text; };
export const trustHash = async text => [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
export const trustSubject = z.string().regex(/^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
const publicKey = z.string().regex(/^-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=\n-----END PUBLIC KEY-----\n$/);
const { controlOperationSchema } = controlSchemas({ controlSubject: trustSubject, controlPublicKey: publicKey });

export async function verifyTrustJws(signature, publicKeyPem, type, payloadText) {
  const checked = await compactVerify(signature, await importSPKI(publicKeyPem, 'Ed25519'), { algorithms: ['Ed25519'] });
  if (Object.keys(checked.protectedHeader).sort().join(',') !== 'alg,typ' || checked.protectedHeader.typ !== type) throw new Error('Unexpected trust signature header.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(checked.payload);
  if (payloadText !== undefined && text !== payloadText) throw new Error('Signed bytes do not match.');
  return text;
}

export async function verifyPortableGenesis(subjectId, proof) {
  try {
    trustSubject.parse(subjectId); if (proof?.version !== 1) return false;
    publicKey.parse(proof.publicKeyPem);
    let issuedAtMs = 0; const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    for (const char of subjectId.slice(6, 16)) issuedAtMs = issuedAtMs * 32 + alphabet.indexOf(char);
    const calculated = await createBrowserGenesis({ publicKeyPem: proof.publicKeyPem, nonce: fromBase64Url(proof.nonce),
      originCode: subjectId[5], issuedAtMs });
    return calculated.id === subjectId;
  } catch { return false; }
}

export async function verifyTrustIdentity(identity) {
  if (!await verifyPortableGenesis(identity.subjectId, identity.genesisProof)) throw new Error('Invalid portable Galaxy genesis.');
  if (!identity.events?.length) return { subjectId: identity.subjectId, epoch: 0, sequence: 0, chainHead: null,
    devices: [{ keyId: await trustHash(identity.genesisProof.publicKeyPem), publicKey: identity.genesisProof.publicKeyPem,
      deviceId: null, scopes: ['*'], epoch: 0 }], historySignaturesVerified: true, currentRevocationChecked: false };
  return verifyControlChainWith(identity, { verifyGalaxyGenesis: verifyPortableGenesis, controlOperationSchema,
    controlKeyId: trustHash, controlEventHash: event => trustHash(trustCanonical(event)),
    verifyControlSignature: (signature, pem, text) => verifyTrustJws(signature, pem, 'galaxy-identity-control-v2+jws', text) });
}
