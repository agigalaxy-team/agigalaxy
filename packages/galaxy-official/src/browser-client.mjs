import { verifyBindingChallenge, verifyBindingReceipt, verifyExistingBindingReceipt, verifySessionChallenge, verifySessionActivation } from './verification/connection.mjs';
import { sha256Hex, base64url, equalJson } from './shared/web-primitives.mjs';
import { consentSchema } from './shared/consents-schema.mjs';
import { assertConsentPolicy } from './domain/consent-policy.mjs';

export const browserScopes = Object.freeze(['binding', 'consent', 'case-teaser', 'evidence', 'proof', 'history', 'assistance', 'context', 'notifications', 'moderation', 'capsules', 'builders', 'audit', 'data-export', 'data-delete']);
const recruitmentReceiptPath = /^\/v2\/recruitment\/[0-9a-f-]{36}\/receipt\?operationId=[0-9a-f-]{36}&payloadHash=[a-f0-9]{64}$/;
const forumQuotaPath = /^\/v2\/community\/quotas\?(?:postId|replyId|sectionId)=[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const publicAccountUuid='[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}',publicAccountSubject='GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}';
const publicAccountPagePath=new RegExp('^/v1/account/public/(?:'+publicAccountUuid+'/(ids|credentials|posts)|by-id/'+publicAccountSubject+')$');
function allowedPublicAccountPage(path){
 const [pathname,query,...extra]=path.split('?'),match=publicAccountPagePath.exec(pathname);
 if(!match||!query||extra.length)return false;
 const parameters=new URLSearchParams(query),seen=new Set();
 for(const [key,value]of parameters){
  if(seen.has(key)||!['after','limit'].includes(key))return false;seen.add(key);
  if(key==='limit'&&!/^(?:[1-9]|[1-4][0-9]|50)$/.test(value))return false;
  if(key==='after'){
   const pattern=match[1]==='posts'?/^fp1\.[A-Za-z0-9_-]+$/:new RegExp('^(?:'+(match[1]==='ids'?publicAccountSubject:publicAccountUuid)+')$');
   if(value.length>512||!pattern.test(value))return false;
  }
 }
 return seen.size>0;
}
const allowedReadQuery = (path, method) => method === 'GET' && (recruitmentReceiptPath.test(path) || forumQuotaPath.test(path) || allowedPublicAccountPage(path));

// The deploy-time public configuration supplies the authority and pins. Neither
// a URL parameter nor a model response can select a credential destination.
function waitForClockBoundary(milliseconds,signal){
  return new Promise((resolve,reject)=>{
    if(signal.aborted)return reject(signal.reason);
    const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},milliseconds);
    signal.addEventListener('abort',cancel,{once:true});
  });
}
export function createBrowserClient({ endpoint, trustedKeys, sign, now = () => Math.floor(Date.now() / 1000), fetch: fetcher = globalThis.fetch, crypto = globalThis.crypto, waitForClock = waitForClockBoundary }) {
  const origin = new URL(endpoint);
  if (origin.protocol !== 'https:' || origin.origin !== endpoint || origin.username || origin.password
    || !(trustedKeys instanceof Map) || !trustedKeys.size || typeof sign !== 'function') throw new Error('Invalid browser authority configuration.');
  let session = null, generation = 0, closed = false, connectionController, establishedBinding = null;
  async function send(url, { bodyJson, method = 'POST', signal, credential, accountId } = {}) {
    const target = new URL(url);
    if (closed || target.origin !== endpoint || target.username || target.password || target.hash
      || target.search && !allowedReadQuery(target.pathname + target.search, method))
      throw new Error('Invalid browser API target.');
    if (accountId !== undefined && (typeof accountId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(accountId)))
      throw new Error('Invalid account target.');
    const deadline = AbortSignal.timeout(30000), operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response;
    try {
      response = await fetcher(target.href, { method, body: bodyJson, signal: operationSignal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', ...(bodyJson === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(credential ? { Authorization: `Bearer ${credential}`, ...(accountId ? {'X-Galaxy-Account-ID':accountId} : {}) } : {}) } });
    } catch (error) {
      if (error?.name === 'TimeoutError') throw Object.assign(new Error('request_timeout'), { code: 'request_timeout', cause: error });
      throw error;
    }
    const maximumResponse = target.pathname === '/v2/account-archives/export' ? 2097152 : 1048576;
    if (Number(response.headers.get('content-length')) > maximumResponse) throw new Error('API response too large.');
    const text = await response.text();
    if (new TextEncoder().encode(text).length > maximumResponse) throw new Error('API response too large.');
    let result; try { result = JSON.parse(text); } catch { throw new Error('API returned an invalid response.'); }
    if (!response.ok) {
      const code = typeof result?.error === 'string' && /^[a-z0-9_:-]{1,100}$/.test(result.error) ? result.error : 'request_failed';
      if (credential && [401, 403].includes(response.status) && session?.credential === credential
        && ['unauthorized', 'binding_revoked', 'invalid_session', 'session_expired', 'access_denied'].includes(code)) session = null;
      const rejection = { code, status: response.status, outcome: 'rejected' };
      // These are already public HTTP response metadata. Retain the server's
      // waiting condition without copying arbitrary response fields or bodies.
      const retryHeader = response.headers.get('retry-after');
      if ([429, 503].includes(response.status) || code === 'community_restricted') {
        const seconds = /^\d{1,9}$/.test(retryHeader ?? '') ? Number(retryHeader) : 0;
        if (Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 31536000)
          Object.assign(rejection, {retryAfterSeconds: seconds, retryAt: new Date((now() + seconds) * 1000).toISOString()});
        const quota = result?.quota;
        if (quota && ['task', 'comment', 'invitation'].includes(quota.category)
          && ['used', 'limit', 'remaining'].every(field => Number.isSafeInteger(quota[field]) && quota[field] >= 0)
          && typeof quota.resetAt === 'string' && Number.isFinite(Date.parse(quota.resetAt))
          && ['new', 'normal'].includes(quota.tier) && typeof quota.policyVersion === 'string' && quota.policyVersion.length <= 80)
          Object.assign(rejection, {quota: {category: quota.category, used: quota.used, limit: quota.limit, remaining: quota.remaining,
            resetAt: new Date(quota.resetAt).toISOString(), tier: quota.tier, policyVersion: quota.policyVersion}});
      }
      throw Object.assign(new Error(code), rejection);
    }
    return result;
  }
  function snapshot() {
    if (!session || session.expiresAt <= now()) { session = null; return null; }
    const { credential: _credential, ...publicState } = session; return { ...publicState, generation, scopes: [...publicState.scopes] };
  }
  async function call(path, input, { method = 'POST', authenticated = true, signal, accountId } = {}) {
    if (!/^\/(v[12]\/|\.well-known\/)/.test(path) || path.includes('?') && !allowedReadQuery(path, method) || path.includes('#')) throw new Error('Invalid API path.');
    const current = session, lease = generation;
    if (authenticated && !snapshot()) throw Object.assign(new Error('connection_required'), { code: 'connection_required' });
    const result = await send(endpoint + path, { bodyJson: method === 'GET' ? undefined : JSON.stringify(input), method, signal,
      credential: authenticated ? current.credential : undefined, accountId: authenticated ? accountId : undefined });
    if (lease !== generation || authenticated && (session !== current || !snapshot())) throw new Error('Authorization changed during request.');
    return result;
  }
  /** @param {any} input @param {{confirmed?:boolean,binding?:{bindingId:string,receipt:string}|null}} [options] */
  async function connect(input, { confirmed = false, binding: originalBinding = null } = {}) {
    if (!confirmed || closed || connectionController) throw new Error('Confirm one connection at a time.');
    // Immutable public request: private keys and recovery material never enter it.
    const request = structuredClone(input);
    if (Object.keys(request).sort().join(',') !== 'control,genesisProof,installationId,scopes,subjectId'
      || !/^GUID[0-9A-Z]{28}$/.test(request.subjectId) || !request.scopes?.includes('binding')
      || request.scopes.some(scope => !browserScopes.includes(scope)) || new Set(request.scopes).size !== request.scopes.length
      || /PRIVATE KEY|galaxy-recovery-v1:/.test(JSON.stringify(request))) throw new Error('Invalid public connection request.');
    const controller = new AbortController(); connectionController = controller;
    const lease = generation, started = now(), check = () => {
      controller.signal.throwIfAborted();
      if (lease !== generation || closed || now() < started || now() >= started + 300) throw new Error('Connection no longer current.');
    };
    const post = async (path, body) => { check(); const result = await send(endpoint + path, { bodyJson: JSON.stringify(body), signal: controller.signal }); check(); return result; };
    const context = () => ({ endpoint, trustedKeys, now: now() });
    async function verifyCurrent(verify,document,extra){
      const inspect=()=>verify(document,{...context(),...extra});
      try{return await inspect();}catch(error){
        const notBefore=error?.payload?.nbf,ahead=notBefore-now();
        if(error?.code!=='ERR_JWT_CLAIM_VALIDATION_FAILED'||error.claim!=='nbf'
          ||!Number.isSafeInteger(notBefore)||ahead>2||ahead < -2)throw error;
        // A subsecond clock difference can cross the JWT integer-second boundary.
        // Wait at most two seconds, then verify the same bytes at actual current
        // time. Expiry, signature, issuer and key validity checks stay unchanged.
        await waitForClock(Math.max(0,ahead*1000)+25,controller.signal);check();
        return inspect();
      }
    }
    try {
      let bound, binding, challenge;
      if (originalBinding) {
        bound = JSON.parse(JSON.stringify(originalBinding));
        binding = await verifyCurrent(verifyExistingBindingReceipt,bound,{request});
      } else {
        const response = await post('/v2/binding-challenges', request);
        challenge = await verifyCurrent(verifyBindingChallenge,response,{request});
        const signature = await sign(challenge.challenge, 'galaxy-binding-response+jws'); check();
        await verifyCurrent(verifyBindingChallenge,response,{request});
        bound = await post('/v1/bindings', { challenge: challenge.challenge, clientSession: challenge.clientSession, signature });
        binding = await verifyCurrent(verifyBindingReceipt,bound,{challenge});
      }
      const credential = base64url(crypto.getRandomValues(new Uint8Array(32))), credentialHash = await sha256Hex(credential, crypto);
      const sessionResponse = await post('/v1/session-challenges', { bindingId: bound.bindingId, credentialHash });
      const sessionChallenge = await verifyCurrent(verifySessionChallenge,sessionResponse,{binding,credentialHash});
      const sessionSignature = await sign(sessionChallenge.challenge, 'galaxy-session-response+jws'); check();
      await verifyCurrent(verifySessionChallenge,sessionResponse,{binding,credentialHash});
      const activation = await post('/v1/sessions', { challenge: sessionChallenge.challenge, signature: sessionSignature });
      const active = verifySessionActivation(activation, { challenge: sessionChallenge, now: now() });
      if (originalBinding) await verifyCurrent(verifyExistingBindingReceipt,bound,{request});
      else await verifyCurrent(verifyBindingReceipt,bound,{challenge});
      check();
      session = { ...active, subjectId: request.subjectId, endpoint, control: request.control, credential };
      establishedBinding = bound;
      // A completed connection installs a new lease even if its public owner
      // and binding happen to match. Failed connects never install a lease.
      generation++;
      return snapshot();
    } finally { if (connectionController === controller) connectionController = null; }
  }
  async function attachmentTransfer(path,{bytes,signal}={}){
    const target=/^\/v2\/chat\/attachments\/[0-9a-f-]{36}\/(upload|content|export-content)$/.exec(path);
    if(!target||closed)throw new Error('Invalid attachment API path.');
    const upload=target[1]==='upload',current=session,lease=generation;
    if(!snapshot())throw Object.assign(new Error('connection_required'),{code:'connection_required'});
    if(upload&&(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>67108864)||!upload&&bytes!==undefined)throw new Error('Invalid attachment bytes.');
    const deadline=AbortSignal.timeout(70000),operationSignal=signal?AbortSignal.any([signal,deadline]):deadline;
    const response=await fetcher(endpoint+path,{method:upload?'PUT':'POST',body:upload?bytes:JSON.stringify({}),signal:operationSignal,
      redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',
      headers:{Accept:upload?'application/json':'application/octet-stream','Content-Type':upload?'application/octet-stream':'application/json',Authorization:`Bearer ${current.credential}`}});
    const check=()=>{if(lease!==generation||session!==current||!snapshot())throw new Error('Authorization changed during request.');};
    check();const max=upload||!response.ok?1048576:67108864;
    if(Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw new Error('Attachment response too large.');}
    const chunks=[];let length=0;const reader=response.body?.getReader();
    if(!reader)throw new Error('Attachment response missing.');
    try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>max)throw new Error('Attachment response too large.');chunks.push(part.value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    const content=new Uint8Array(length);let offset=0;for(const chunk of chunks){content.set(chunk,offset);offset+=chunk.length;}
    check();
    if(upload||!response.ok){let result;try{result=JSON.parse(new TextDecoder().decode(content));}catch{throw new Error('Invalid attachment receipt.');}
      if(!response.ok){const code=typeof result?.error==='string'&&/^[a-z0-9_:-]{1,100}$/.test(result.error)?result.error:'request_failed';throw Object.assign(new Error(code),{code,status:response.status});}return result;}
    const sha256=response.headers.get('x-galaxy-content-sha256');
    const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',content)),b=>b.toString(16).padStart(2,'0')).join('');
    if(!/^[a-f0-9]{64}$/.test(sha256??'')||actual!==sha256)throw new Error('Attachment download integrity failed.');
    check();return {bytes:content,sha256};
  }
  async function prepareAuthorization(payload, { action, objectId, visibility = 'Private', viewers = [], expiresAt = now() + 2591900, id = crypto.randomUUID(), confirmed = false } = {}) {
    if (!confirmed || !snapshot()) throw new Error('Explicit action and current connection required.');
    const current = session, payloadJson = typeof payload === 'string' ? payload : JSON.stringify(payload), parsed = JSON.parse(payloadJson);
    const intent = consentSchema.parse({ version: 1, id, subjectId: current.subjectId, bindingId: current.bindingId, endpoint, objectId,
      action, purpose: visibility === 'Public' ? 'public-profile' : 'operational', recipient: endpoint, fields: Object.keys(parsed), visibility, viewers,
      payloadHash: await sha256Hex(payloadJson, crypto), policyVersion: '0.1', issuedAt: now(), expiresAt });
    assertConsentPolicy(intent, { actor: current, endpoint, now: now() });
    const signedIntent = await sign(JSON.stringify(intent), 'galaxy-consent+jws');
    if (current !== session || !snapshot()) throw new Error('Authorization changed.');
    // The caller must durably store this exact record before submitting it.
    // No Consent write occurs while preparing or signing on this device.
    return { version: 1, endpoint, intent, signedIntent, payloadJson };
  }
  async function checkAuthorization(prepared) {
    const current = snapshot();
    if (!current || !prepared || prepared.version !== 1 || prepared.endpoint !== endpoint
      || prepared.intent?.subjectId !== current.subjectId || typeof prepared.signedIntent !== 'string'
      || typeof prepared.payloadJson !== 'string') throw new Error('Saved authorization does not belong to the current identity.');
    const intent = consentSchema.parse(prepared.intent);
    if (intent.endpoint !== endpoint || await sha256Hex(prepared.payloadJson, crypto) !== intent.payloadHash) throw new Error('Saved authorization payload changed.');
    try {
      const parts = prepared.signedIntent.split('.');
      const decode = text => new TextDecoder().decode(Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)));
      if (parts.length !== 3 || !equalJson(JSON.parse(decode(parts[0])), { alg: 'Ed25519', typ: 'galaxy-consent+jws' })
        || !equalJson(JSON.parse(decode(parts[1])), intent)) throw new Error();
    } catch { throw new Error('Saved authorization signature envelope changed.'); }
    return intent;
  }
  function acceptedAuthorization(accepted, prepared) {
    if (accepted?.consentId !== prepared.intent.id || accepted.status !== 'active' || !equalJson(accepted.intent, prepared.intent))
      throw Object.assign(new Error('consent_receipt_not_active_or_mismatched'), { code: 'consent_receipt_not_active_or_mismatched' });
    return { consentId: prepared.intent.id, payloadJson: prepared.payloadJson };
  }
  async function reconcileAuthorization(prepared) {
    await checkAuthorization(prepared);
    const receipt = await call('/v2/consents/receipt', { consentId: prepared.intent.id });
    if (receipt?.state === 'absent' && receipt.consentId === prepared.intent.id) return { state: 'absent', consentId: prepared.intent.id };
    if (receipt.signatureHash !== await sha256Hex(prepared.signedIntent, crypto)) throw new Error('Consent signature receipt mismatch.');
    return { state: 'acknowledged', ...acceptedAuthorization(receipt, prepared) };
  }
  async function submitAuthorization(prepared, { confirmed = false, reconcile = false } = {}) {
    if (!confirmed) throw new Error('Confirm submission of the saved authorization.');
    const intent = await checkAuthorization(prepared);
    if (reconcile || intent.bindingId !== snapshot()?.bindingId || intent.issuedAt < now() - 300) {
      const receipt = await reconcileAuthorization(prepared);
      if (receipt.state === 'acknowledged') return { consentId: receipt.consentId, payloadJson: receipt.payloadJson };
    }
    if (intent.bindingId !== snapshot()?.bindingId || intent.issuedAt < now() - 300 || intent.expiresAt <= now())
      throw Object.assign(new Error('consent_reauthorization_required'), { code: 'consent_reauthorization_required', consentId: intent.id });
    return acceptedAuthorization(await call('/v1/consents', { signedIntent: prepared.signedIntent }), prepared);
  }
  async function authorizePayload(payload, options = {}) {
    return submitAuthorization(await prepareAuthorization(payload, options), { confirmed: options.confirmed === true });
  }
  function disconnect() { generation++; connectionController?.abort(); connectionController = null; session = null; }
  return Object.freeze({ endpoint, send, call, attachmentTransfer, connect, snapshot, bindingRecord:()=>establishedBinding?JSON.parse(JSON.stringify(establishedBinding)):null, authorizePayload, prepareAuthorization, submitAuthorization, reconcileAuthorization, disconnect,
    close() { disconnect(); closed = true; } });
}
