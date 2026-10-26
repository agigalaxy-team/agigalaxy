import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { createOidcLoginProvider } from "./authentication/oidc-login.mjs";
import { digest } from "../shared/digest.mjs";

const text = max => z.string().min(1).max(max).refine(value => !/\p{Cc}/u.test(value));
const https = z.url().refine(value => { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.search; });
export const identityConfigurationSchema = z.strictObject({ version: z.literal(1), providers: z.array(z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), name: text(100), issuer: https, clientId: text(200),
  clientSecretEnv: z.string().regex(/^GALAXY_OIDC_[A-Z0-9_]{1,80}$/).optional(),
  allowedOrigins: z.array(https.refine(value => new URL(value).origin === value)).max(8).default([]),
})).max(8).refine(items => new Set(items.map(item => item.id)).size === items.length) });

// Explicit public configuration and per-provider secret references only. Never
// discover .env files or persist resolved credentials in runtime snapshots.
export async function loadIdentityProviders(path, { endpoint, env = process.env, factory = createOidcLoginProvider } = {}) {
  let configuration = { version: 1, providers: [] };
  if (path) {
    if (!isAbsolute(path)) throw new Error('Absolute identity configuration path required.');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32768) throw new Error('Invalid identity configuration file.');
    try { configuration = identityConfigurationSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
    catch { throw new Error('Invalid identity configuration.'); }
  }
  const providers = [];
  for (const item of configuration.providers) {
    const { clientSecretEnv, ...publicFields } = item;
    const clientSecret = clientSecretEnv ? env[clientSecretEnv] : undefined;
    if (clientSecretEnv && !text(4096).safeParse(clientSecret).success) throw new Error('Configured OIDC credential unavailable.');
    providers.push(await factory({ ...publicFields, clientSecret, redirectUri: `${endpoint}/v1/identity/callback/${item.id}` }));
  }
  return { providers, configurationHash: digest(JSON.stringify(configuration)) };
}
