import {randomBytes, createHash, timingSafeEqual} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createOidcLoginProvider} from "../identity/authentication/oidc-login.mjs";
import {ServiceError} from "../shared/service-error.mjs";
import {OfficialAccountData} from "./data.mjs";
import {upsertOfficialAccountWithin} from "./uid.mjs";
import {createOidcTransactionStore} from "../identity/authentication/oidc-transaction-store.mjs";
import {PortalSessions,loadPortalSessionPolicy} from '../identity/authentication/portal-session.mjs';
import {OfficialAccountSessionStore} from "./session-store.mjs";

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
  sessionRenewal=null, now = () => Math.floor(Date.now() / 1000), allowLoopbackHttp = false}) {
  origin(endpoint, allowLoopbackHttp); origin(websiteOrigin, allowLoopbackHttp);
  const description = provider.describe();
  if (description.redirectUri !== endpoint + callbackPath) throw Error('Account callback mismatch.');
  const clients = associationProviders.map(value => value.describe()).filter(value => value.issuer === description.issuer).map(value => value.clientId);
  if (!clients.length) throw Error('Official account association provider required.');
  const configurationHash=hash(JSON.stringify({endpoint,websiteOrigin,issuer:description.issuer,clientId:description.clientId,associationClients:[...clients].sort((a,b)=>a<b?-1:a>b?1:0)}));
  const sessions=new OfficialAccountSessionStore({db,scope:configurationHash,now});
  // Rebind only this portal's relying-party operations. Association providers
  // keep their independent transactions and Galaxy signature requirements.
  if(typeof provider.withTransactionStore==='function')provider=provider.withTransactionStore(
    createOidcTransactionStore({db,namespace:'official-account:'+configurationHash,now}));
  const renewal=sessionRenewal?new PortalSessions({db,kind:'account',scope:[configurationHash],policy:sessionRenewal,provider,now}):null;
  const data = new OfficialAccountData({db,endpoint,now});
  const secure = new URL(endpoint).protocol === 'https:';
  // __Host cookies are mandatory in production. Literal-loopback HTTP fixtures
  // use separate names because browsers correctly reject insecure __Host cookies.
  const sessionCookie = secure ? sessionName : 'galaxy-account-fixture';
  const loginCookie = secure ? loginName : 'galaxy-account-login-fixture';
  const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${age}`;
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
  async function readSession(request,{renew=true}={}) {
    const value = cookieValue(request, sessionCookie);
    const session=value?await sessions.session(hash(value)):null;
    if(!session||!renew)return session;
    if(!renewal)return session.renewalRow.refresh_cipher?null:session;
    const activityOrigin=request.headers.origin===websiteOrigin||request.method==='GET'&&request.headers.origin===undefined
      &&endpoint===websiteOrigin&&request.headers['sec-fetch-site']==='same-origin'&&request.headers.host===new URL(endpoint).host;
    const verifiedActivity=request.headers['x-galaxy-user-activity']==='1'&&activityOrigin
      &&sameSecret(request.headers['x-galaxy-account-csrf'],session.csrfToken);
    const live=await renewal.current(session.renewalRow,{activity:verifiedActivity});
    return live===null?null:live?{...session,expiresAt:live.expiresAt}:session;
  }
  const signedOut = () => ({state:'signed-out', galaxyAuthorization:false});
  return Object.freeze({
    data,
    configurationHash,
    identityIssuer:description.issuer,
    async login(request, response, url) {
      if ([...url.searchParams.keys()].some(key => !['mode','returnTo'].includes(key)) || ['mode','returnTo'].some(key => url.searchParams.getAll(key).length > 1)) throw new ServiceError('invalid_account_login');
      const mode = url.searchParams.get('mode') ?? 'login';
      if (!['login','register'].includes(mode)) throw new ServiceError('invalid_account_login');
      const returnTo = returnTarget(url.searchParams.get('returnTo'));
      const previous = cookieValue(request, loginCookie);
      let preview;
      try {preview = await provider.begin();} catch {throw unavailable();}
      let authorization = preview.authorizationUrl;
      if (mode === 'register') {
        const target = new URL(authorization), authority = new URL(description.issuer);
        if (target.origin !== authority.origin || target.pathname !== authority.pathname.replace(/\/$/, '') + '/protocol/openid-connect/auth') {await provider.cancel(preview); throw unavailable();}
        target.pathname = target.pathname.replace(/\/auth$/, '/registrations'); authorization = target.href;
      }
      const value = opaque();
      try {
        const observedSession=cookieValue(request,sessionCookie);
        const old=await sessions.createLogin({loginHash:hash(value),preview,returnTo,previousLoginHash:previous?hash(previous):null,
          observedSessionHash:observedSession?hash(observedSession):null});
        if(old)await provider.cancel(old);
      } catch {
        await provider.cancel(preview);throw unavailable();
      }
      response.setHeader('Set-Cookie', cookie(loginCookie, value, 300));
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Cache-Control','no-store');
      response.statusCode = 303; response.setHeader('Location', authorization); response.end();
    },
    async callback(request, response, url) {
      const value = cookieValue(request, loginCookie), key = value ? hash(value) : null;
      // An old tab must not consume the newer login held by this browser.
      // Only a callback for this exact preview may clear/cancel its transaction.
      const record=key&&url.searchParams.getAll('state').length===1?await sessions.claimLogin(key,url.searchParams.get('state')):null;
      if(!record){
        response.setHeader('Referrer-Policy','no-referrer');response.setHeader('Cache-Control','no-store');
        response.statusCode=303;response.setHeader('Location',websiteOrigin+'/app/account?accountLogin=stale');response.end();return;
      }
      // The short login cookie keeps its original five-minute expiry. Clearing
      // it here could overwrite a newer login that began while this callback
      // was in flight; consumed server state already makes this value unusable.
      const cookies = [];
      let target = record?.returnTo ?? websiteOrigin + '/app/account';
      try {
        if (!record || record.expiresAt <= now()) throw Error();
        const account = await provider.complete(record.preview, url.href);
        if (account.issuer !== description.issuer || account.clientId !== description.clientId || account.expiresAt <= now() || typeof account.externalSubject !== 'string') throw Error();
        const prior = cookieValue(request, sessionCookie),token = opaque();
        await sessions.completeLogin(key,{tokenHash:hash(token),priorSessionHash:prior?hash(prior):null},async connection=>{
          const accountRow=await upsertOfficialAccountWithin(connection,{endpoint,issuer:account.issuer,externalSubject:account.externalSubject,
            verificationMethod:account.accountVerification?.verified===true?'email':'external-account',verifiedAt:now()});
          const profile=await data.ensureWithin(connection,accountRow.id,{subjectType:accountRow.created?'person':null});
          return {accountId:accountRow.id,issuer:account.issuer,externalSubject:account.externalSubject,
            account:{id:accountRow.id,uid:accountRow.uid,displayName:profile.display_name,avatarKey:profile.avatar_key??null,subjectType:profile.subject_type??null,email:account.accountProfile?.email??null,emailVerified:account.accountVerification?.verified===true},
            csrfToken:opaque(),expiresAt:now()+(renewal&&account.portalTokens?.refreshToken?renewal.policy.maximumSeconds:3600),
            ...(renewal&&account.portalTokens?.refreshToken?{installRenewal:connection=>renewal.create(connection,hash(token),account)}:{})};
        });
        cookies.push(cookie(sessionCookie, token, renewal&&account.portalTokens?.refreshToken?renewal.policy.maximumSeconds:3600));
      } catch {
        await sessions.failLogin(key);
        const failure = new URL(target); failure.searchParams.set('accountLogin',url.searchParams.get('error')==='access_denied'?'cancelled':'failed'); target = failure.href;
      } finally {await provider.cancel(record.preview);}
      if(cookies.length)response.setHeader('Set-Cookie', cookies);
      response.setHeader('Referrer-Policy','no-referrer');response.setHeader('Cache-Control','no-store');
      response.statusCode = 303; response.setHeader('Location', target); response.end();
    },
    async session(request, url) {
      if ([...url.searchParams.keys()].some(key => key !== 'after') || url.searchParams.getAll('after').length > 1) throw new ServiceError('invalid_account_query');
      const after = url.searchParams.get('after');
      if (after && !/^GUID[0-9A-Z]{28}$/.test(after)) throw new ServiceError('invalid_account_query');
      const session = await readSession(request); if (!session) return signedOut();
      const rows = (await db.query(`SELECT l.subject_id,MIN(l.created_at) AS linked_at FROM external_identity_links l
        JOIN community_account_links g ON g.identity_link_id=l.id JOIN community_accounts a ON a.id=g.account_id
        WHERE a.endpoint=$1 AND a.issuer=$2 AND a.external_subject=$3 AND l.endpoint=$1 AND l.issuer=$2 AND l.external_subject=$3
        AND l.client_id=ANY($4::text[]) AND l.revoked_at IS NULL AND ($5::text IS NULL OR l.subject_id>$5)
        GROUP BY l.subject_id ORDER BY l.subject_id LIMIT 101`, [endpoint, session.issuer, session.externalSubject, clients, after ?? null])).rows;
      const linkedIds = rows.slice(0,100).map(row => ({subjectId:row.subject_id, linkedAt:new Date(row.linked_at).toISOString()}));
      const profile=await data.ensureWithin(db,session.accountId);
      return {state:'signed-in', account:{...session.account,uid:profile.uid,displayName:profile.display_name,avatarKey:profile.avatar_key??null,subjectType:profile.subject_type??null}, linkedIds, nextAfter:rows.length > 100 ? linkedIds.at(-1).subjectId : null,
        expiresAt:session.expiresAt, csrfToken:session.csrfToken, galaxyAuthorization:false};
    },
    async actionActor(request, {write = request.method !== 'GET'} = {}) {
      if(request.headers.authorization!==undefined)throw new ServiceError('access_denied',401);
      const session = await readSession(request);
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
    async currentSession(request) {
      const session=await readSession(request);
      return session?{accountId:session.accountId,issuer:session.issuer,externalSubject:session.externalSubject,expiresAt:session.expiresAt}:null;
    },
    async sessionSummary({issuer,externalSubject}) {
      if(issuer!==description.issuer||typeof externalSubject!=='string'||!externalSubject.length||externalSubject.length>255||/[\p{Cc}]/u.test(externalSubject))
        throw new ServiceError('invalid_account');
      return sessions.sessionSummary({issuer,externalSubject});
    },
    async revokeSessions({accountId=null,issuer=null,externalSubject=null}) {
      if(accountId!==null&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountId))throw new ServiceError('invalid_account');
      let principal={issuer,externalSubject};
      if(accountId!==null){
        const account=(await db.query('SELECT issuer,external_subject FROM community_accounts WHERE id=$1 AND endpoint=$2',[accountId,endpoint])).rows[0];
        if(!account||issuer!==null&&account.issuer!==issuer||externalSubject!==null&&account.external_subject!==externalSubject)throw new ServiceError('invalid_account');
        principal={issuer:account.issuer,externalSubject:account.external_subject};
      }
      if(principal.issuer!==description.issuer||typeof principal.externalSubject!=='string'||!principal.externalSubject.length||principal.externalSubject.length>255||/[\p{Cc}]/u.test(principal.externalSubject))
        throw new ServiceError('invalid_account');
      return sessions.revokePrincipal(principal);
    },
    async logout(request, response) {
      if(request.headers.authorization!==undefined)throw new ServiceError('access_denied',401);
      const session = await readSession(request,{renew:false});
      if (request.headers.origin !== websiteOrigin || !session || !sameSecret(request.headers['x-galaxy-account-csrf'], session.csrfToken)) throw new ServiceError('account_csrf_invalid',403);
      const value = cookieValue(request, sessionCookie),login=cookieValue(request,loginCookie);
      await sessions.logout(hash(value),login?hash(login):null);
      response.setHeader('Set-Cookie',[cookie(sessionCookie, '', 0),cookie(loginCookie,'',0)]); return signedOut();
    },
  });
}

export async function loadOfficialAccountPortal(path, {endpoint, db, browserOrigins, identityProviders, factory = createOidcLoginProvider}) {
  if (!path) return null;
  if (!isAbsolute(path)) throw Error('Absolute official account configuration required.');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw Error('Invalid official account configuration.');
  const value = JSON.parse(await readFile(path,'utf8'));
  const {sessionRenewal:renewalConfiguration,...core}=value;
  const sessionRenewal=await loadPortalSessionPolicy(renewalConfiguration);
  if (value.version !== 1 || Object.keys(core).sort().join(',') !== 'clientId,issuer,version,websiteOrigin' || !/^[a-z0-9][a-z0-9._-]{0,199}$/.test(value.clientId ?? '') || !browserOrigins.includes(value.websiteOrigin)) throw Error('Invalid official account configuration.');
  origin(value.websiteOrigin); const issuer = new URL(value.issuer);
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash || issuer.href !== value.issuer) throw Error('Invalid official account issuer.');
  const provider = await factory({id:'official-account-entry',name:'银河官方账户',issuer:value.issuer,clientId:value.clientId,redirectUri:endpoint + callbackPath,includeAccountProfile:true,sessionRenewal:!!sessionRenewal});
  return createOfficialAccountPortal({provider,db,endpoint,websiteOrigin:value.websiteOrigin,associationProviders:identityProviders,sessionRenewal});
}
