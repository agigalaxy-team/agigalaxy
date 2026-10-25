import {ServiceError} from './shared/service-error.mjs';

const unavailable = () => new ServiceError('operations_directory_unavailable', 503);
const validSubject = value => typeof value === 'string' && /^[A-Za-z0-9._:@-]{1,255}$/.test(value);
const validEmail = value => typeof value === 'string' && value.length <= 320 && /^[^\s@<>]+@[^\s@<>]+$/.test(value);

// This adapter has no user-management write methods. Its service credential and
// access token stay in this server process; consumers receive a minimal view.
export function createKeycloakAdminDirectory({issuer, clientId, clientSecret, adminOrigin,
  fetch: transport = globalThis.fetch, now = () => Math.floor(Date.now() / 1000), allowLoopbackHttp = false}) {
  const authority = new URL(issuer);
  const realm = /^(.*)\/realms\/([A-Za-z0-9._-]{1,128})\/?$/.exec(authority.pathname);
  if (!realm || authority.username || authority.password || authority.search || authority.hash
    || authority.protocol !== 'https:' && !(allowLoopbackHttp && authority.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(authority.hostname))
    || typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret)
    throw Error('Invalid operations directory configuration.');
  const management=new URL(adminOrigin??authority.origin);
  if(management.origin!==(adminOrigin??authority.origin)||management.username||management.password
    ||management.protocol!=='https:'&&!(management.protocol==='http:'&&['127.0.0.1','[::1]'].includes(management.hostname)))throw Error('Invalid private directory origin.');
  const base = management.origin + realm[1] + '/admin/realms/' + encodeURIComponent(realm[2]) + '/';
  // Keep the public issuer identity; both server-to-server endpoints use the
  // explicitly configured private directory transport (including token renewal).
  const tokenUrl = management.origin + realm[1] + '/realms/' + encodeURIComponent(realm[2]) + '/protocol/openid-connect/token';
  let token = null;
  const roleCache = new Map();
  let roleRevision = 0;
  async function responseJson(url, options) {
    const response = await transport(url, {...options, redirect:'error', signal:AbortSignal.timeout(5000)});
    if (response.status === 404) return {status:404, body:null};
    if (!response.ok) return {status:response.status, body:null};
    const reader = response.body?.getReader();
    let length = 0; const chunks = [];
    if (reader) try {
      for (;;) {
        const result = await reader.read(); if (result.done) break;
        length += result.value.byteLength;
        if (length > 524288) {await reader.cancel(); throw unavailable();}
        chunks.push(result.value);
      }
    } finally {reader.releaseLock();}
    return {status:response.status, body:JSON.parse(Buffer.concat(chunks).toString('utf8'))};
  }
  async function accessToken() {
    if (token && token.expiresAt > now()) return token.value;
    const result = await responseJson(tokenUrl, {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'client_credentials', client_id:clientId, client_secret:clientSecret}).toString()});
    const body = result.body;
    if (result.status !== 200 || typeof body?.access_token !== 'string' || body.access_token.length > 32768
      || !Number.isFinite(body.expires_in) || body.expires_in <= 10) throw unavailable();
    token = {value:body.access_token, expiresAt:now() + Math.min(body.expires_in - 5, 300)};
    return token.value;
  }
  async function read(path, {optional = false} = {}) {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await responseJson(base + path, {headers:{authorization:'Bearer ' + await accessToken(), accept:'application/json'}});
        if (result.status === 401 && attempt === 0) {token = null; continue;}
        if (result.status === 404 && optional) return null;
        if (result.status !== 200) throw unavailable();
        return result.body;
      }
    } catch {throw unavailable();}
    throw unavailable();
  }
  const view = user => ({issuer, externalSubject:user.id, email:validEmail(user.email) ? user.email : null,
    emailVerified:user.emailVerified === true, enabled:user.enabled === true});
  return Object.freeze({
    async findByEmail(email) {
      if (!validEmail(email)) throw new ServiceError('invalid_operations_email');
      const users = await read('users?' + new URLSearchParams({email, exact:'true', max:'100'}));
      if (!Array.isArray(users)) throw unavailable();
      return users.filter(user => validSubject(user?.id) && validEmail(user.email)
        && user.email.toLowerCase() === email.toLowerCase()).map(view);
    },
    async get(principal) {
      if (principal?.issuer !== issuer || !validSubject(principal.externalSubject)) return null;
      const user = await read('users/' + encodeURIComponent(principal.externalSubject), {optional:true});
      return user && user.id === principal.externalSubject ? view(user) : null;
    },
    async getOperatorRoles(principal) {
      if (principal?.issuer !== issuer || !validSubject(principal.externalSubject)) return [];
      const key = principal.externalSubject, cached = roleCache.get(key);
      if (cached && cached.expiresAt > now()) return [...cached.roles];
      const revision = roleRevision;
      const path = 'users/' + encodeURIComponent(key);
      const user = await read(path, {optional:true});
      let roles = [];
      if (user?.id === key && user.enabled === true) {
        const result = await read(path + '/role-mappings/realm/composite');
        if (!Array.isArray(result) || result.length > 4096) throw unavailable();
        roles = result.filter(role => typeof role?.name === 'string' && role.name.length <= 128).map(role => role.name);
      }
      // A read started before an explicit security change cannot repopulate
      // the cache or return an old qualification after that change completed.
      if (revision !== roleRevision) throw unavailable();
      for (const [id, entry] of roleCache) if (entry.expiresAt <= now()) roleCache.delete(id);
      if (roleCache.size >= 256) roleCache.delete(roleCache.keys().next().value);
      // Permission removal/disabled accounts become effective within 15 seconds.
      // A failed refresh is never replaced with stale permissions.
      roleCache.set(key, {roles, expiresAt:now() + 15});
      return [...roles];
    },
    invalidateOperatorRoles(principal) {
      if (principal?.issuer !== issuer || !validSubject(principal.externalSubject)) return false;
      roleRevision++;
      roleCache.delete(principal.externalSubject);
      return true;
    },
  });
}
