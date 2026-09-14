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
export function failureRoute(method, pathname) {
  if(['GET','POST','DELETE'].includes(method)&&pathname==='/mcp/personal')return `${method} /mcp/personal`;
  if(method==='GET'&&pathname==='/.well-known/oauth-protected-resource/mcp/personal')return 'GET /.well-known/oauth-protected-resource/mcp/personal';
  if (!['GET', 'POST'].includes(method)) return 'http.request';
  if (method === 'GET' && /^\/v1\/identity\/callback\/[a-z0-9][a-z0-9._-]{0,63}$/.test(pathname ?? '')) return 'GET /v1/identity/callback/:provider';
  if (fixed.has(pathname)) return `${method} ${pathname}`;
  const match = /^\/v1\/(bindings|consents|cases|verifications|proofs|assistance|context-grants|moderation\/reports)\/[0-9a-f-]{36}(\/(revoke|status|events|accept|read))?$/.exec(pathname ?? '');
  return match ? `${method} /v1/${match[1]}/:id${match[2] ?? ''}` : 'http.request';
}
