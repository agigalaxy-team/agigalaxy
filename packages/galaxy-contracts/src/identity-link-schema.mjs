import { z } from 'zod';
const text = max => z.string().min(1).max(max).refine(value => !/\p{Cc}/u.test(value));
const providerId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const subjectId = z.string().regex(/^GUID[0-9A-Z]{28}$/);
const time = z.number().int().nonnegative();
export const identityProviderSchema = z.strictObject({ id: providerId, name: text(100), issuer: z.url(), clientId: text(200),
  redirectUri: z.url(), protocol: z.literal('openid-connect'), grant: z.literal('authorization_code'), pkce: z.literal('S256'),
  loginLifetimeSeconds: z.literal(300) });
export const identityIntentSchema = z.strictObject({ version: z.literal(1), id: z.uuid(), action: z.literal('identity.link'),
  subjectId, bindingId: z.uuid(), endpoint: z.url(), providerId, issuer: z.url(), externalSubject: text(255), clientId: text(200),
  authentication: z.literal('oidc-authorization-code-pkce-s256-id-token-signature'), verifiedAt: time, issuedAt: time, expiresAt: time,
  galaxyAuthorization: z.literal(false) }).refine(value => value.verifiedAt <= value.issuedAt && value.issuedAt < value.expiresAt && value.expiresAt - value.issuedAt <= 300);
export const identityItemSchema = z.strictObject({ id: z.uuid(), subjectId, bindingId: z.uuid(), endpoint: z.url(), providerId,
  issuer: z.url(), externalSubject: text(255), clientId: text(200), createdAt: z.iso.datetime(), revokedAt: z.iso.datetime().nullable(),
  state: z.enum(['linked','revoked','binding-inactive','provider-unavailable']), galaxyAuthorization: z.literal(false) });
export const identityPageSchema = z.strictObject({ subjectId, endpoint: z.url(), items: z.array(identityItemSchema).max(100), nextAfter: z.uuid().nullable() });
