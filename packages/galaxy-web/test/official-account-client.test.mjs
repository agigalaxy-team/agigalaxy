import test from 'node:test';
import assert from 'node:assert/strict';
import {createOfficialAccountClient} from '../src/official-account-client.mjs';

const endpoint='https://official.example.org',website='https://galaxy.example.org',now=()=>1800000000;
const subjectId='GUID15'+'0'.repeat(26);
const signedIn=()=>({state:'signed-in',account:{displayName:'隔离账户',email:null,emailVerified:false},linkedIds:[{subjectId,linkedAt:'2026-10-15T00:00:00.000Z'}],nextAfter:null,expiresAt:now()+3600,csrfToken:'isolated-csrf-value',galaxyAuthorization:false});
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});

test('official session reads and pagination use only the deployed authority and credentialed transport',async()=>{
 const requests=[],client=createOfficialAccountClient({endpoint,website,now,fetch:async(url,options)=>{requests.push({url,options});return response(signedIn());}});
 const current=await client.session(),page=await client.session({after:subjectId});
 assert.equal(current.galaxyAuthorization,false);assert.equal(current.linkedIds[0].subjectId,subjectId);assert.equal(page.account.displayName,'隔离账户');
 assert.deepEqual(requests.map(item=>item.url),[endpoint+'/v1/account/session',endpoint+'/v1/account/session?after='+subjectId]);
 assert.equal(requests.every(item=>item.options.credentials==='include'&&item.options.redirect==='error'&&item.options.cache==='no-store'),true);
});

test('login preserves a same-site application target and rejects external or recursive-looking targets',()=>{
 const client=createOfficialAccountClient({endpoint,website,now});
 const url=new URL(client.loginUrl('register','/app/settings/identity?section=account'));
 assert.equal(url.origin,endpoint);assert.equal(url.searchParams.get('returnTo'),'/app/settings/identity?section=account');assert.equal(url.searchParams.get('mode'),'register');
 for(const target of ['//other.example/app','https://other.example/app','/app-elsewhere','/app/\\elsewhere','/app/\nnext'])assert.equal(new URL(client.loginUrl('login',target)).searchParams.get('returnTo'),'/app/account');
});

test('account logout sends the returned CSRF value and does not authorize a Galaxy ID',async()=>{
 let request;const client=createOfficialAccountClient({endpoint,website,now,fetch:async(url,options)=>{request={url,options};return response({state:'signed-out',galaxyAuthorization:false});}});
 const result=await client.logout(signedIn());
 assert.equal(request.url,endpoint+'/v1/account/logout');assert.equal(request.options.credentials,'include');assert.equal(request.options.headers['X-Galaxy-Account-CSRF'],signedIn().csrfToken);
 assert.equal(request.options.body,'{}');assert.equal(result.state,'signed-out');assert.equal(result.galaxyAuthorization,false);
});

test('malformed, expired, and authority-expanding session responses are hidden instead of granting identity access',async()=>{
 const bad=[{...signedIn(),galaxyAuthorization:true},{...signedIn(),expiresAt:now()},{...signedIn(),linkedIds:[...signedIn().linkedIds,...signedIn().linkedIds]},{...signedIn(),linkedIds:[{subjectId:'another-id',linkedAt:'today'}]}];
 for(const value of bad){const client=createOfficialAccountClient({endpoint,website,now,fetch:async()=>response(value)});await assert.rejects(client.session(),{code:'official_account_response_invalid'});}
});
