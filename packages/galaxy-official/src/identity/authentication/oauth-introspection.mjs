import * as oidc from 'openid-client';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ServiceError } from "../../shared/service-error.mjs";

const text = max => z.string().min(1).max(max).refine(value => !/\p{Cc}/u.test(value));
const claimsSchema = z.object({ active: z.literal(true), sub: text(255), client_id: text(200),
  exp: z.number().int().positive(), scope: z.string().min(1).max(4096), aud: z.union([z.string(),z.array(z.string()).min(1).max(8)]),
  iss: z.string().optional(), token_type: z.string().optional() });
const invalid = () => new OAuthError(OAuthErrorCode.InvalidToken, 'Access token is invalid or inactive.');

// The configured AS performs RFC 7662 introspection, including token revocation.
// No resource token is parsed as a Galaxy bearer or reused with a downstream API.
export async function createOAuthIntrospection({ issuer, resource, clientId, clientSecret, allowedClientIds, allowedOrigins = [],
  allowLoopbackHttp = false, now = () => Math.floor(Date.now()/1000), fetch: transport = globalThis.fetch }) {
  const endpoint = value => {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search || url.protocol !== 'https:'
      && !(allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('HTTPS authorization endpoint required.');
    return url;
  };
  const authority = endpoint(issuer); endpoint(resource);
  text(200).parse(clientId);text(4096).parse(clientSecret);
  z.array(text(200)).min(1).max(64).parse(allowedClientIds);
  const allowedClients = new Set(allowedClientIds);
  const origins = new Set([authority.origin,...z.array(z.string()).max(8).parse(allowedOrigins).map(value=>{
    const url=endpoint(value);if(url.origin!==value)throw new Error('Exact authorization transport origin required.');return value;
  })]);
  const checkedFetch=async(input,options)=>{
    const target=new URL(input);
    if(target.username||target.password||target.hash||!origins.has(target.origin))throw new Error('Authorization transport origin unavailable.');
    const response=await transport(input,{...options,redirect:'error',signal:options?.signal?AbortSignal.any([options.signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)});
    const chunks=[];let size=0;
    if(response.body){const reader=response.body.getReader();try{for(;;){const {value,done}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>262144){await reader.cancel();throw new Error('Authorization response exceeds limit.');}chunks.push(value);
    }}finally{reader.releaseLock();}}
    return new Response(chunks.length?Buffer.concat(chunks):null,{status:response.status,headers:response.headers});
  };
  let configuration;
  try {
    configuration=await oidc.discovery(authority,clientId,{token_endpoint_auth_method:'client_secret_basic'},oidc.ClientSecretBasic(clientSecret),{
      [oidc.customFetch]:checkedFetch,timeout:5,
      // eslint-disable-next-line typescript/no-deprecated -- Explicit literal-loopback AS fixtures; production configuration rejects HTTP.
      execute:allowLoopbackHttp?[oidc.allowInsecureRequests]:[],
    });
    const metadata=configuration.serverMetadata();
    if(metadata.issuer!==issuer||!metadata.code_challenge_methods_supported?.includes('S256')||!metadata.introspection_endpoint)throw new Error();
    for(const field of ['authorization_endpoint','token_endpoint','introspection_endpoint'])if(!origins.has(endpoint(metadata[field]).origin))throw new Error();
  } catch { throw new Error('OAuth authorization server discovery failed.'); }
  const metadata=Object.freeze({...configuration.serverMetadata()});
  return Object.freeze({ metadata:()=>metadata, resource, async verify(token) {
    if(typeof token!=='string'||token.length<1||token.length>16384||!/^[\x21-\x7e]+$/.test(token))throw invalid();
    let raw;
    try{raw=await oidc.tokenIntrospection(configuration,token,{token_type_hint:'access_token'});}
    catch{throw new ServiceError('oauth_introspection_unavailable',503);}
    const parsed=claimsSchema.safeParse(raw);
    if(!parsed.success)throw invalid();
    const claims=parsed.data,audiences=Array.isArray(claims.aud)?claims.aud:[claims.aud];
    if(claims.exp<=now()||claims.iss!==undefined&&claims.iss!==issuer||!audiences.includes(resource)
      ||!allowedClients.has(claims.client_id)||claims.token_type!==undefined&&claims.token_type.toLowerCase()!=='bearer')throw invalid();
    const scopes=claims.scope.split(' ');
    if(scopes.length>64||scopes.some(scope=>!/^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/.test(scope))||new Set(scopes).size!==scopes.length)throw invalid();
    return Object.freeze({issuer,subject:claims.sub,clientId:claims.client_id,expiresAt:claims.exp,resource,scopes:Object.freeze(scopes)});
  }});
}
