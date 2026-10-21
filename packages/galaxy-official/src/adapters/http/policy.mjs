import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { ServiceError } from '../../shared/service-error.mjs';

function canonical(address) {
  if (typeof address !== 'string' || !isIP(address) || address.includes('%')) throw new Error('Invalid IP address');
  return ipaddr.process(address).toString();
}

// Trust exact proxy addresses, never arbitrary forwarding headers or a hop count.
// Walk from the socket towards the client and stop at the first untrusted hop.
export function clientAddressReader(trustedProxyAddresses = []) {
  if (!Array.isArray(trustedProxyAddresses) || trustedProxyAddresses.length > 32) throw new Error('Invalid trusted proxies');
  const trusted = new Set(trustedProxyAddresses.map(canonical));
  return request => {
    const socket = canonical(request.socket.remoteAddress);
    if (!trusted.has(socket)) return socket;
    const raw = request.headers['x-forwarded-for'];
    if (typeof raw !== 'string' || raw.length > 1024) throw new ServiceError('invalid_forwarded_address');
    const chain = raw.split(',').map(s => s.trim());
    if (!chain.length || chain.length > 16) throw new ServiceError('invalid_forwarded_address');
    let addresses;
    try { addresses = chain.map(canonical); } catch { throw new ServiceError('invalid_forwarded_address'); }
    let address = socket;
    for (let i = addresses.length - 1; i >= 0 && trusted.has(address); i--) address = addresses[i];
    return address;
  };
}

export function requestUrl(request, endpoint, browserOrigins = []) {
  if (request.headers.origin && !browserOrigins.includes(request.headers.origin)) throw new ServiceError('browser_origin_not_enabled', 403);
  let url;
  try { url = new URL(request.url, endpoint); } catch { throw new ServiceError('invalid_request'); }
  const consentList = request.method === 'GET' && url.pathname === '/v1/consents';
  const oidcCallback = request.method === 'GET' && (/^\/v1\/identity\/callback\/[a-z0-9][a-z0-9._-]{0,63}$/.test(url.pathname) || url.pathname === '/v1/account/callback' || url.pathname === '/v1/operations/callback');
  const operationsQuery=request.method==='GET'&&/^\/v1\/operations\/(?:login|users(?:\/[0-9a-f-]{36}(?:\/(?:audit|links|type-history))?)?|audit|jobs|search\/failures|content\/publications|chat-reports|community\/(?:sections|reports|posts)|resources\/(?:projects|methods)|files|notices|rules\/(?:resource-budget|community-quota|forum-quota)\/history|retention\/runs)$/.test(url.pathname)
    &&url.search.length<=8192&&[...url.searchParams.keys()].every(key=>['returnTo','query','after','limit','accountId','resourceId','queue','state','category','kind','processing'].includes(key)&&url.searchParams.getAll(key).length===1);
  const identityReturn=request.method==='GET'&&/^\/v1\/identity\/return\/[0-9a-f-]{36}$/i.test(url.pathname)&&url.search.length<=8192;
  const accountQuery = request.method === 'GET' && ['/v1/account/login','/v1/account/session','/v1/account/archives','/v1/account/external-credentials'].includes(url.pathname) && url.search.length <= 8192;
  const accountNoticeQuery=request.method==='GET'&&url.pathname==='/v1/account/notifications/notices'&&url.search.length<=512&&[...url.searchParams.keys()].every(key=>['after','limit','unreadOnly'].includes(key)&&url.searchParams.getAll(key).length===1);
  const publicAccountQuery=request.method==='GET'&&/^\/v1\/account\/public\/(?:[0-9a-f-]{36}\/(?:ids|credentials)|by-id\/GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26})$/.test(url.pathname)
    &&url.search.length<=160&&[...url.searchParams.keys()].every(key=>['after','limit'].includes(key)&&url.searchParams.getAll(key).length===1);
  const publicAccountPostsQuery=request.method==='GET'&&/^\/v1\/account\/public\/[0-9a-f-]{36}\/posts$/.test(url.pathname)
    &&url.search.length<=600&&[...url.searchParams.keys()].every(key=>['after','limit'].includes(key)&&url.searchParams.getAll(key).length===1)
    &&(!url.searchParams.has('after')||url.searchParams.get('after').length<=512&&/^fp1\.[A-Za-z0-9_-]+$/.test(url.searchParams.get('after')))
    &&(!url.searchParams.has('limit')||/^(?:[1-9]|[1-4][0-9]|50)$/.test(url.searchParams.get('limit')));
  // This exact owner-only receipt route validates its two keys itself. Other
  // paths and methods retain the existing query prohibition.
  const recruitmentReceipt = request.method === 'GET'
    && /^\/v2\/recruitment\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/receipt$/.test(url.pathname)
    && url.search.length <= 512;
  const keys = [...url.searchParams.keys()];
  const forumQuota = request.method === 'GET' && url.pathname === '/v2/community/quotas'
    && url.search.length <= 96 && keys.length === 1 && ['postId','replyId','sectionId'].includes(keys[0])
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(url.searchParams.get(keys[0]));
  const allowedQuery = consentList ? keys.every(key => key === 'after') && url.searchParams.getAll('after').length === 1
    : oidcCallback && url.search.length <= 8192 && keys.every(key => ['code','state','iss','error','error_description','error_uri','session_state'].includes(key))
      && new Set(keys).size === keys.length || recruitmentReceipt || forumQuota || accountQuery || accountNoticeQuery || publicAccountQuery || publicAccountPostsQuery || identityReturn || operationsQuery;
  if (url.origin !== endpoint || url.username || url.password || url.hash || (url.search && !allowedQuery))
    throw new ServiceError('invalid_request');
  return url;
}

export function fixedWindowLimiter({ limit, now = Date.now, capacity = 10000 }) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid rate limit');
  const windows = new Map();
  return (address, response) => {
    const time = now();
    for (const [key, value] of windows) if (value.until <= time) windows.delete(key);
    if (!windows.has(address)) {
      if (windows.size >= capacity) throw new ServiceError('capacity_limited', 503);
      windows.set(address, { until: time + 60000, count: 0 });
    }
    if (++windows.get(address).count > limit) {
      response.setHeader('Retry-After', '60');
      throw new ServiceError('rate_limited', 429);
    }
  };
}
