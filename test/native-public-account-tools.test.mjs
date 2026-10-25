import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserClient} from '../packages/galaxy-official/src/browser-client.mjs';
import {nativeHttpDefinitions} from '../packages/galaxy-edge-mcp/src/native-v2/tools/http.mjs';

const endpoint='https://official.example.test',accountId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',afterAccount='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',subjectId='GUID10'+'A'.repeat(26),afterSubject='GUID11'+'B'.repeat(26);
function fixture(){const requests=[],result={items:[{source:'external-issuer-statement',issuer:'https://issuer.example.test',status:'as-returned'}],nextAfter:null,checkedAt:2000000000};let signatures=0;
 const client=createBrowserClient({endpoint,trustedKeys:new Map([['test',{publicKeyPem:'unused-for-anonymous-read'}]]),sign:async()=>{signatures++;throw Error('anonymous_read_must_not_sign');},
  fetch:async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}});
 return {client,requests,result,signatures:()=>signatures};}

test('Native public account tools make exact anonymous GETs without local context and retain source data',async()=>{
 const f=fixture(),tools=nativeHttpDefinitions(f.client);
 const cases=[['galaxy_account_public_profile',{accountId},'/v1/account/public/'+accountId],
  ['galaxy_account_public_ids',{accountId,after:afterSubject,limit:50},'/v1/account/public/'+accountId+'/ids?after='+afterSubject+'&limit=50'],
  ['galaxy_account_public_credentials',{accountId,after:afterAccount},'/v1/account/public/'+accountId+'/credentials?after='+afterAccount+'&limit=20'],
  ['galaxy_account_public_posts',{accountId,after:'fp1.cHVibGlzaGVk',limit:50},'/v1/account/public/'+accountId+'/posts?after=fp1.cHVibGlzaGVk&limit=50'],
  ['galaxy_account_public_by_id',{subjectId,after:afterAccount,limit:1},'/v1/account/public/by-id/'+subjectId+'?after='+afterAccount+'&limit=1']];
 try{for(const [name,input,path]of cases){assert.equal(tools[name].write,false);assert.deepEqual(await tools[name].run(input),f.result);const sent=f.requests.at(-1);assert.equal(sent.url,endpoint+path);assert.equal(sent.options.method,'GET');assert.equal(sent.options.body,undefined);assert.equal(sent.options.credentials,'omit');assert.equal(sent.options.cache,'no-store');assert.equal(sent.options.referrerPolicy,'no-referrer');assert.equal(sent.options.headers.Authorization,undefined);assert.equal(sent.options.headers['X-Galaxy-Account-ID'],undefined);}
  assert.equal(f.client.snapshot(),null);assert.equal(f.signatures(),0);
  assert.throws(()=>tools.galaxy_account_public_ids.run({accountId,limit:51}));assert.throws(()=>tools.galaxy_account_public_ids.run({accountId,after:afterAccount}));
  assert.throws(()=>tools.galaxy_account_public_posts.run({accountId,after:afterAccount}));assert.throws(()=>tools.galaxy_account_public_posts.run({accountId,after:'fp1.'+'A'.repeat(509)}));
  assert.throws(()=>tools.galaxy_account_public_by_id.run({subjectId,localContext:'private text'}));assert.equal(f.requests.length,5);
 }finally{f.client.close();}
});

test('Public pagination permits only the four exact GET resources and typed bounded cursors',async()=>{
 const f=fixture();try{
  for(const path of ['/v1/account/public/'+accountId+'/ids?limit=20','/v1/account/public/'+accountId+'/credentials?limit=50','/v1/account/public/by-id/'+subjectId+'?after='+afterAccount,'/v1/account/public/'+accountId+'/posts?after=fp1.cHVibGlzaGVk&limit=50'])await f.client.call(path,undefined,{method:'GET',authenticated:false});
  for(const path of ['/v1/account/public/'+accountId+'?limit=20','/v1/account/public/'+accountId+'/ids?limit=51','/v1/account/public/'+accountId+'/ids?limit=0','/v1/account/public/'+accountId+'/ids?limit=20&limit=30','/v1/account/public/'+accountId+'/ids?after='+afterAccount,'/v1/account/public/'+accountId+'/credentials?after='+afterSubject,'/v1/account/public/'+accountId+'/posts?after='+afterAccount,'/v1/account/public/'+accountId+'/posts?limit=51','/v1/account/public/'+accountId+'/posts?localContext=private','/v1/account/public/by-id/'+subjectId+'?localContext=private','/v1/account/public/by-id/not-an-id?limit=20','/v1/account/private/'+accountId+'/ids?limit=20'])await assert.rejects(f.client.call(path,undefined,{method:'GET',authenticated:false}),/Invalid API path/);
  await assert.rejects(f.client.call('/v1/account/public/'+accountId+'/ids?limit=20',{}, {method:'POST',authenticated:false}),/Invalid API path/);assert.equal(f.requests.length,4);
 }finally{f.client.close();}
});
