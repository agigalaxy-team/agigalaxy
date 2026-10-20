import {randomBytes, randomUUID, createHash, timingSafeEqual} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createOidcLoginProvider} from './oidc-login.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {OfficialAccountData} from './official-account-data.mjs';

const opaque = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const unavailable = () => new ServiceError('official_account_unavailable', 503);
const callbackPath = '/v1/account/callback';
const sessionName = '__Host-galaxy-account';
const loginName = '__Host-galaxy-account-login';
function origin(value, allowLoopbackHttp = false) {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname)))
    throw Error('Exact secure account origin required.');
  return value;
}
function cookieValue(request, name) {
  const values = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function sameSecret(a, b) {
  return typeof a === 'string' && typeof b === 'string' && /^[A-Za-z0-9_-]{43}$/.test(a) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Official account login is independent of Galaxy identity/device authority.
// OIDC tokens never leave the server. Account actions use their own current
// account session; a login never grants control of an associated Galaxy ID.
export function createOfficialAccountPortal({provider, db, endpoint, websiteOrigin, associationProviders = [],
  now = () => Math.floor(Date.now() / 1000), allowLoopbackHttp = false}) {
  origin(endpoint, allowLoopbackHttp); origin(websiteOrigin, allowLoopbackHttp);
  const description = provider.describe();
  if (description.redirectUri !== endpoint + callbackPath) throw Error('Account callback mismatch.');
  const clients = associationProviders.map(value => value.describe()).filter(value => value.issuer === description.issuer).map(value => value.clientId);
  if (!clients.length) throw Error('Official account association provider required.');
  const pending = new Map(), sessions = new Map();
  const data = new OfficialAccountData({db,endpoint,now});
  const secure = new URL(endpoint).protocol === 'https:';
  // __Host cookies are mandatory in production. Literal-loopback HTTP fixtures
  // use separate names because browsers correctly reject insecure __Host cookies.
  const sessionCookie = secure ? sessionName : 'galaxy-account-fixture';
  const loginCookie = secure ? loginName : 'galaxy-account-login-fixture';
  const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${age}`;
  function purge() {
    for (const [key, value] of pending) if (value.expiresAt <= now()) {provider.cancel(value.preview); pending.delete(key);}
    for (const [key, value] of sessions) if (value.expiresAt <= now()) sessions.delete(key);
  }
  function returnTarget(value) {
    if (value === null || value === undefined) return websiteOrigin + '/app/account';
    if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/app/') || /[\\\p{Cc}]/u.test(value)) throw new ServiceError('invalid_account_return');
    let decoded;
    try {decoded = decodeURIComponent(value);} catch {throw new ServiceError('invalid_account_return');}
    if (/[\\\p{Cc}]/u.test(decoded)) throw new ServiceError('invalid_account_return');
    const target = new URL(value, websiteOrigin);
    if (target.origin !== websiteOrigin || !target.pathname.startsWith('/app/')) throw new ServiceError('invalid_account_return');
    return target.href;
  }
  function readSession(request) {
    purge(); const value = cookieValue(request, sessionCookie);
    return value ? sessions.get(hash(value)) ?? null : null;
  }
  const signedOut = () => ({state:'signed-out', galaxyAuthorization:false});
  return Object.freeze({
    data,
    configurationHash:hash(JSON.stringify({endpoint,websiteOrigin,issuer:description.issuer,clientId:description.clientId,associationClients:[...clients].sort((a,b)=>a<b?-1:a>b?1:0)})),
    async login(request, response, url) {
      if ([...url.searchParams.keys()].some(key => !['mode','returnTo'].includes(key)) || ['mode','returnTo'].some(key => url.searchParams.getAll(key).length > 1)) throw new ServiceError('invalid_account_login');
      const mode = url.searchParams.get('mode') ?? 'login';
      if (!['login','register'].includes(mode)) throw new ServiceError('invalid_account_login');
      const returnTo = returnTarget(url.searchParams.get('returnTo'));
      purge();
      if (pending.size >= 2048 || sessions.size >= 10000) throw unavailable();
      const previous = cookieValue(request, loginCookie);
      if (previous) {const old = pending.get(hash(previous)); if (old) provider.cancel(old.preview); pending.delete(hash(previous));}
      let preview;
      try {preview = await provider.begin();} catch {throw unavailable();}
      if (pending.size >= 2048) {provider.cancel(preview); throw unavailable();}
      let authorization = preview.authorizationUrl;
      if (mode === 'register') {
        const target = new URL(authorization), authority = new URL(description.issuer);
        if (target.origin !== authority.origin || target.pathname !== authority.pathname.replace(/\/$/, '') + '/protocol/openid-connect/auth') {provider.cancel(preview); throw unavailable();}
        target.pathname = target.pathname.replace(/\/auth$/, '/registrations'); authorization = target.href;
      }
      const value = opaque();
      pending.set(hash(value), {preview, returnTo, expiresAt:preview.expiresAt});
      response.setHeader('Set-Cookie', cookie(loginCookie, value, 300));
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.statusCode = 303; response.setHeader('Location', authorization); response.end();
    },
    async callback(request, response, url) {
      purge(); const value = cookieValue(request, loginCookie), key = value ? hash(value) : null;
      const record = key ? pending.get(key) : null;
      // An old tab must not consume the newer login held by this browser.
      // Only a callback for this exact preview may clear/cancel its transaction.
      const expectedState=record?new URL(record.preview.authorizationUrl).searchParams.get('state'):null;
      if(!record||url.searchParams.getAll('state').length!==1||url.searchParams.get('state')!==expectedState){
        response.setHeader('Referrer-Policy','no-referrer');response.setHeader('Cache-Control','no-store');
        response.statusCode=303;response.setHeader('Location',websiteOrigin+'/app/account?accountLogin=stale');response.end();return;
      }
      pending.delete(key);
      const cookies = [cookie(loginCookie, '', 0)];
      let target = record?.returnTo ?? websiteOrigin + '/app/account';
      try {
        if (!record || record.expiresAt <= now()) throw Error();
        const account = await provider.complete(record.preview, url.href);
        if (account.issuer !== description.issuer || account.clientId !== description.clientId || account.expiresAt <= now() || typeof account.externalSubject !== 'string') throw Error();
        if (sessions.size >= 10000) throw Error();
        const newId = randomUUID();
        const accountRow = (await db.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(endpoint,issuer,external_subject)
          DO UPDATE SET verified_at=EXCLUDED.verified_at,verification_method=EXCLUDED.verification_method RETURNING id`,
        [newId, endpoint, account.issuer, account.externalSubject,
          account.accountVerification?.verified === true ? 'email' : 'external-account', new Date(now()*1000).toISOString()])).rows[0];
        if (!accountRow?.id) throw unavailable();
        await data.ensureWithin(db,accountRow.id,{subjectType:accountRow.id===newId?'person':null,displayName:account.accountProfile?.displayName??null});
        const prior = cookieValue(request, sessionCookie); if (prior) sessions.delete(hash(prior));
        const token = opaque();
        sessions.set(hash(token), {accountId:accountRow.id, issuer:account.issuer, externalSubject:account.externalSubject,
          account:{id:accountRow.id, displayName:account.accountProfile?.displayName ?? null, email:account.accountProfile?.email ?? null, emailVerified:account.accountVerification?.verified === true},
          csrfToken:opaque(), expiresAt:now() + 3600});
        cookies.push(cookie(sessionCookie, token, 3600));
      } catch {
        const failure = new URL(target); failure.searchParams.set('accountLogin',url.searchParams.get('error')==='access_denied'?'cancelled':'failed'); target = failure.href;
      } finally {if (record) provider.cancel(record.preview);}
      response.setHeader('Set-Cookie', cookies); response.setHeader('Referrer-Policy','no-referrer');
      response.statusCode = 303; response.setHeader('Location', target); response.end();
    },
    async session(request, url) {
      if ([...url.searchParams.keys()].some(key => key !== 'after') || url.searchParams.getAll('after').length > 1) throw new ServiceError('invalid_account_query');
      const after = url.searchParams.get('after');
      if (after && !/^GUID[0-9A-Z]{28}$/.test(after)) throw new ServiceError('invalid_account_query');
      const session = readSession(request); if (!session) return signedOut();
      const rows = (await db.query(`SELECT l.subject_id,MIN(l.created_at) AS linked_at FROM external_identity_links l
        JOIN community_account_links g ON g.identity_link_id=l.id JOIN community_accounts a ON a.id=g.account_id
        WHERE a.endpoint=$1 AND a.issuer=$2 AND a.external_subject=$3 AND l.endpoint=$1 AND l.issuer=$2 AND l.external_subject=$3
        AND l.client_id=ANY($4::text[]) AND l.revoked_at IS NULL AND ($5::text IS NULL OR l.subject_id>$5)
        GROUP BY l.subject_id ORDER BY l.subject_id LIMIT 101`, [endpoint, session.issuer, session.externalSubject, clients, after ?? null])).rows;
      const linkedIds = rows.slice(0,100).map(row => ({subjectId:row.subject_id, linkedAt:new Date(row.linked_at).toISOString()}));
      const profile=(await db.query('SELECT display_name FROM official_account_profiles_v1 WHERE account_id=$1',[session.accountId])).rows[0];
      return {state:'signed-in', account:{...session.account,displayName:profile?profile.display_name:session.account.displayName}, linkedIds, nextAfter:rows.length > 100 ? linkedIds.at(-1).subjectId : null,
        expiresAt:session.expiresAt, csrfToken:session.csrfToken, galaxyAuthorization:false};
    },
    async actionActor(request, {write = request.method !== 'GET'} = {}) {
      if(request.headers.authorization!==undefined)throw new ServiceError('access_denied',401);
      const session = readSession(request);
      if (!session) throw new ServiceError('official_account_login_required',401);
      const sameOriginRead=!write&&request.method==='GET'&&request.headers.origin===undefined
        &&endpoint===websiteOrigin&&request.headers['sec-fetch-site']==='same-origin'
        &&request.headers.host===new URL(endpoint).host;
      if (request.headers.origin !== websiteOrigin&&!sameOriginRead) throw new ServiceError('account_csrf_invalid',403);
      // Bind drafts and in-flight requests to the account the user actually saw.
      // Another tab changing the ambient cookie must not redirect an old action.
      if (request.headers['x-galaxy-account-id'] !== session.accountId)
        throw new ServiceError('official_account_changed',409);
      if (write && !sameSecret(request.headers['x-galaxy-account-csrf'],session.csrfToken))
        throw new ServiceError('account_csrf_invalid',403);
      return {kind:'official-account',accountId:session.accountId,endpoint};
    },
    logout(request, response) {
      const session = readSession(request);
      if (request.headers.origin !== websiteOrigin || !session || !sameSecret(request.headers['x-galaxy-account-csrf'], session.csrfToken)) throw new ServiceError('account_csrf_invalid',403);
      const value = cookieValue(request, sessionCookie); if (value) sessions.delete(hash(value));
      response.setHeader('Set-Cookie', cookie(sessionCookie, '', 0)); return signedOut();
    },
  });
}

export async function loadOfficialAccountPortal(path, {endpoint, db, browserOrigins, identityProviders, factory = createOidcLoginProvider}) {
  if (!path) return null;
  if (!isAbsolute(path)) throw Error('Absolute official account configuration required.');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw Error('Invalid official account configuration.');
  const value = JSON.parse(await readFile(path,'utf8'));
  if (value.version !== 1 || Object.keys(value).sort().join(',') !== 'clientId,issuer,version,websiteOrigin' || !/^[a-z0-9][a-z0-9._-]{0,199}$/.test(value.clientId ?? '') || !browserOrigins.includes(value.websiteOrigin)) throw Error('Invalid official account configuration.');
  origin(value.websiteOrigin); const issuer = new URL(value.issuer);
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash || issuer.href !== value.issuer) throw Error('Invalid official account issuer.');
  const provider = await factory({id:'official-account-entry',name:'银河官方账户',issuer:value.issuer,clientId:value.clientId,redirectUri:endpoint + callbackPath,includeAccountProfile:true});
  return createOfficialAccountPortal({provider,db,endpoint,websiteOrigin:value.websiteOrigin,associationProviders:identityProviders});
}
