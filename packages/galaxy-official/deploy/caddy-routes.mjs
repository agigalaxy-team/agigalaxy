// Route fragment for the existing Caddy server. Does not replace listeners,
// TLS, other virtual hosts or the static website. Only the exact host is owned.
export function officialRoutes({ endpoint, apiPort }) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.origin !== endpoint || url.username || url.password || url.port
    || !/^[a-z0-9.-]+$/.test(url.hostname) || !url.hostname.includes('.')
    || !Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535)
    throw new Error('Invalid Official proxy configuration');
  const id = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const matchers = [
    // The versioned API owns validation/ACL for these product-v2 routes. Keep
    // browser preflight and later additive v2 operations reachable through the
    // same host; unknown routes remain an API 404, not another upstream.
    { method: ['GET','POST','OPTIONS'], path: ['/v2/*'] },
    { method: ['GET'], path: ['/v1/discovery/config','/v1/discovery/search','/v1/discovery/recommendations','/v1/announcements'] },
    { method: ['POST'], path: ['/v1/discovery/events'] },
    { method: ['PUT'], path_regexp:{name:'galaxy_attachment_upload',pattern:`^/v2/(chat|community)/attachments/${id}/upload$`} },
    { method: ['GET','POST','DELETE'], path:['/v1/account/*'] },
    { method:['POST'],path:['/v1/account/bookmarks/status','/v1/account/bookmarks/command','/v1/account/bookmarks/query','/v1/account/bookmarks/receipt'] },
    { method: ['OPTIONS'], path: ['/v1/*','/mcp/*'] },
    { method: ['POST'], path: ['/v1/bindings/query','/v1/assistance/events/receipt','/v1/requester-history/facts','/v1/context-grants/receipt','/v1/notifications/archive'] },
    { method: ['POST','GET','DELETE'], path: ['/mcp/personal'] },
    { method: ['GET'], path: ['/.well-known/oauth-protected-resource/mcp/personal'] },
    { method: ['POST'], path: ['/v1/identity/providers', '/v1/identity/begin', '/v1/identity/status', '/v1/identity/cancel', '/v1/identity/confirm', '/v1/identity/query', '/v1/identity/revoke'] },
    { method: ['GET'], path_regexp: { name: 'galaxy_identity_callback', pattern: '^/v1/identity/callback/[a-z0-9][a-z0-9._-]{0,63}$' } },
    { method: ['POST'], path: ['/v1/honor/rule-history'] },
    { method: ['POST'], path: ['/v1/builders/node-control/export'] },
    { method: ['POST'], path: ['/v1/search/query', '/v1/builders/manage/read', '/v1/builders/owned/query', '/v1/builders/events/receipt', '/v1/builders/notices/query'] },
    { method: ['POST'], path: ['/v1/profiles/statements'] },
    { method: ['POST'], path: ['/v1/discovery/query', '/v1/discovery/preferences/read', '/v1/discovery/preferences/save'] },
    { method: ['POST'], path: ['/v1/deletion-requests/status', '/v1/deletion-requests/config','/v1/deletion-requests/submit','/v1/deletion-requests/read','/v1/deletion-requests/query'] },
    { method: ['POST'], path: ['/v1/data-exports/specification', '/v1/data-exports/create', '/v1/data-exports/page', '/v1/data-exports/revoke'] },
    { method: ['GET'], path: ['/.well-known/galaxy-network.json', '/.well-known/galaxy-signing-keys.json',
      '/v1/policy', '/v1/service-status', '/v1/signing-keys/status', '/v1/consents'] },
    { method: ['POST'], path: ['/mcp/docs', '/v1/binding-challenges', '/v1/bindings', '/v1/session-challenges',
      '/v1/sessions', '/v1/consents', '/v1/cases', '/v1/case-events', '/v1/evidence-submissions',
      '/v1/proof-previews', '/v1/proofs', '/v1/history/query', '/v1/assistance', '/v1/assistance/query', '/v1/context-grants', '/v1/context-grants/query', '/v1/notifications/query', '/v1/notifications/preferences/read', '/v1/notifications/preferences/save', '/v1/notifications/read', '/v1/requester-history/query', '/v1/qualification/policies', '/v1/qualification/evaluate', '/v1/builders/specification', '/v1/builders/events', '/v1/builders/read', '/v1/builders/query', '/v1/capsules/events', '/v1/capsules/uses', '/v1/capsules/read', '/v1/capsules/query', '/v1/capsules/uses/query', '/v1/honor/rules', '/v1/honor/query', '/v1/honor/ranking', '/v1/moderation/config', '/v1/moderation/reports', '/v1/moderation/reports/query'] },
    { method: ['POST'], path: ['/v1/builders/reports/export'] },
    { method: ['POST'], path: ['/v1/audit/config', '/v1/audit/query', '/v1/audit/export', '/v1/audit/grants', '/v1/audit/grants/approve', '/v1/audit/grants/revoke'] },
    { method: ['POST'], path_regexp: { name: 'galaxy_moderation', pattern: `^/v1/moderation/reports/${id}/(read|events)$` } },
    { method: ['GET'], path_regexp: { name: 'galaxy_context', pattern: `^/v1/context-grants/${id}$` } },
    { method: ['POST'], path_regexp: { name: 'galaxy_context_action', pattern: `^/v1/context-grants/${id}/(accept|revoke)$` } },
    { method: ['GET'], path_regexp: { name: 'galaxy_assistance', pattern: `^/v1/assistance/${id}$` } },
    { method: ['POST'], path_regexp: { name: 'galaxy_assistance_event', pattern: `^/v1/assistance/${id}/events$` } },
    { method: ['GET'], path_regexp: { name: 'galaxy_honor', pattern: '^/v1/honor/GUID[0-9A-Z]{28}/[a-z0-9][a-z0-9._-]{0,79}/[0-9]+(?:\\.[0-9]+){0,2}$' } },
    { method: ['GET'], path_regexp: { name: 'galaxy_profile', pattern: '^/v1/profiles/GUID[0-9A-Z]{28}$' } },
    { method: ['GET'], path_regexp: { name: 'galaxy_read', pattern: `^/v1/(bindings|cases|verifications)/${id}$` } },
    { method: ['GET'], path_regexp: { name: 'galaxy_proof', pattern: `^/v1/proofs/${id}(/status)?$` } },
    { method: ['POST'], path_regexp: { name: 'galaxy_revoke', pattern: `^/v1/(bindings|consents|proofs)/${id}/revoke$` } },
  ].map(matcher => ({ host: [url.hostname], ...matcher }));
  return [
    { match: matchers, handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${apiPort}` }] }], terminal: true },
    { match: [{ host: [url.hostname] }], handle: [{ handler: 'static_response', status_code: 404 }], terminal: true },
  ];
}
