import assert from 'node:assert/strict';

// Real isolated OIDC, Cookie and production HTTP. No subject is created for this account.
export async function accountFollowBrowser(f,name){
  const cookies=new Map(),accept=response=>{for(const item of response.headers.getSetCookie()){const pair=item.split(';')[0];cookies.set(pair.split('=')[0],pair);}};
  const cookie=()=>[...cookies.values()].join('; ');
  f.issuer.setAccount(name);
  const started=await fetch(f.origin+'/v1/account/login',{redirect:'manual'});accept(started);assert.equal(started.status,303);
  const returned=await f.issuer.authorize(started.headers.get('location'));
  const callback=await fetch(f.origin+returned.pathname+returned.search,{redirect:'manual',headers:{Cookie:cookie()}});accept(callback);assert.equal(callback.status,303);
  const session=await(await fetch(f.origin+'/v1/account/session',{headers:{Cookie:cookie(),Origin:f.website}})).json();
  assert.equal(session.state,'signed-in');assert.ok(session.account.id);
  async function request(action,input,headers={}){
    const response=await fetch(f.origin+'/v1/account/follows/'+action,{method:'POST',headers:{Cookie:cookie(),Origin:f.website,'Content-Type':'application/json',
      'X-Galaxy-Account-ID':session.account.id,'X-Galaxy-Account-CSRF':session.csrfToken,...headers},body:JSON.stringify(input)});
    return {status:response.status,body:await response.json()};
  }
  return {session,request,async ok(action,input){const result=await request(action,input);assert.equal(result.status,200,JSON.stringify(result.body));return result.body;}};
}
