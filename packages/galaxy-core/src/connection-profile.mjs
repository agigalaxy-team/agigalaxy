import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { withLocalWrite, withLocalRead } from './storage/write-lock.mjs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { resolveDataDir, getGalaxyIntegrationStatus } from './local-store.mjs';
import { DEFAULT_MODULE_IDS } from './integration-modules.mjs';

export const CONNECTION_PROFILE_FILE = 'galaxy-connection-profile.json';
const text = z.string().trim().min(1).max(240);
const timestamp = z.iso.datetime();
const endpoint = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, 'Endpoint must be HTTPS without credentials, query or fragment.');
const targetSchema = z.strictObject({ id: text, kind: z.enum(['official', 'hub']), endpoint });
const scopeSchema = z.strictObject({
  id: text,
  targetId: text,
  action: z.enum(['binding', 'proof', 'case-teaser', 'history', 'context']),
  recipient: text,
  purpose: text,
  visibleFields: z.array(text).min(1).max(32),
  expiresAt: timestamp,
  revokedAt: timestamp.nullable().default(null),
});
const profileSchema = z.strictObject({
  version: z.literal(1),
  capabilityProfile: z.literal('l3-foundation'),
  targets: z.array(targetSchema).max(32),
  scopes: z.array(scopeSchema).max(128),
  audit: z.array(z.strictObject({
    at: timestamp, action: z.enum(['profile-created', 'scope-revoked']), scopeId: text.optional(),
  })).max(256),
});

export function validateConnectionProfile(input) {
  const profile = profileSchema.parse(input);
  for (const collection of [profile.targets, profile.scopes]) {
    if (new Set(collection.map((item) => item.id)).size !== collection.length) throw new Error('Duplicate identifier.');
  }
  if (profile.targets.filter((target) => target.kind === 'official').length > 1) throw new Error('Only one Official target is allowed.');
  for (const scope of profile.scopes) {
    if (!profile.targets.some((target) => target.id === scope.targetId)) throw new Error('Scope target does not exist.');
  }
  return profile;
}

// These are local intentions, never network grants or evidence of a binding.
export function createConnectionProfile({ targets = [], scopes = [] } = {}, at = new Date().toISOString()) {
  return validateConnectionProfile({
    version: 1, capabilityProfile: 'l3-foundation', targets, scopes,
    audit: [{ at, action: 'profile-created' }],
  });
}

export function revokeConnectionScope(input, scopeId, at = new Date().toISOString()) {
  timestamp.parse(at);
  const profile = validateConnectionProfile(input);
  const scope = profile.scopes.find((item) => item.id === scopeId);
  if (!scope) throw new Error('Unknown scope.');
  if (!scope.revokedAt) {
    scope.revokedAt = at;
    profile.audit.push({ at, action: 'scope-revoked', scopeId });
  }
  return validateConnectionProfile(profile);
}

export function getGalaxyConnectionContract(input = null, { at = new Date().toISOString(), enabledModuleIds = [] } = {}) {
  timestamp.parse(at);
  const profile = input === null ? null : validateConnectionProfile(input);
  return {
    type: 'GalaxyConnectionContract', version: '0.2-local-contract',
    capabilityProfile: 'l3-foundation', recommended: true,
    selectionState: profile ? 'local-intent-saved' : 'not-applied',
    includedModuleIds: [...DEFAULT_MODULE_IDS],
    enabledModuleIds: DEFAULT_MODULE_IDS.filter((id) => enabledModuleIds.includes(id)),
    state: 'not-connected', localOnly: true, remoteEffects: 'none',
    message: profile?.targets.length
      ? '已保存本地端点配置；未验证、未连接。'
      : '基础网络接入框架已准备；远程端点尚未配置，未连接。',
    targets: (profile?.targets ?? []).map((target) => ({
      ...target, state: 'configured-unverified', manifest: { state: 'not-fetched' }, binding: { state: 'not-bound' },
    })),
    scopes: (profile?.scopes ?? []).map((scope) => ({
      ...scope,
      state: scope.revokedAt ? 'revoked' : Date.parse(scope.expiresAt) <= Date.parse(at) ? 'expired' : 'proposed',
      authorized: false,
    })),
    audit: profile?.audit ?? [],
    bindingPreview: null,
    blockedActions: ['manifest-fetch', 'binding', 'publish', 'history-query', 'context-transfer'],
    requiredBeforeBinding: ['remote-authorization', 'verified-manifest', 'visible-scope', 'final-confirmation', 'audience-bound-signed-challenge', 'server-api-schema-audit-drill'],
  };
}

export async function readConnectionProfile(dataDirectory) {
  try {
    return validateConnectionProfile(JSON.parse(await readFile(join(resolveDataDir(dataDirectory), CONNECTION_PROFILE_FILE), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Internal replacement API, serialized with Core writers. No MCP mutation is exposed.
export async function saveConnectionProfile(dataDirectory, input) {
  const profile = validateConnectionProfile(input);
  return withLocalWrite(dataDirectory, async directory => {
  const temporary = join(directory, `${CONNECTION_PROFILE_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, CONNECTION_PROFILE_FILE));
  } finally { await rm(temporary, { force: true }); }
  return profile;
  });
}

export async function getGalaxyConnectionStatus(dataDirectory) {
  return withLocalRead(dataDirectory, async () => {
  const [profile, status] = await Promise.all([readConnectionProfile(dataDirectory), getGalaxyIntegrationStatus(dataDirectory)]);
  return {
    ...getGalaxyConnectionContract(profile ?? status.integration?.connectionProfile ?? null, { enabledModuleIds: (status.integration?.modules ?? []).map((item) => item.id) }),
    appliedCapabilityProfile: status.integration?.capabilityProfile ?? null,
    ...(status.recoveryRequired ? { state: 'recovery-required', recoveryRequired: true } : {}),
  };
  });
}
