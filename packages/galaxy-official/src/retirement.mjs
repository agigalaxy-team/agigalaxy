import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ServiceError } from './shared/service-error.mjs';
import { serviceAccessV2 } from './operations/service-access-v2.mjs';

const publicUrl = z.url().refine(value => {
  const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});
export const retirementPolicySchema = z.object({
  version: z.literal(1), id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  endpoint: publicUrl.refine(value => new URL(value).origin === value),
  operator: z.string().min(1).max(200), reason: z.string().min(1).max(2000),
  announcedAt: z.number().int().nonnegative(), stopWritesAt: z.number().int().nonnegative(),
  takeoutUntil: z.number().int().nonnegative(), statusUntil: z.number().int().nonnegative(),
  contactUrl: publicUrl, deletionPolicyUrl: publicUrl,
}).strict().refine(value => value.announcedAt <= value.stopWritesAt && value.stopWritesAt < value.takeoutUntil && value.takeoutUntil < value.statusUntil);

const metadata = new Set(['POST /v1/deletion-requests/status', 'GET /v1/service-status', 'GET /v1/policy', 'GET /.well-known/galaxy-signing-keys.json', 'GET /v1/signing-keys/status']);
const takeoutPosts = new Set([
  '/v2/information/query','/v2/information/watches/list','/v2/information/watches/receipt','/v2/information/watches/events','/v2/information/watches/stop',
  '/v2/chat/attachments/config','/v2/chat/attachments/query','/v2/chat/attachments/revoke',
  '/v1/identity/query', '/v1/identity/cancel', '/v1/identity/revoke',
  '/v1/deletion-requests/config', '/v1/deletion-requests/submit', '/v1/deletion-requests/read', '/v1/deletion-requests/query',
  '/v1/binding-challenges', '/v1/bindings', '/v1/bindings/query', '/v1/session-challenges', '/v1/sessions', '/mcp/docs',
  '/v1/data-exports/specification', '/v1/data-exports/create', '/v1/data-exports/page', '/v1/data-exports/revoke',
  '/v1/history/query', '/v1/assistance/query', '/v1/assistance/events/receipt', '/v1/context-grants/query', '/v1/context-grants/receipt', '/v1/requester-history/query',
  '/v1/notifications/query', '/v1/notifications/preferences/read', '/v1/qualification/policies', '/v1/qualification/evaluate',
  '/v1/builders/specification', '/v1/builders/read', '/v1/builders/query', '/v1/builders/reports/export',
  '/v1/capsules/read', '/v1/capsules/query', '/v1/capsules/uses/query',
  '/v1/honor/rules', '/v1/honor/query', '/v1/honor/ranking', '/v1/honor/rule-history', '/v1/moderation/config', '/v1/moderation/reports/query',
  '/v1/audit/config', '/v1/audit/query', '/v1/audit/export', '/v1/audit/grants', '/v1/audit/grants/revoke',
]);
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const proofStatus = new RegExp(`^/v1/proofs/${uuid}/status$`);
const revocation = new RegExp(`^/v1/(?:bindings|consents|proofs|context-grants)/${uuid}/revoke$`);
const moderationRead = new RegExp(`^/v1/moderation/reports/${uuid}/read$`);
const ownAttachmentExport = new RegExp(`^/v2/chat/attachments/${uuid}/export-content$`);
const takeoutRead = new RegExp(`^/v1/(?:bindings|cases|verifications|assistance|context-grants)/${uuid}$|^/v1/proofs/${uuid}(?:/status)?$|^/v1/profiles/GUID[0-9A-Z]{28}$|^/v1/honor/GUID[0-9A-Z]{28}/[a-z0-9][a-z0-9._-]{0,79}/[0-9]+(?:\\.[0-9]+){0,2}$`);

export function createRetirementController(input = null, { endpoint, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const policy = input === null ? null : retirementPolicySchema.parse(input);
  if (policy && endpoint && policy.endpoint !== endpoint) throw new Error('Retirement endpoint mismatch');
  const phase = () => !policy || now() < policy.announcedAt ? 'normal'
    : now() < policy.stopWritesAt ? 'announced' : now() < policy.takeoutUntil ? 'takeout'
      : now() < policy.statusUntil ? 'status-only' : 'closed';
  const canProcessEvidence = () => ['normal', 'announced'].includes(phase());
  const snapshot = () => ({ version: 1, endpoint: endpoint ?? policy?.endpoint, phase: phase(), checkedAt: now(),
    policy: policy ? structuredClone(policy) : null, businessWritesAccepted: canProcessEvidence(),
    downloadsAccepted: ['normal', 'announced', 'takeout'].includes(phase()),
    deletion: 'revocation is not physical deletion; follow the published deletion policy',
    validity: 'an unavailable status is not proof of validity or deletion', automaticMigration: false });
  function assertDownload() {
    if (['status-only', 'closed'].includes(phase())) throw new ServiceError('service_takeout_closed', 410);
  }
  function assertRoute(method, path) {
    const state = phase();
    if (['normal', 'announced'].includes(state) || metadata.has(`${method} ${path}`)) return;
    if (state === 'status-only' && method === 'GET' && proofStatus.test(path)) return;
    if (state === 'takeout' && serviceAccessV2(method,path)!==null) return;
    if (state === 'takeout' && (method === 'GET' && (['/.well-known/galaxy-network.json', '/v1/consents'].includes(path) || takeoutRead.test(path))
      || method === 'POST' && (takeoutPosts.has(path) || revocation.test(path) || moderationRead.test(path) || ownAttachmentExport.test(path)))) return;
    throw new ServiceError(state === 'takeout' ? 'service_writes_stopped' : 'service_retired', 410);
  }
  async function assertBindingSubject(db, subjectId) {
    assertDownload();
    if (phase() === 'takeout' && !(await db.query('SELECT 1 FROM subjects WHERE id=$1', [subjectId])).rows.length)
      throw new ServiceError('service_enrollment_stopped', 410);
  }
  return Object.freeze({ phase, snapshot, assertRoute, assertDownload, assertBindingSubject, canProcessEvidence,
    downloadDeadline: () => policy?.takeoutUntil ?? Number.POSITIVE_INFINITY });
}

export async function loadRetirementController(path, options) {
  if (!path) return createRetirementController(null, options);
  if (!isAbsolute(path)) throw new Error('Retirement file must be absolute');
  const info = await stat(path);
  if (!info.isFile() || info.size > 16384) throw new Error('Invalid retirement policy file');
  return createRetirementController(JSON.parse(await readFile(path, 'utf8')), options);
}
