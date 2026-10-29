// Independent jose signer and current client verifier for Go's domain wire
// envelopes. All key material arrives from a freshly generated test key on stdin.
import {createPrivateKey} from 'node:crypto';
import {SignJWT} from 'jose';
import {verifyEnvelope} from '../../packages/galaxy-client/src/verification/envelope.mjs';

let text = '';
for await (const chunk of process.stdin) text += chunk;
const x = JSON.parse(text), type = x.kind ?? 'proof';
const token = await new SignJWT({data: x.data})
  .setProtectedHeader({alg: 'Ed25519', typ: `galaxy-${type}+jwt`, kid: x.kid})
  .setIssuer(x.endpoint).setAudience(x.endpoint).setIssuedAt(x.at).setNotBefore(x.at)
  .setExpirationTime(x.at + x.age).setJti(x.id).sign(createPrivateKey(x.privateKeyPem));
const trustedKeys = new Map([[x.kid, {publicKeyPem: x.publicKeyPem, notBefore: x.at - 10, notAfter: x.at + 100000}]]);
const opened = await verifyEnvelope(x.token, {type, issuer: x.endpoint, audience: x.endpoint, trustedKeys, now: x.at, maxAge: type === 'proof' ? 86400 : 300});
console.log(JSON.stringify({sameBytes: token === x.token, data: opened.data, expiresAt: opened.expiresAt}));
