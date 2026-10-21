// Bounded best-effort failure persistence. A timed-out backend keeps its slot
// until it actually settles; never turn a timeout into a duplicate write.
export function boundedFailureAudit(write, { timeoutMs = 2000, maxPending = 8 } = {}) {
  if (typeof write !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000
    || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 32) throw new Error('Invalid audit bounds');
  let pending = 0;
  return async event => {
    if (pending >= maxPending) return 'capacity';
    pending++;
    let finish;
    const result = new Promise(resolve => { finish = resolve; });
    const timer = setTimeout(() => finish('unconfirmed'), timeoutMs);
    Promise.resolve().then(() => write(event)).then(value => finish(value?.state==='suppressed-by-deletion'?'suppressed-by-deletion':'recorded'), () => finish('failed')).finally(() => {
      pending--; clearTimeout(timer);
    });
    return result;
  };
}

const fixed = new Set(['/v1/identity/providers', '/v1/identity/begin', '/v1/identity/status', '/v1/identity/cancel', '/v1/identity/confirm', '/v1/identity/query', '/v1/identity/revoke', '/v1/binding-challenges', '/v1/bindings', '/v1/bindings/query', '/v1/session-challenges', '/v1/sessions',
  '/v1/data-exports/specification', '/v1/data-exports/create', '/v1/data-exports/page', '/v1/data-exports/revoke',
  '/v1/deletion-requests/status', '/v1/deletion-requests/config', '/v1/deletion-requests/submit', '/v1/deletion-requests/read', '/v1/deletion-requests/query',
  '/v1/audit/config', '/v1/audit/query', '/v1/audit/export', '/v1/audit/grants', '/v1/audit/grants/approve', '/v1/audit/grants/revoke',
  '/v1/consents', '/v1/cases', '/v1/case-events', '/v1/evidence-submissions', '/v1/proof-previews', '/v1/proofs',
  '/v1/policy', '/v1/service-status', '/v1/signing-keys/status', '/.well-known/galaxy-network.json', '/.well-known/galaxy-signing-keys.json', '/mcp/docs', '/readyz', '/healthz',
  '/v1/builders/events', '/v1/builders/read', '/v1/builders/query', '/v1/builders/reports/export','/v1/builders/node-control/export',
  '/v1/builders/manage/read','/v1/builders/owned/query','/v1/builders/events/receipt','/v1/builders/notices/query',
  '/v1/capsules/events', '/v1/capsules/uses', '/v1/capsules/read', '/v1/capsules/query', '/v1/capsules/uses/query',
  '/v1/history/query', '/v1/search/query', '/v1/profiles/statements', '/v1/honor/query', '/v1/honor/ranking', '/v1/honor/rules', '/v1/honor/rule-history',
  '/v1/assistance', '/v1/assistance/query', '/v1/assistance/events/receipt', '/v1/requester-history/query',
  '/v1/context-grants', '/v1/context-grants/query', '/v1/context-grants/receipt', '/v1/qualification/policies', '/v1/qualification/evaluate',
  '/v1/notifications/query', '/v1/notifications/preferences/read', '/v1/notifications/preferences/save', '/v1/notifications/read', '/v1/notifications/archive', '/v1/requester-history/facts',
  '/v1/moderation/config', '/v1/moderation/reports', '/v1/moderation/reports/query']);
for(const path of ['/v1/account/session','/v1/account/login','/v1/account/logout','/v1/account/callback','/v1/account/settings',
  '/v1/account/work/list','/v1/account/work/get','/v1/account/work/status','/v1/account/work/delete','/v1/account/archives',
  '/v1/operations/session','/v1/operations/login','/v1/operations/callback','/v1/operations/logout','/v1/operations/users',
  '/v1/operations/audit','/v1/operations/chat-reports','/v1/operations/jobs','/v1/operations/search/failures','/v1/operations/content/publications',
  '/v2/community/topics','/v2/community/access-options','/v2/community/posts','/v2/community/posts/query',
  '/v2/community/posts/owned','/v2/community/sections','/v2/community/sections/query','/v2/community/reports',
  '/v2/community/reports/query','/v2/community/accounts/query','/v2/community/notifications/query',
  '/v2/community/notifications/read','/v2/community/attachments/config','/v2/community/attachments/prepare',
  '/v2/community/attachments/read','/v2/community/attachments/query','/v2/community/attachments/revoke',
  '/v2/chat/attachments/config','/v2/chat/attachments/prepare','/v2/chat/attachments/read','/v2/chat/attachments/query','/v2/chat/attachments/revoke',
  '/v2/account-work/put','/v2/account-work/get','/v2/account-work/list','/v2/account-work/status','/v2/account-work/delete',
  '/v2/account-archives/accounts','/v2/account-archives/list','/v2/account-archives/status',
  '/v2/reading-bookmarks/query','/v2/reading-bookmarks/get','/v2/reading-bookmarks/save','/v2/reading-bookmarks/remove'])fixed.add(path);
const id='[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const templates=[
  [new RegExp('^/v1/account/public/by-uid/[a-z0-9]{6,16}$','i'),'/v1/account/public/by-uid/:uid'],
  [new RegExp('^/v1/account/public/'+id+'(/posts)?$','i'),'/v1/account/public/:id'],
  [new RegExp('^/v1/operations/users/'+id+'(/(?:audit|links|type-history|restriction(?:/release)?|type-change))?$','i'),'/v1/operations/users/:id'],
  [new RegExp('^/v1/operations/jobs/(information-watch|search-recovery|content-publication)/'+id+'(/(?:cancel|retry))?$','i'),'/v1/operations/jobs/:queue/:id'],
  [new RegExp('^/v1/operations/search/failures/'+id+'(/retry)?$','i'),'/v1/operations/search/failures/:id'],
  [new RegExp('^/v1/operations/chat-reports/'+id+'(/event|/attachments/'+id+'/content)?$','i'),'/v1/operations/chat-reports/:id'],
  [new RegExp('^/v1/operations/content/publications/'+id+'$','i'),'/v1/operations/content/publications/:id'],
  [new RegExp('^/v2/community/(posts|sections|replies|reports)/'+id+'(/(?:versions|replies|permissions|quota|classification|events|receipt))?$','i'),'/v2/community/:kind/:id'],
  [new RegExp('^/v2/(community|chat)/attachments/'+id+'/(content|export-content)$','i'),'/v2/:area/attachments/:id/:operation'],
];
export function failureRoute(method, pathname) {
  if(['GET','POST','DELETE'].includes(method)&&pathname==='/mcp/personal')return `${method} /mcp/personal`;
  if(method==='GET'&&pathname==='/.well-known/oauth-protected-resource/mcp/personal')return 'GET /.well-known/oauth-protected-resource/mcp/personal';
  if (!['GET', 'POST'].includes(method)) return 'http.request';
  // Runtime logging receives the same already-templated tag as the audit path.
  if(typeof pathname==='string'&&(/^\/v1\/(?:identity\/callback\/:provider|(?:bindings|consents|cases|verifications|proofs|assistance|context-grants|moderation\/reports)\/:id(?:\/(?:revoke|status|events|accept|read))?|account\/public\/(?:by-uid\/:uid|:id(?:\/posts)?)|operations\/(?:users\/:id(?:\/(?:audit|links|type-history|restriction(?:\/release)?|type-change))?|jobs\/(?:information-watch|search-recovery|content-publication)\/:id(?:\/(?:cancel|retry))?|search\/failures\/:id(?:\/retry)?|chat-reports\/:id(?:\/event|\/attachments\/:id\/content)?|content\/publications\/:id))$/.test(pathname)
    ||/^\/v2\/(?:community\/(?:posts|sections|replies|reports)\/:id(?:\/(?:versions|replies|permissions|quota|classification|events|receipt))?|(?:community|chat)\/attachments\/:id\/(?:content|export-content))$/.test(pathname)))return `${method} ${pathname}`;
  if (method === 'GET' && /^\/v1\/identity\/callback\/[a-z0-9][a-z0-9._-]{0,63}$/.test(pathname ?? '')) return 'GET /v1/identity/callback/:provider';
  if (fixed.has(pathname)) return `${method} ${pathname}`;
  for(const [pattern,template] of templates){
    const matched=pattern.exec(pathname??'');if(!matched)continue;
    const suffix=matched[1]??'';
    if(template==='/v2/community/:kind/:id')return `${method} /v2/community/${suffix}/:id${matched[2]??''}`;
    if(template==='/v1/operations/jobs/:queue/:id')return `${method} /v1/operations/jobs/${suffix}/:id${matched[2]??''}`;
    if(template==='/v2/:area/attachments/:id/:operation')return `${method} /v2/${suffix}/attachments/:id/${matched[2]}`;
    if(template==='/v1/operations/chat-reports/:id')return `${method} ${template}${suffix.startsWith('/attachments/')?'/attachments/:id/content':suffix}`;
    return `${method} ${template}${suffix}`;
  }
  const match = /^\/v1\/(bindings|consents|cases|verifications|proofs|assistance|context-grants|moderation\/reports)\/[0-9a-f-]{36}(\/(revoke|status|events|accept|read))?$/.exec(pathname ?? '');
  return match ? `${method} /v1/${match[1]}/:id${match[2] ?? ''}` : 'http.request';
}
