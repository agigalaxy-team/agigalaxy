import { readFile,lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { digest } from '../../../shared/digest.mjs';
import { createOAuthIntrospection } from '../../../oauth-introspection.mjs';
import { createOAuthResourceAccess } from '../../../oauth-resource-access.mjs';
import { createPersonalMcpHandler } from './handler.mjs';

const text=max=>z.string().min(1).max(max).refine(value=>!/\p{Cc}/u.test(value));
export const personalMcpConfigurationSchema=z.strictObject({version:z.literal(1),providerId:z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  introspectionClientId:text(200),clientSecretEnv:z.string().regex(/^GALAXY_OAUTH_[A-Z0-9_]{1,80}$/),
  allowedClientIds:z.array(text(200)).min(1).max(64).refine(values=>new Set(values).size===values.length),
  allowedScopes:z.array(z.enum(['binding','consent','case-teaser','evidence','proof','history','assistance','context','notifications','capsules','builders','audit','data-export']))
    .min(1).max(13).refine(values=>values.includes('binding')&&new Set(values).size===values.length),
  allowedOrigins:z.array(z.url().refine(value=>{const url=new URL(value);return url.protocol==='https:'&&url.origin===value;})).max(8).default([]),
});

export async function loadPersonalMcp(path,{services,identityProviders,env=process.env}={}) {
  if(!path)return null;
  if(!isAbsolute(path))throw new Error('Absolute Personal MCP configuration path required.');
  const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768)throw new Error('Invalid Personal MCP configuration file.');
  let configuration;
  try { configuration=personalMcpConfigurationSchema.parse(JSON.parse(await readFile(path,'utf8'))); }
  catch { throw new Error('Invalid Personal MCP configuration.'); }
  const provider=identityProviders.find(item=>item.describe().id===configuration.providerId)?.describe();
  if(!provider)throw new Error('Personal MCP requires a configured OIDC identity provider.');
  const clientSecret=env[configuration.clientSecretEnv];
  if(!text(4096).safeParse(clientSecret).success)throw new Error('Personal MCP introspection credential unavailable.');
  const verifier=await createOAuthIntrospection({issuer:provider.issuer,resource:services.access.endpoint+'/mcp/personal',
    clientId:configuration.introspectionClientId,clientSecret,allowedClientIds:configuration.allowedClientIds,allowedOrigins:configuration.allowedOrigins});
  const authority=createOAuthResourceAccess(services.access,{verifier,provider,allowedScopes:configuration.allowedScopes});
  const handler=createPersonalMcpHandler({services,authority,verifier});
  return Object.freeze({...handler,configurationHash:digest(JSON.stringify(configuration))});
}
