import {z} from 'zod';
const text = max => z.string().min(1).max(max).refine(value => !/\p{Cc}/u.test(value));
const https = z.url().refine(value => { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.search; });
export const identityConfigurationSchema = z.strictObject({ version: z.literal(1), providers: z.array(z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), name: text(100), issuer: https, clientId: text(200),
  clientSecretEnv: z.string().regex(/^GALAXY_OIDC_[A-Z0-9_]{1,80}$/).optional(),
  allowedOrigins: z.array(https.refine(value => new URL(value).origin === value)).max(8).default([]),
})).max(8).refine(items => new Set(items.map(item => item.id)).size === items.length) });

