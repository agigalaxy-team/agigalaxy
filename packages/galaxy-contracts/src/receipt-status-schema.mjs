import * as z from 'zod/v4';
import { importSPKI, jwtVerify } from 'jose';

export const receiptStatusChallengeType = 'galaxy-receipt-status-challenge+jwt';
export const receiptStatusResponseType = 'galaxy-receipt-status-response+jws';
export const receiptStatusMaxAge = 120;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const origin = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
});
export const receiptStatusControlSchema = z.strictObject({
  deviceId: z.uuid().nullable(), keyId: hash, epoch: z.number().int().nonnegative(),
}).refine(value => value.epoch === 0 ? value.deviceId === null : value.deviceId !== null);
export const receiptStatusOperationSchema = z.strictObject({
  kind: z.literal('choice-snapshot'), snapshotId: z.uuid(), versionId: z.uuid(), requestHash: hash,
});
export const receiptStatusChallengeInputSchema = z.strictObject({
  subjectId: z.string().regex(/^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/),
  control: receiptStatusControlSchema, operation: receiptStatusOperationSchema,
  clientNonce: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
});
export const receiptStatusChallengeDataSchema = receiptStatusChallengeInputSchema.safeExtend({
  version: z.literal(1), purpose: z.literal('receipt-status'), endpoint: origin,
  authority: z.literal('retained-owner-operation-only'),
});
export const receiptStatusQuerySchema = z.strictObject({
  challenge: z.string().min(1).max(8192), signature: z.string().min(1).max(24000),
});
export const receiptStatusChallengeResultSchema = z.strictObject({
  challenge: z.string().min(1).max(8192), challengeId: z.uuid(),
  expiresAt: z.number().int().nonnegative(), ordinarySessionCreated: z.literal(false),
});

// Both the device and service validate the same exact, purpose-specific token.
// Pins are supplied by deployment/local trust, never by a challenge or locator.
export async function verifyReceiptStatusChallenge(token, { endpoint, trustedKeys, now }) {
  origin.parse(endpoint);
  if (!Number.isSafeInteger(now) || now < 0 || !(trustedKeys instanceof Map)
    || typeof token !== 'string' || new TextEncoder().encode(token).length > 8192) throw new Error('receipt_status_proof_invalid');
  const verified = await jwtVerify(token, async header => {
    if (Object.keys(header).sort().join(',') !== 'alg,kid,typ'
      || header.alg !== 'Ed25519' || header.typ !== receiptStatusChallengeType) throw new Error('receipt_status_proof_invalid');
    const pin = trustedKeys.get(header.kid);
    if (!pin || pin.revoked || !Number.isSafeInteger(pin.notBefore) || !Number.isSafeInteger(pin.notAfter)
      || now < pin.notBefore || now >= pin.notAfter
      || pin.trustedUntil !== undefined && (!Number.isSafeInteger(pin.trustedUntil) || now >= pin.trustedUntil)) throw new Error('receipt_status_proof_invalid');
    return importSPKI(pin.publicKeyPem, 'Ed25519');
  }, { algorithms: ['Ed25519'], typ: receiptStatusChallengeType, issuer: endpoint, audience: endpoint,
    requiredClaims: ['iat', 'nbf', 'exp', 'jti', 'data'], currentDate: new Date(now * 1000), maxTokenAge: receiptStatusMaxAge });
  const payload = verified.payload, pin = trustedKeys.get(verified.protectedHeader.kid);
  if (Object.keys(payload).sort().join(',') !== 'aud,data,exp,iat,iss,jti,nbf'
    || payload.aud !== endpoint || payload.nbf !== payload.iat
    || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
    || payload.exp <= payload.iat || payload.exp - payload.iat > receiptStatusMaxAge
    || payload.iat < pin.notBefore || payload.exp > pin.notAfter
    || !z.uuid().safeParse(payload.jti).success) throw new Error('receipt_status_proof_invalid');
  const data = receiptStatusChallengeDataSchema.parse(payload.data);
  if (data.endpoint !== endpoint) throw new Error('receipt_status_proof_invalid');
  return { data, challengeId: payload.jti, expiresAt: payload.exp };
}
