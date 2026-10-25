import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {rootOperationsRole,managementAdmission,isOperationsRootPrincipal} from './operations-root-principal.mjs';

const opaque = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const validOpaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const equal = (a, b) => validOpaque(a) && validOpaque(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const denied = () => new ServiceError('operations_access_denied', 403);
const unavailable = () => new ServiceError('operations_unavailable', 503);
const signedOut = () => ({state:'signed-out'});
const iso = seconds => new Date(seconds * 1000).toISOString();
function exactOrigin(value, allowLoopbackHttp) {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || url.protocol !== 'https:'
    && !(allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname)))
    throw Error('Exact secure operations origin required.');
  return url;
}
function cookieValue(request, name) {
  const values = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
  return values.length === 1 && validOpaque(values[0].slice(name.length + 1)) ? values[0].slice(name.length + 1) : null;
}

// Operator authentication is separate from public account participation. The
// caller cannot select its operator identity or role in a business request.
export function createOperationsPortal({provider, db, endpoint, adminOrigin, roleDirectory,
  roles = {administrator:'galaxy-operations-administrator', reader:'galaxy-operations-reader'},
  permissions = null, rootPrincipal = null, managementSessions = null,
  now = () => Math.floor(Date.now() / 1000), allowLoopbackHttp = false}) {
  const origin = exactOrigin(adminOrigin, allowLoopbackHttp);
  exactOrigin(endpoint, allowLoopbackHttp);
  const description = provider.describe();
  if (description.redirectUri !== adminOrigin + '/v1/operations/callback' || typeof roleDirectory?.getOperatorRoles !== 'function'
    || !roles || Object.keys(roles).sort().join(',') !== 'administrator,reader'
    || Object.values(roles).some(value => typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))
    || roles.administrator === roles.reader) throw Error('Invalid operations authentication configuration.');
  if(rootPrincipal&&(rootPrincipal.endpoint!==endpoint||rootPrincipal.issuer!==description.issuer))
    throw Error('Root principal must belong to this management portal.');
  if(managementSessions&&['assertActive','assertCallback'].some(name=>typeof managementSessions[name]!=='function'))
    throw Error('Explicit management lifecycle checks required.');
  const configurationId = digest(JSON.stringify({endpoint,adminOrigin,issuer:description.issuer,clientId:description.clientId,roles,
    authority:'preconfigured-root-v1',root:rootPrincipal?{operatorId:rootPrincipal.operatorId,issuer:rootPrincipal.issuer,externalSubject:rootPrincipal.externalSubject}:null}));
  const secure = origin.protocol === 'https:';
  const sessionCookie = secure ? '__Host-galaxy-operator' : 'galaxy-operator-fixture';
  const loginCookie = secure ? '__Host-galaxy-operator-login' : 'galaxy-operator-login-fixture';
  const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${age}`;
  const scope = [endpoint, configurationId];
  const principalFrom = row => ({operatorId:row.operator_id,issuer:row.issuer,externalSubject:row.external_subject});
  const roleFrom = (names,principal) => rootOperationsRole(rootPrincipal,principal,names,roles);
  const operatorView = row => ({id:row.operator_id,displayName:row.display_name,role:row.role,
    admission:row.admission,rootAdministrator:row.rootAdministrator===true});
  function noBearer(request) {if (request.headers.authorization !== undefined) throw denied();}
  function sameOrigin(request, write = false) {
    if (request.headers.origin === adminOrigin) return;
    if (!write && request.method === 'GET' && request.headers.origin === undefined
      && request.headers['sec-fetch-site'] === 'same-origin' && request.headers.host === origin.host) return;
    throw new ServiceError('operations_csrf_invalid', 403);
  }
  function returnTarget(value) {
    if (value === null || value === undefined) return adminOrigin + '/admin';
    if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || /[\\\p{Cc}]/u.test(value)) throw denied();
    let decoded; try {decoded = decodeURIComponent(value);} catch {throw denied();}
    if (/[\\\p{Cc}]/u.test(decoded)) throw denied();
    const target = new URL(value, adminOrigin);
    if (target.origin !== adminOrigin || !/^\/(?:admin(?:\/|$)|preview(?:\/|$))/.test(target.pathname)) throw denied();
    return target.href;
  }
  async function rawSession(request) {
    noBearer(request);
    const value = cookieValue(request, sessionCookie); if (!value) return null;
    const row = (await db.query(`SELECT * FROM operations_operator_sessions_v1
      WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3 AND expires_at>$4`, [...scope,digest(value),iso(now())])).rows[0];
    return row ?? null;
  }
  async function current(request) {
    const row = await rawSession(request); if (!row) return null;
    const principal=principalFrom(row);
    if(row.issuer!==description.issuer||row.operator_id!==digest(row.issuer+'\0'+row.external_subject))throw denied();
    if(managementSessions){
      try{await managementSessions.assertActive(principal);}
      catch(error){
        if(error?.code!=='operations_access_denied')throw unavailable();
        await db.query('DELETE FROM operations_operator_sessions_v1 WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3',[...scope,row.token_hash]);
        return null;
      }
    }
    let currentRoles;
    try {currentRoles = await roleDirectory.getOperatorRoles({issuer:row.issuer,externalSubject:row.external_subject});}
    catch {throw unavailable();}
    const role = Array.isArray(currentRoles) ? roleFrom(currentRoles,principal) : null;
    if (!role) {
      await db.query('DELETE FROM operations_operator_sessions_v1 WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3', [...scope,row.token_hash]);
      return null;
    }
    return {...row,role,admission:managementAdmission(currentRoles,roles),rootAdministrator:isOperationsRootPrincipal(rootPrincipal,principal)};
  }
  return Object.freeze({
    origin:adminOrigin, configurationId,
    async login(request, response, url) {
      noBearer(request);
      if ([...url.searchParams.keys()].some(key => key !== 'returnTo') || url.searchParams.getAll('returnTo').length > 1) throw denied();
      const returnTo = returnTarget(url.searchParams.get('returnTo'));
      const previous = cookieValue(request, loginCookie);
      if (previous) {
        const old = (await db.query("UPDATE operations_operator_logins_v1 SET status='revoked' WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3 RETURNING preview", [...scope,digest(previous)])).rows[0];
        if (old) await provider.cancel(old.preview);
      }
      const preview = await provider.begin(), value = opaque();
      try {
        await transaction(db, async tx => {
          await tx.query('DELETE FROM operations_operator_logins_v1 WHERE endpoint=$1 AND configuration_id=$2 AND expires_at<=$3', [...scope,iso(now())]);
          const count = Number((await tx.query('SELECT count(*) AS count FROM operations_operator_logins_v1 WHERE endpoint=$1 AND configuration_id=$2', scope)).rows[0].count);
          if (count >= 2048) throw unavailable();
          await tx.query(`INSERT INTO operations_operator_logins_v1(endpoint,configuration_id,token_hash,preview,return_to,expires_at)
            VALUES($1,$2,$3,$4,$5,$6)`, [...scope,digest(value),JSON.stringify(preview),returnTo,iso(preview.expiresAt)]);
        });
      } catch {await provider.cancel(preview); throw unavailable();}
      response.setHeader('Set-Cookie', cookie(loginCookie,value,300));
      response.setHeader('Cache-Control','no-store'); response.setHeader('Referrer-Policy','no-referrer');
      response.statusCode=303; response.setHeader('Location',preview.authorizationUrl); response.end();
    },
    async callback(request, response, url) {
      noBearer(request);
      const value = cookieValue(request,loginCookie), key = value ? digest(value) : null;
      const pending = key ? (await db.query('SELECT preview,return_to FROM operations_operator_logins_v1 WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3', [...scope,key])).rows[0] : null;
      const state = pending ? new URL(pending.preview.authorizationUrl).searchParams.get('state') : null;
      if (!pending || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state) {
        response.setHeader('Cache-Control','no-store'); response.setHeader('Referrer-Policy','no-referrer');
        response.statusCode=303; response.setHeader('Location',adminOrigin+'/admin/login?reason=stale'); response.end(); return;
      }
      const record = (await db.query(`UPDATE operations_operator_logins_v1 SET status='exchanging' WHERE endpoint=$1 AND configuration_id=$2
        AND token_hash=$3 AND status='pending' AND expires_at>$4 RETURNING preview,return_to`, [...scope,key,iso(now())])).rows[0];
      const cookies = [];
      let target = adminOrigin + '/admin/login?reason=denied';
      try {
        if (!record) throw denied();
        const returned = new URL(url.pathname+url.search,adminOrigin);
        const principal = await provider.complete(record.preview,returned.href);
        if (principal.issuer !== description.issuer || principal.clientId !== description.clientId || principal.expiresAt <= now()
          || typeof principal.externalSubject !== 'string' || !principal.externalSubject || !Array.isArray(principal.operatorRoles)
          || !managementAdmission(principal.operatorRoles,roles)) throw denied();
        const operatorId = digest(principal.issuer + '\0' + principal.externalSubject);
        const identity={operatorId,issuer:principal.issuer,externalSubject:principal.externalSubject};
        const role = roleFrom(await roleDirectory.getOperatorRoles(identity),identity);
        if (!role) throw denied();
        const token = opaque(), csrf = opaque(), prior = cookieValue(request,sessionCookie);
        const displayName = principal.accountProfile?.displayName?.trim().slice(0,200) || '管理人员';
        await transaction(db, async tx => {
          if(managementSessions)await managementSessions.assertCallback(identity,{db:tx,configurationId,tokenHash:key});
          else{
            const live=(await tx.query(`SELECT status FROM operations_operator_logins_v1 WHERE endpoint=$1 AND configuration_id=$2
              AND token_hash=$3 AND expires_at>$4 FOR UPDATE`,[...scope,key,iso(now())])).rows[0];
            if(live?.status!=='exchanging')throw denied();
          }
          await tx.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(operator_id) DO UPDATE SET display_name=EXCLUDED.display_name,updated_at=EXCLUDED.updated_at`,
          [operatorId,endpoint,principal.issuer,principal.externalSubject,displayName,iso(now())]);
          if (prior) await tx.query('DELETE FROM operations_operator_sessions_v1 WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3', [...scope,digest(prior)]);
          await tx.query('DELETE FROM operations_operator_sessions_v1 WHERE endpoint=$1 AND configuration_id=$2 AND expires_at<=$3', [...scope,iso(now())]);
          await tx.query(`INSERT INTO operations_operator_sessions_v1(endpoint,configuration_id,token_hash,operator_id,issuer,external_subject,display_name,role,csrf_token,expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [...scope,digest(token),operatorId,principal.issuer,principal.externalSubject,displayName,role,csrf,iso(now()+3600)]);
          await tx.query("UPDATE operations_operator_logins_v1 SET status='completed' WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3",[...scope,key]);
        });
        cookies.push(cookie(sessionCookie,token,3600)); target=record.return_to;
      } catch { /* No token, callback URL, account profile or provider error is logged. */ }
      finally {if (record) await provider.cancel(record.preview);}
      // Do not clear an old login cookie after an asynchronous exchange: a
      // newer login may already have replaced it in this browser.
      if(cookies.length)response.setHeader('Set-Cookie',cookies);
      response.setHeader('Cache-Control','no-store'); response.setHeader('Referrer-Policy','no-referrer');
      response.statusCode=303; response.setHeader('Location',target); response.end();
    },
    async session(request) {
      sameOrigin(request);
      const row = await current(request); if (!row) return signedOut();
      const authority=permissions?await permissions.effective({kind:'business-operator',operatorId:row.operator_id,role:row.role,endpoint}):null;
      const operator={...operatorView(row),...(authority?{role:authority.role,businessAuthorization:{version:authority.version,permissions:authority.permissions}}:{})};
      return {state:'signed-in',operator,csrfToken:row.csrf_token,expiresAt:Math.floor(new Date(row.expires_at).getTime()/1000)};
    },
    async authorizeOperator(request,{write=request.method!=='GET',csrf=false,requestId,action}={}) {
      sameOrigin(request,write||csrf);
      const row = await current(request); if (!row) throw new ServiceError('operations_login_required',401);
      if ((write||csrf) && !equal(request.headers['x-galaxy-operator-csrf'],row.csrf_token)) throw denied();
      const actor={kind:'business-operator',operatorId:row.operator_id,role:row.role,endpoint,httpRequestId:requestId};
      if(action!==undefined){
        if(!permissions)throw new ServiceError('operations_authorization_unavailable',503);
        return permissions.requireAction(actor,action);
      }
      // Upstream roles admit management identities. With business authorization
      // installed, each actual operation independently requires its closed action.
      if(!permissions&&write&&row.role!=='administrator')throw denied();
      return actor;
    },
    async logout(request,response) {
      sameOrigin(request,true);
      const row=await rawSession(request);
      if (!row || !equal(request.headers['x-galaxy-operator-csrf'],row.csrf_token)) throw denied();
      const pending=cookieValue(request,loginCookie);
      await transaction(db,async tx=>{
        await tx.query('DELETE FROM operations_operator_sessions_v1 WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3', [...scope,row.token_hash]);
        if(pending)await tx.query("UPDATE operations_operator_logins_v1 SET status='revoked' WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3",[...scope,digest(pending)]);
      });
      response.setHeader('Set-Cookie',[cookie(sessionCookie,'',0),cookie(loginCookie,'',0)]);
      return signedOut();
    },
  });
}
