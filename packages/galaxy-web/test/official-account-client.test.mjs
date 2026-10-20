import test from 'node:test';
import assert from 'node:assert/strict';
import {createOfficialAccountClient} from '../src/official-account-client.mjs';

const endpoint='https://official.example.org',website='https://galaxy.example.org',now=()=>1800000000;
const subjectId='GUID15'+'0'.repeat(26);
const signedIn=()=>({state:'signed-in',account:{displayName:'隔离账户',email:null,emailVerified:false},linkedIds:[{subjectId,linkedAt:'2026-10-15T00:00:00.000Z'}],nextAfter:null,expiresAt:now()+3600,csrfToken:'isolated-csrf-value',galaxyAuthorization:false});
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});

test('public account posts continue the exact opaque cursor without sending a session or identity',async()=>{
 const id='8cc1659c-4d6f-46bb-8313-73bb6e461120',cursor='fp1.cHVibGlzaGVkX3Bvc2l0aW9u',requests=[];
 const client=createOfficialAccountClient({endpoint,website,now,fetch:async(url,options)=>{requests.push({url,options});return response({items:[],nextAfter:null,checkedAt:now()});}});
 await client.publicPosts(id,{after:cursor,limit:20});
 const request=requests[0],url=new URL(request.url);
 assert.equal(url.pathname,'/v1/account/public/'+id+'/posts');assert.equal(url.searchParams.get('after'),cursor);
 assert.equal(request.options.credentials,'omit');assert.equal(request.options.headers.Authorization,undefined);assert.equal(request.options.headers['X-Galaxy-Account-ID'],undefined);
 for(const page of [{limit:0},{limit:51},{after:''},{after:'fp1.'+'A'.repeat(509)},{after:id}])await assert.rejects(client.publicPosts(id,page),{code:'official_account_request_invalid'});
 assert.equal(requests.length,1);
});

test('official session reads and pagination use only the deployed authority and credentialed transport',async()=>{
 const requests=[],client=createOfficialAccountClient({endpoint,website,now,fetch:async(url,options)=>{requests.push({url,options});return response(signedIn());}});
 const current=await client.session(),page=await client.session({after:subjectId});
 assert.equal(current.galaxyAuthorization,false);assert.equal(current.linkedIds[0].subjectId,subjectId);assert.equal(page.account.displayName,'隔离账户');
 assert.deepEqual(requests.map(item=>item.url),[endpoint+'/v1/account/session',endpoint+'/v1/account/session?after='+subjectId]);
 assert.equal(requests.every(item=>item.options.credentials==='include'&&item.options.redirect==='error'&&item.options.cache==='no-store'),true);
});

test('account UID is retained independently of the editable username and may be absent in an older response',async()=>{
 const value=signedIn(),client=createOfficialAccountClient({endpoint,website,now,fetch:async()=>response(value)});
 assert.equal((await client.session()).account.uid,null);
 value.account.uid='A7C4E2G8J6L3';
 assert.equal((await client.session()).account.uid,value.account.uid);
 value.account.displayName='新的用户名';
 const renamed=await client.session();
 assert.equal(renamed.account.displayName,'新的用户名');assert.equal(renamed.account.uid,'A7C4E2G8J6L3');
 for(const uid of ['not a uid','123456789012','ABCDEFGHIJKL','A1234','A1234567890123456']){
  value.account.uid=uid;await assert.rejects(client.session(),{code:'official_account_response_invalid'});
 }
});

test('exact UID lookup uses the public account endpoint without Cookie or identity authority',async()=>{
 const requests=[],client=createOfficialAccountClient({endpoint,website,now,fetch:async(url,options)=>{requests.push({url,options});return response({accountId:'8cc1659c-4d6f-46bb-8313-73bb6e461120',uid:'A7C4E2G8J6L3',displayName:'新的用户名'});}});
 const account=await client.publicAccountByUid('a7c4e2g8j6l3');
 assert.equal(requests[0].url,endpoint+'/v1/account/public/by-uid/A7C4E2G8J6L3');
 assert.equal(requests[0].options.credentials,'omit');assert.equal(requests[0].options.headers.Authorization,undefined);
 assert.equal(account.uid,'A7C4E2G8J6L3');assert.equal(account.displayName,'新的用户名');
 await assert.rejects(client.publicAccountByUid('name@example.org'),{code:'official_account_request_invalid'});
 assert.equal(requests.length,1);
});

test('login preserves a same-site application target and rejects external or recursive-looking targets',()=>{
 const client=createOfficialAccountClient({endpoint,website,now});
 const url=new URL(client.loginUrl('register','/app/settings/identity?section=account'));
 assert.equal(new URL(client.loginUrl('login','/app/community?compose=post&accountLogin=failed#draft')).searchParams.get('returnTo'),'/app/community?compose=post#draft','a retry does not carry an old failure into a successful return');
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
