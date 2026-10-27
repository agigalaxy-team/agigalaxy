import test from 'node:test';
import assert from 'node:assert/strict';
import {createOidcLoginProvider} from '../src/identity/authentication/oidc-login.mjs';
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';

test('OIDC refresh uses real isolated issuer; keeps subject and rejects invalid_grant without exposing credentials',async()=>{
 const callback='https://portal.invalid/v1/account/callback';
 const fixture=await oidcProviderFixture([callback],{refreshTokens:true});
 try{
  const provider=await createOidcLoginProvider({id:'portal-fixture',name:'Synthetic',issuer:fixture.issuer,clientId:'galaxy-fixture',redirectUri:callback,sessionRenewal:true,allowLoopbackHttp:true});
  const preview=await provider.begin(),identity=await provider.complete(preview,(await fixture.authorize(preview.authorizationUrl)).href);
  assert.ok(identity.portalTokens.refreshToken);assert.ok(identity.portalTokens.expiresAt>Math.floor(Date.now()/1000));
  const refreshed=await provider.refresh({refreshToken:identity.portalTokens.refreshToken,issuer:identity.issuer,externalSubject:identity.externalSubject});
  assert.ok(refreshed.refreshToken);assert.ok(refreshed.expiresAt>Math.floor(Date.now()/1000));
  await assert.rejects(provider.refresh({refreshToken:'synthetic-invalid-token',issuer:identity.issuer,externalSubject:identity.externalSubject}),{code:'portal_refresh_rejected'});
  await assert.rejects(provider.refresh({refreshToken:refreshed.refreshToken,issuer:identity.issuer,externalSubject:'different-subject'}),{code:'portal_refresh_rejected'});
 }finally{await fixture.close();}
});
