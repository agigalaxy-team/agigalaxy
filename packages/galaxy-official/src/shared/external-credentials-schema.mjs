import {z} from 'zod';
import {ServiceError} from './service-error.mjs';

const text = max => z.string().trim().min(1).max(max).refine(value => !/\p{Cc}/u.test(value));
const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const uri = text(2048).refine(value => {try {const url=new URL(value);return !url.username&&!url.password;} catch {return false;}});
const https = uri.refine(value => {const url=new URL(value);return url.protocol==='https:'&&!url.hash&&!url.search;});
const publicJwk = z.record(z.string(),z.unknown()).superRefine((key,context) => {
  if(!['OKP','RSA','EC'].includes(key.kty)||typeof key.kid!=='string'||!key.kid||key.kid.length>200
    || Object.keys(key).some(field=>!['kty','crv','x','y','n','e','kid','alg','use','key_ops'].includes(field))
    || ['d','k','p','q','dp','dq','qi','oth'].some(field=>Object.hasOwn(key,field))
    || key.use!==undefined&&key.use!=='sig'
    || key.key_ops!==undefined&&(!Array.isArray(key.key_ops)||key.key_ops.some(operation=>operation!=='verify')))
    context.addIssue({code:'custom',message:'Public signature keys only'});
});
const condition = z.strictObject({id:identifier,label:text(160),type:text(256),claim:z.strictObject({
  path:z.string().min(1).max(512).refine(value=>value.startsWith('/credentialSubject/')&&!value.split('/').some(part=>['__proto__','prototype','constructor'].includes(part))),
  equals:z.union([text(2048),z.number().finite(),z.boolean()]),
}).optional()});
export const externalCredentialsConfigurationSchema=z.strictObject({version:z.literal(1),issuers:z.array(z.strictObject({
  id:identifier,name:text(160),issuer:uri,
  algorithms:z.array(z.enum(['EdDSA','Ed25519','RS256','PS256','ES256','ES384'])).min(1).max(6).default(['EdDSA','RS256','ES256']),
  keys:z.array(publicJwk).min(1).max(16).refine(keys=>new Set(keys.map(key=>key.kid)).size===keys.length),
  formats:z.array(z.enum(['vc-jwt-1.1','vc+jwt-2.0'])).min(1).max(2).default(['vc-jwt-1.1','vc+jwt-2.0']),
  subjectBinding:z.strictObject({kind:z.literal('verified-external-account'),accountIssuer:uri}).optional(),
  revocation:z.strictObject({kind:z.literal('signed-list'),url:https,maxAgeSeconds:z.number().int().min(10).max(3600).default(300)}).optional(),
  conditions:z.array(condition).max(32).default([]).refine(items=>new Set(items.map(item=>item.id)).size===items.length),
})).max(32).refine(items=>new Set(items.map(item=>item.id)).size===items.length&&new Set(items.map(item=>item.issuer)).size===items.length)});

export const externalCredentialImportSchema=z.strictObject({credential:z.string().min(16).max(174764).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)});
export const externalCredentialListSchema=z.strictObject({after:z.uuid().optional()});
export const externalCredentialPublicListSchema=z.strictObject({after:z.uuid().optional(),limit:z.number().int().min(1).max(50).default(20)});
export const externalCredentialIdSchema=z.uuid();
export function parseExternalCredentialInput(schema,input){const parsed=schema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_external_credential_input');return parsed.data;}
