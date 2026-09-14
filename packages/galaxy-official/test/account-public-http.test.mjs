import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { oidcProviderFixture } from './oidc-provider-fixture.mjs';
import { createOidcLoginProvider } from '../src/oidc-login.mjs';
import { createApi } from '../src/http.mjs';

// Synthetic accounts, real independent OIDC code/PKCE/JWS, signed Galaxy
// associations, HTTP Task service and durable account quotas. No quota stub.
test('verified OIDC association enables public Tasks; two GUIDs share quota and private work remains possible', {timeout:60000}, async () => {
  const endpoint='https://official.example.org', now=Math.floor(Date.now()/1000);
  const issuer=await oidcProviderFixture([endpoint+'/v1/identity/callback/fixture'],{emailVerified:true});
  let f,api;
  try {
    const provider=await createOidcLoginProvider({id:'fixture',name:'Synthetic OIDC',issuer:issuer.issuer,
      clientId:'galaxy-fixture',redirectUri:endpoint+'/v1/identity/callback/fixture',allowLoopbackHttp:true,now:()=>now});
    const options={now,identityProviders:[provider],syntheticCommunityQuota:false};
    const scopes=['binding','consent','case-teaser','assistance'];
    f=await serviceFixture(scopes,null,options);
    const second=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false});
    api=createApi({...f,rateLimit:200,failureAudit:async()=> 'stored'});
    await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+api.address().port;
    const post=async(path,body={},who=f)=>{
      const response=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',
        authorization:'Bearer '+who.credential},body:JSON.stringify(body)});
      return {status:response.status,value:await response.json(),retryAfter:response.headers.get('retry-after')};
    };
    const ok=result=>{assert.equal(result.status,200,JSON.stringify(result.value));return result.value;};
    const task=async(who,visibility='Public')=>{
      const payload={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',
        workContext:{goal:'Review parser behavior',currentSituation:'Working implementation; no failed attempt',attemptRefs:[]},
        title:'Review parser boundary',summary:'Diagnosis and review requested',visibility,
        collaboration:'open-assistance',enrollmentExpiresAt:now+3600};
      const grant=await who.authorize(payload,'assistance.publish',{objectId:payload.operationId,visibility,
        purpose:visibility==='Public'?'public-profile':'operational'});
      return {payload,grant};
    };
    const login=async(who)=>{
      const started=ok(await post('/v1/identity/begin',{providerId:'fixture'},who));
      const callback=await issuer.authorize(started.authorizationUrl);
      const response=await fetch(origin+callback.pathname+callback.search);
      assert.equal(response.status,200);
      assert.equal((await response.json()).state,'awaiting-local-signature');
      assert.equal(ok(await post('/v2/account/quotas',{},who)).accountVerified,false,'external login alone is not Galaxy association');
      const pending=ok(await post('/v1/identity/status',{id:started.loginId},who));
      ok(await post('/v1/identity/confirm',{id:started.loginId,
        signed:await who.signForTest(pending.payloadJson,'galaxy-identity-link+jws')},who));
      return started.loginId;
    };
    const blocked=await task(f);
    assert.equal((await post('/v2/tasks',blocked.grant)).status,403);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,0);
    const privateBefore=await task(f,'Private');ok(await post('/v2/tasks',privateBefore.grant));
    const link=await login(f);await login(second);
    const firstQuota=ok(await post('/v2/account/quotas'));
    assert.equal(firstQuota.accountVerified,true);
    assert.equal(firstQuota.accountId,ok(await post('/v2/account/quotas',{},second)).accountId);
    assert.ok(!JSON.stringify(firstQuota).includes('synthetic-oidc-subject'));
    const first=ok(await post('/v2/tasks',blocked.grant));assert.equal(first.caseId,null);
    const secondTask=await task(second);ok(await post('/v2/tasks',secondTask.grant,second));
    ok(await post('/v2/tasks',blocked.grant)); // exact replay never consumes again
    const overflow=await task(f),limited=await post('/v2/tasks',overflow.grant);
    assert.equal(limited.status,429);assert.equal(limited.value.error,'community_quota_exceeded');
    assert.equal(limited.value.quota.used,2);assert.equal(limited.value.quota.limit,2);
    assert.ok(Number(limited.retryAfter)>0);
    const privateAfter=await task(f,'Private');ok(await post('/v2/tasks',privateAfter.grant));
    assert.equal((await f.db.query('SELECT count(*)::int n FROM cases')).rows[0].n,0,'proactive Task needs no fabricated Case');
    const publicPage=await fetch(origin+'/v2/tasks');assert.equal((await publicPage.json()).items.length,2);
    ok(await post('/v1/identity/revoke',{id:link}));
    assert.equal(ok(await post('/v2/account/quotas')).accountVerified,false);
    assert.equal(ok(await post('/v2/account/quotas',{},second)).accountVerified,true);
    assert.deepEqual(issuer.failures,[]);
  } finally {
    if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}
    if(f)await f.db.close();
    await issuer.close();
  }
});
