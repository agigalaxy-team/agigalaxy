import { randomUUID } from 'node:crypto';
import { compactVerify, importSPKI, SignJWT } from 'jose';
import { transaction } from "../infrastructure/database.mjs";
import { currentControlKey } from "../infrastructure/identity-control-repository.mjs";
import { ServiceError } from "../shared/service-error.mjs";
import { choiceReceiptResultSchema } from "../shared/choice-snapshot-schema-v2.mjs";
import { receiptStatusChallengeInputSchema, receiptStatusChallengeResultSchema, receiptStatusQuerySchema,
  receiptStatusChallengeType, receiptStatusResponseType, receiptStatusMaxAge, verifyReceiptStatusChallenge } from "../shared/receipt-status-schema.mjs";

const fail = (code, status = 401) => { throw new ServiceError(code, status); };
const parse = (schema, input) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail('invalid_receipt_status_request', 400);
  return parsed.data;
};

// No ordinary Access actor, session, binding or durable challenge ledger is
// minted. A signed short-lived proof can only read this closed metadata family.
export function createReceiptStatusService({ db, endpoint, signingKey, kid, trustedKeys,
  now = () => Math.floor(Date.now() / 1000), retirement, choiceSnapshots }) {
  const phase = () => retirement?.phase() ?? 'normal';
  function deadline() {
    const time = now(), end = retirement?.snapshot().policy?.statusUntil ?? Number.POSITIVE_INFINITY;
    if (!Number.isSafeInteger(time) || time < 0 || phase() === 'closed' || time >= end) fail('service_retired', 410);
    return Math.min(time + receiptStatusMaxAge, end);
  }
  async function controlWithin(database, request) {
    // Deletion revokes retained authentication state; it must not be recreated
    // from a supplied genesis or from an expired binding.
    const requested = request.control;
    const current = await currentControlKey(database, request.subjectId, {
      ...(requested.deviceId === null ? {} : { deviceId: requested.deviceId }), keyId: requested.keyId,
      epoch: requested.epoch, scope: 'binding',
    });
    if (current.deviceId !== requested.deviceId || current.keyId !== requested.keyId || current.epoch !== requested.epoch)
      fail('receipt_status_access_denied');
    if ((await database.query("SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('partial','primary-erased')",
      [request.subjectId])).rows.length) fail('receipt_status_access_denied');
    return current;
  }
  async function challenge(input) {
    const request = parse(receiptStatusChallengeInputSchema, input);
    return transaction(db, async database => {
      deadline();
      await controlWithin(database, request);
      const issuedAt = now(), expiresAt = deadline(), pin = trustedKeys.get(kid);
      if (!pin || pin.revoked || !Number.isSafeInteger(pin.notBefore) || !Number.isSafeInteger(pin.notAfter)
        || pin.notBefore > issuedAt || pin.notAfter < expiresAt
        || pin.trustedUntil !== undefined && (!Number.isSafeInteger(pin.trustedUntil) || pin.trustedUntil <= issuedAt)) fail('signing_unavailable', 503);
      const id = randomUUID(), data = { ...request, version: 1, purpose: 'receipt-status', endpoint,
        authority: 'retained-owner-operation-only' };
      const token = await new SignJWT({ data }).setProtectedHeader({ alg: 'Ed25519', typ: receiptStatusChallengeType, kid })
        .setIssuer(endpoint).setAudience(endpoint).setIssuedAt(issuedAt).setNotBefore(issuedAt).setExpirationTime(expiresAt).setJti(id).sign(signingKey);
      deadline();
      return receiptStatusChallengeResultSchema.parse({ challenge: token, challengeId: id, expiresAt, ordinarySessionCreated: false });
    });
  }
  async function query(input) {
    const request = parse(receiptStatusQuerySchema, input);
    const open = async () => {
      try { return await verifyReceiptStatusChallenge(request.challenge, { endpoint, trustedKeys, now: now() }); }
      catch { fail('receipt_status_proof_invalid'); }
    };
    await open();
    return transaction(db, async database => {
      deadline();
      // Recheck current signing pins and the proof deadline after waiting for
      // the database lease, not just before entering the transaction queue.
      const opened = await open();
      const control = await controlWithin(database, opened.data);
      try {
        const checked = await compactVerify(request.signature, await importSPKI(control.publicKey, 'Ed25519'), { algorithms: ['Ed25519'] });
        if (Object.keys(checked.protectedHeader).sort().join(',') !== 'alg,typ'
          || checked.protectedHeader.typ !== receiptStatusResponseType
          || Buffer.from(checked.payload).toString('utf8') !== request.challenge) throw new Error();
      } catch { fail('receipt_status_proof_invalid'); }
      // The operation comes only from the validated signed challenge. No URL,
      // method name, generic service dispatch or request-supplied actor exists.
      const { kind: _kind, ...locator } = opened.data.operation;
      const receipt = choiceReceiptResultSchema.parse(await choiceSnapshots.receiptWithin(database, opened.data.subjectId, locator));
      deadline();
      await open();
      return receipt;
    });
  }
  return Object.freeze({ challenge, query });
}
