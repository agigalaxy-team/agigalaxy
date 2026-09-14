import { randomUUID } from 'node:crypto';

// Local-key and backup tests use this identity-provider double. Actual OIDC
// discovery/code/PKCE/ID Token verification is covered by oidc-provider-fixture.
export function syntheticIdentityProvider(endpoint, now) {
  const description = { id:'fixture',name:'Synthetic identity',issuer:'https://login.example.org',clientId:'synthetic-client',
    redirectUri:endpoint+'/v1/identity/callback/fixture',protocol:'openid-connect',grant:'authorization_code',pkce:'S256',loginLifetimeSeconds:300 };
  return { describe:()=>description, begin:async()=>({ ...description,loginId:randomUUID(),expiresAt:now+300,
    authorizationUrl:description.issuer+'/authorize?'+new URLSearchParams({redirect_uri:description.redirectUri,client_id:description.clientId,
      scope:'openid',response_type:'code',code_challenge_method:'S256',code_challenge:'synthetic-challenge',nonce:randomUUID(),state:randomUUID()}) }),
  complete:async()=>({issuer:description.issuer,externalSubject:'synthetic-host-account',clientId:description.clientId,verifiedAt:now,expiresAt:now+300,
    authentication:'oidc-authorization-code-pkce-s256-id-token-signature'}),cancel:()=>{} };
}
export function syntheticIdentityCallback(login) {
  return login.redirectUri+'?'+new URLSearchParams({state:new URL(login.authorizationUrl).searchParams.get('state'),code:'synthetic-code'});
}
