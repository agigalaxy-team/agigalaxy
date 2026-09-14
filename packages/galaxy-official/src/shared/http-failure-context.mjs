import { z } from 'zod';
const scope=z.string().regex(/^[a-z][a-z-]{0,63}$/);
const scopes=z.array(scope).min(1).max(64).refine(value=>new Set(value).size===value.length);
const legacyAuthenticationSchema=z.object({
  version:z.literal(1),clientId:z.uuid(),audience:z.url(),scope,
  bindingScopes:scopes,credentialScopes:scopes,
}).strict().refine(value=>value.credentialScopes.includes(value.scope));
const oauthAuthenticationSchema=z.object({version:z.literal(2),profile:z.literal('oauth-resource'),endpoint:z.url(),
  clientId:z.string().min(1).max(200).refine(value=>! /\p{Cc}/u.test(value)),audience:z.url(),scope,
  bindingScopes:scopes,credentialScopes:scopes,
}).strict().refine(value=>value.credentialScopes.includes(value.scope)&&value.audience===value.endpoint+'/mcp/personal');
export const failureAuthenticationSchema=z.union([legacyAuthenticationSchema,oauthAuthenticationSchema]);
export const failureActorSchema=z.object({
  subjectId:z.string().regex(/^GUID[0-9A-Z]{28}$/),bindingId:z.uuid(),
  authentication:failureAuthenticationSchema.optional(),
}).strict();
// Select public fields only; a caller may also hold a credential hash or request.
export function failureActor(actor){
  if(!actor)return null;
  const selected={subjectId:actor.subjectId,bindingId:actor.bindingId},snapshot=actor.authentication;
  if(snapshot)selected.authentication={
    version:snapshot.version,clientId:snapshot.clientId,audience:snapshot.audience,scope:snapshot.scope,
    bindingScopes:snapshot.bindingScopes,credentialScopes:snapshot.credentialScopes,
    ...(snapshot.version===2?{profile:snapshot.profile,endpoint:snapshot.endpoint}:{}),
  };
  return failureActorSchema.parse(selected);
}
