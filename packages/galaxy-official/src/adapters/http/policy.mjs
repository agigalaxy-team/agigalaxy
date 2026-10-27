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
  const readIntent=request.method==='GET'||request.method==='OPTIONS'&&request.headers['access-control-request-method']==='GET';
  const consentList = request.method === 'GET' && url.pathname === '/v1/consents';
  const oidcCallback = request.method === 'GET' && (/^\/v1\/identity\/callback\/[a-z0-9][a-z0-9._-]{0,63}$/.test(url.pathname) || url.pathname === '/v1/account/callback' || url.pathname === '/v1/operations/callback');
  const auditDirectory=url.pathname==='/v1/operations/audit',accountAudit=/^\/v1\/operations\/users\/[0-9a-f-]{36}\/audit$/.test(url.pathname);
  const auditQuery=request.method==='GET'&&(auditDirectory||accountAudit)&&url.search.length<=8192
    &&[...url.searchParams.keys()].every(key=>(auditDirectory?['accountId','resourceId','after','limit','action','kind','day','query','page','pageSize','snapshot','sort']:['resourceId','after','limit','action','kind','day','query','page','pageSize','snapshot','sort']).includes(key)&&url.searchParams.getAll(key).length===1);
  const chatReportsQuery=request.method==='GET'&&url.pathname==='/v1/operations/chat-reports'&&url.search.length<=8192
    &&[...url.searchParams.keys()].every(key=>['roomId','state','after','limit'].includes(key)&&url.searchParams.getAll(key).length===1);
  const permissionsHistoryQuery=request.method==='GET'&&url.pathname==='/v1/operations/permissions/history'&&url.search.length<=8192
    &&[...url.searchParams.keys()].every(key=>['after','limit','resourceId','targetOperatorId'].includes(key)&&url.searchParams.getAll(key).length===1);
  const messagingQueryKeys=url.pathname==='/v1/operations/messaging/plans'?['after','limit','state']
    :url.pathname==='/v1/operations/messaging/runs'?['after','limit','planId']
    :/^\/v1\/operations\/messaging\/runs\/[0-9a-f-]{36}\/recipients$/i.test(url.pathname)?['after','limit','channel','state']
    :url.pathname==='/v1/announcements'||/^\/v1\/operations\/smtp\/(?:queue|tests|history)$/.test(url.pathname)||/^\/v1\/operations\/messaging\/plans\/[0-9a-f-]{36}\/history$/i.test(url.pathname)?['after','limit']:null;
  const messagingQuery=request.method==='GET'&&messagingQueryKeys&&url.search.length<=8192
    &&[...url.searchParams.keys()].every(key=>messagingQueryKeys.includes(key)&&url.searchParams.getAll(key).length===1);
  const autonomyQueryKeys=url.pathname==='/v1/operations/autonomy/tasks'?['page','limit','domain','source','state','mode','targetType','targetId']
    :url.pathname==='/v1/operations/autonomy/overview'?['days']:null;
  const autonomyQuery=request.method==='GET'&&autonomyQueryKeys&&url.search.length<=2048
    &&[...url.searchParams.keys()].every(key=>autonomyQueryKeys.includes(key)&&url.searchParams.getAll(key).length===1);
  const nativeQueryKeys=url.pathname==='/v1/operations/agentos/runs'?['page','limit','domain','state']
    :url.pathname==='/v1/operations/strategies/records'?['after','limit','strategyId']
    :url.pathname==='/v1/operations/strategies/versions'?['after','limit']
    :/^\/v1\/operations\/ai-work-accounts\/(?:overview|governance|messaging|discovery|maintenance)\/history$/.test(url.pathname)?['after','limit']
    :/^\/v1\/operations\/rules\/(?:resource-budget|community-quota|forum-quota|business-controls)\/versions$/.test(url.pathname)?['after','limit']
    :url.pathname==='/v1/operations/recommendation/overview'?['days','query']
    :url.pathname==='/v1/operations/recommendation/history'?['after','limit']
    :url.pathname==='/v1/operations/search-quality/overview'?['days','query','issue','after','limit']
    :url.pathname==='/v1/operations/search-quality/history'?['after','limit']
    :url.pathname==='/v1/operations/maintenance/logs'?['component','level','period','before','limit']
    :/^\/v1\/operations\/system-settings\/(?:mail|service-connections)\/history$/.test(url.pathname)?['after','limit']
    :url.pathname==='/v1/operations/model-settings/history'?['after','limit']
    :url.pathname==='/v1/operations/model-settings/usage'?['days']
    :url.pathname==='/v1/operations/maintenance/backups'||url.pathname==='/v1/operations/maintenance/restore-plans'||/^\/v1\/operations\/maintenance\/restore-plans\/[0-9a-f-]{36}$/i.test(url.pathname)?['after','limit']
    :url.pathname==='/v1/operations/discovery/analytics'?['kind','days','scope','accountId']
    :url.pathname==='/v1/discovery/search'?['q','topic','after','limit']
    :url.pathname==='/v1/discovery/recommendations'?['mode','topic','limit']:null;
  // These browser GETs carry their query string on the credential preflight.
  // The existing browser policy still validates origin, method and headers.
  const discoveryGetPreflight=request.method==='OPTIONS'&&request.headers['access-control-request-method']==='GET'
    &&['/v1/discovery/search','/v1/discovery/recommendations'].includes(url.pathname);
  const nativeQuery=(request.method==='GET'||discoveryGetPreflight)&&nativeQueryKeys&&url.search.length<=(/^\/v1\/operations\/(?:search-quality|maintenance)\//.test(url.pathname)?4096:2048)
    &&[...url.searchParams.keys()].every(key=>nativeQueryKeys.includes(key)&&url.searchParams.getAll(key).length===1);
  const conversationEventsQuery=request.method==='GET'&&/^\/v1\/operations\/agentos\/conversations\/(?:overview|governance|messaging|discovery|maintenance)\/operations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/events$/i.test(url.pathname)
    &&url.search.length<=80&&[...url.searchParams].every(([key,value])=>key==='after'&&url.searchParams.getAll(key).length===1&&/^(?:0|[1-9][0-9]{0,9})$/.test(value));
  const filesDirectory=url.pathname==='/v1/operations/files',filesSummary=url.pathname==='/v1/operations/files/summary';
  const filesQuery=request.method==='GET'&&(filesDirectory||filesSummary)&&url.search.length<=8192
    &&[...url.searchParams.keys()].every(key=>(filesDirectory?['after','limit','kind','state','processing','issue']:['kind','state','processing','issue']).includes(key)&&url.searchParams.getAll(key).length===1);
  const fileCleanupQueryKeys=url.pathname==='/v1/operations/files/cleanup/candidates'?['kind','after','limit']
    :url.pathname==='/v1/operations/files/cleanup/plans'?['after','limit']:null;
  const fileCleanupQuery=request.method==='GET'&&fileCleanupQueryKeys&&url.search.length<=4096
    &&[...url.searchParams.keys()].every(key=>fileCleanupQueryKeys.includes(key)&&url.searchParams.getAll(key).length===1);
  const operationsQuery=request.method==='GET'&&!auditDirectory&&!accountAudit&&!filesDirectory&&/^\/v1\/operations\/(?:login|users(?:\/[0-9a-f-]{36}(?:\/(?:audit|links|type-history))?)?|audit|jobs|search\/failures|content\/publications|community\/(?:sections|reports|posts)|resources\/(?:projects|methods)|files|notices|rules\/(?:resource-budget|community-quota|forum-quota)\/history|retention\/runs)$/.test(url.pathname)
    &&url.search.length<=8192&&[...url.searchParams.keys()].every(key=>['returnTo','query','after','limit','accountId','resourceId','queue','state','category','kind','processing'].includes(key)&&url.searchParams.getAll(key).length===1);
  const accountAnalyticsSummary=request.method==='GET'&&/^\/v1\/operations\/users(?:\/[0-9a-f-]{36})?\/summary$/i.test(url.pathname);
  const registeredDirectory=url.pathname==='/v1/operations/registered-users';
  const registeredHistory=/^\/v1\/operations\/registered-users\/[0-9a-f-]{36}\/history$/i.test(url.pathname);
  const registeredQuery=request.method==='GET'&&(registeredDirectory||registeredHistory)&&url.search.length<=4096
    &&[...url.searchParams.keys()].every(key=>(registeredDirectory
      ?['page','pageSize','query','source','subjectType','login','emailVerified','registeredFrom','registeredTo','sort','participation','business']
      :['after','limit']).includes(key)&&url.searchParams.getAll(key).length===1);
  const managementDirectory=url.pathname==='/v1/operations/management-accounts';
  const managementHistory=/^\/v1\/operations\/management-accounts\/[a-f0-9]{64}\/history$/i.test(url.pathname);
  const managementQuery=request.method==='GET'&&(managementDirectory||managementHistory)&&url.search.length<=4096
    &&[...url.searchParams.keys()].every(key=>(managementDirectory
      ?['page','pageSize','query','enabled','roleId','aiDomain','sort']:['after','limit']).includes(key)&&url.searchParams.getAll(key).length===1);
  const accountDirectory=request.method==='GET'&&url.pathname==='/v1/operations/users';
  const accountAnalyticsQuery=(accountAnalyticsSummary||accountDirectory)&&url.search.length<=8192
    &&[...url.searchParams.keys()].every(key=>(accountAnalyticsSummary?['days']:['query','after','limit','subjectType','restriction']).includes(key)&&url.searchParams.getAll(key).length===1);
  const feedbackDirectory=request.method==='GET'&&url.pathname==='/v1/operations/feedback';
  const feedbackHistory=request.method==='GET'&&/^\/v1\/operations\/feedback\/[0-9a-f-]{36}$/i.test(url.pathname);
  const feedbackQuery=(feedbackDirectory||feedbackHistory)&&url.search.length<=8192
    &&[...url.searchParams.keys()].every(key=>(feedbackDirectory?['query','category','module','state','days','after','limit']:['historyAfter']).includes(key)&&url.searchParams.getAll(key).length===1);
  const contentDirectory=request.method==='GET'&&url.pathname==='/v1/operations/community/content';
  const contentHistory=request.method==='GET'&&/^\/v1\/operations\/community\/content\/(post|reply)\/[0-9a-f-]{36}$/i.test(url.pathname);
  const contentQuery=(contentDirectory||contentHistory)&&url.search.length<=8192
    &&[...url.searchParams.keys()].every(key=>(contentDirectory?['query','targetId','kind','topic','visibility','pinned','featured','days','after','limit']:['historyAfter']).includes(key)&&url.searchParams.getAll(key).length===1);
  const identityReturn=request.method==='GET'&&/^\/v1\/identity\/return\/[0-9a-f-]{36}$/i.test(url.pathname)&&url.search.length<=8192;
  const accountQuery = readIntent && ['/v1/account/login','/v1/account/session','/v1/account/archives','/v1/account/external-credentials'].includes(url.pathname) && url.search.length <= 8192;
  const accountFeedbackExportQuery=readIntent&&/^\/v1\/account\/data\/feedback\/exports\/[0-9a-f-]{36}$/i.test(url.pathname)&&url.search.length<=160
    &&[...url.searchParams.keys()].every(key=>['after','limit'].includes(key)&&url.searchParams.getAll(key).length===1)
    &&(!url.searchParams.has('after')||/^(0|[1-9][0-9]{0,18})$/.test(url.searchParams.get('after')))
    &&(!url.searchParams.has('limit')||/^(?:[1-9]|[1-4][0-9]|50)$/.test(url.searchParams.get('limit')));
  const accountNoticeQuery=readIntent&&url.pathname==='/v1/account/notifications/notices'&&url.search.length<=512&&[...url.searchParams.keys()].every(key=>['after','limit','unreadOnly'].includes(key)&&url.searchParams.getAll(key).length===1);
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
  const summaryQuery = request.method === 'GET' && url.pathname === '/v1/operations/summary'
    && url.search.length <= 80 && keys.length === 1 && keys[0] === 'publicActivity'
    && url.searchParams.get('publicActivity') === 'deferred';
  const webEventsQuery=readIntent&&['/v1/web-events','/v1/operations/web-events'].includes(url.pathname)&&url.search.length<=4096
    &&keys.every(key=>['cursor','topics','stream'].includes(key)&&url.searchParams.getAll(key).length===1)
    &&(!url.searchParams.has('cursor')||/^(0|[1-9][0-9]{0,18})$/.test(url.searchParams.get('cursor')))
    &&(!url.searchParams.has('stream')||['true','false'].includes(url.searchParams.get('stream')))
    &&(!url.searchParams.has('topics')||url.searchParams.get('topics').length<=1024&&url.searchParams.get('topics').split(',').length<=32&&url.searchParams.get('topics').split(',').every(value=>/^[a-z][a-z-]{0,50}$/.test(value)));
  const permissionsCatalogLeaseQuery=readIntent&&url.pathname==='/v1/operations/permissions/catalog/lease'&&keys.length===1&&keys[0]==='version'&&url.search.length<=80&&/^[a-f0-9]{64}$/.test(url.searchParams.get('version'));
  const allowedQuery = consentList ? keys.every(key => key === 'after') && url.searchParams.getAll('after').length === 1
    : oidcCallback && url.search.length <= 8192 && keys.every(key => ['code','state','iss','error','error_description','error_uri','session_state'].includes(key))
      && new Set(keys).size === keys.length || webEventsQuery || permissionsCatalogLeaseQuery || recruitmentReceipt || forumQuota || summaryQuery || accountQuery || accountNoticeQuery || accountFeedbackExportQuery || publicAccountQuery || publicAccountPostsQuery || identityReturn || operationsQuery || auditQuery || chatReportsQuery || permissionsHistoryQuery || messagingQuery || autonomyQuery || nativeQuery || conversationEventsQuery || filesQuery || fileCleanupQuery || accountAnalyticsQuery || registeredQuery || managementQuery || feedbackQuery || contentQuery;
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
