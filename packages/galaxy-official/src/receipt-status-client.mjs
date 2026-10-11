import { receiptStatusChallengeInputSchema, receiptStatusChallengeResultSchema, receiptStatusOperationSchema,
  receiptStatusResponseType, verifyReceiptStatusChallenge } from './shared/receipt-status-schema.mjs';
import { choiceReceiptResultSchema } from './shared/choice-snapshot-schema-v2.mjs';
import { signIdentityPayload, toBase64Url } from '../../galaxy-core/src/domain/identity-material.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = code => { throw Object.assign(new Error(code), { code }); };
function context(input, endpoint) {
  const x = receiptStatusChallengeInputSchema.pick({ subjectId: true, control: true }).parse({ subjectId: input?.subjectId, control: input?.control });
  if (input.endpoint !== undefined && input.endpoint !== endpoint) fail('receipt_status_authority_changed');
  const generation = input.generation ?? null, bindingId = input.bindingId ?? null;
  if (generation !== null && (!Number.isSafeInteger(generation) || generation < 0)
    || bindingId !== null && !/^[a-f0-9-]{36}$/.test(bindingId)) fail('receipt_status_authority_changed');
  return { ...x, endpoint, generation, bindingId };
}

// Purpose-bound signer. It can sign only a currently pinned server challenge
// for this local owner/device; it is not a generic identity signing endpoint.
export function createReceiptStatusDeviceSigner({ endpoint, trustedKeys, getContext, getPrivateKey,
  now = () => Math.floor(Date.now() / 1000), crypto = globalThis.crypto }) {
  return async function signReceiptStatus(token) {
    const lease = context(await getContext(), endpoint);
    const check = async () => {
      if (!same(lease, context(await getContext(), endpoint))) fail('receipt_status_authority_changed');
    };
    const proof = await verifyReceiptStatusChallenge(token, { endpoint, trustedKeys, now: now() });
    await check();
    if (proof.data.subjectId !== lease.subjectId || !same(proof.data.control, lease.control)) fail('receipt_status_authority_changed');
    const privateKey = await getPrivateKey(); await check();
    const signature = await signIdentityPayload(token, privateKey, { type: receiptStatusResponseType, crypto });
    await check();
    await verifyReceiptStatusChallenge(token, { endpoint, trustedKeys, now: now() }); await check();
    return signature;
  };
}

// Standalone read-only recovery, usable without an ordinary browser session.
// No Bearer, cookie, local journal/body upload, synchronization or retry loop.
export function createReceiptStatusClient({ endpoint, trustedKeys, getContext, signReceiptStatus,
  now = () => Math.floor(Date.now() / 1000), fetch: fetcher = globalThis.fetch, crypto = globalThis.crypto }) {
  if (new URL(endpoint).origin !== endpoint || !endpoint.startsWith('https://')
    || !(trustedKeys instanceof Map) || typeof getContext !== 'function' || typeof signReceiptStatus !== 'function')
    throw new Error('Invalid receipt status authority configuration.');
  async function post(path, input, signal) {
    const response = await fetcher(endpoint + path, { method: 'POST', body: JSON.stringify(input),
      redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });
    if (Number(response.headers.get('content-length')) > 32768) fail('receipt_status_response_too_large');
    const text = await response.text();
    if (new TextEncoder().encode(text).length > 32768) fail('receipt_status_response_too_large');
    let data; try { data = JSON.parse(text); } catch { fail('receipt_status_response_invalid'); }
    if (!response.ok) fail(typeof data?.error === 'string' && /^[a-z0-9_:-]{1,100}$/.test(data.error) ? data.error : 'receipt_status_request_failed');
    return data;
  }
  async function query(input, { signal } = {}) {
    const operation = receiptStatusOperationSchema.parse(input), lease = context(await getContext(), endpoint);
    const check = async () => {
      signal?.throwIfAborted();
      if (!same(lease, context(await getContext(), endpoint))) fail('receipt_status_authority_changed');
    };
    const request = { subjectId: lease.subjectId, control: lease.control, operation,
      clientNonce: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) };
    await check();
    const issued = receiptStatusChallengeResultSchema.parse(await post('/v2/receipt-status/challenges', request, signal)); await check();
    const opened = await verifyReceiptStatusChallenge(issued.challenge, { endpoint, trustedKeys, now: now() }); await check();
    const { version: _version, purpose: _purpose, endpoint: _endpoint, authority: _authority, ...signedRequest } = opened.data;
    if (!same(request, signedRequest) || issued.challengeId !== opened.challengeId || issued.expiresAt !== opened.expiresAt)
      fail('receipt_status_challenge_mismatch');
    const signature = await signReceiptStatus(issued.challenge); await check();
    // Late signing must not use a challenge after its deadline.
    await verifyReceiptStatusChallenge(issued.challenge, { endpoint, trustedKeys, now: now() }); await check();
    const receipt = choiceReceiptResultSchema.parse(await post('/v2/receipt-status/query', { challenge: issued.challenge, signature }, signal));
    await check();
    if (receipt.snapshotId !== operation.snapshotId || receipt.versionId !== operation.versionId || receipt.requestHash !== operation.requestHash)
      fail('receipt_status_receipt_mismatch');
    return receipt;
  }
  return Object.freeze({ query });
}
