import { signEnvelope } from './signed-envelope.mjs';
import { validateKeyring } from "../verification/keyring.mjs";
export { validateKeyring, verifyKeyring } from "../verification/keyring.mjs";

export async function issueKeyring({ endpoint, keys, sequence, rootKid, rootPrivateKey,
  now = Math.floor(Date.now() / 1000), maxAge = 86400 }) {
  const data = validateKeyring({ version: 1, endpoint, sequence, keys }, endpoint);
  return { signed: await signEnvelope({ type: 'keyring', issuer: endpoint, audience: endpoint,
    kid: rootKid, privateKey: rootPrivateKey, data, now, maxAge }) };
}

