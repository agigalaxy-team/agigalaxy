import test from 'node:test';
import assert from 'node:assert/strict';
import {operatorCookies,operatorForwardedAddress} from '../src/lib/environment.mjs';
import {operationsProxyPolicy,operationsProxyRequestPolicy} from '../src/lib/proxy-policy.mjs';
import {isAdminWrite} from '../src/lib/request-origin.mjs';
import {publishedSnapshot,safeHref,safePagePath} from '../src/lib/content-model.mjs';
import {readOperatorSession} from '../src/lib/operations.mjs';

const publicOrigin='https://admin.example.invalid',bffOrigin='https://api.example.invalid';
const policy=(path,method,values={})=>operationsProxyPolicy({url:publicOrigin+path,method,headers:new Headers(values),publicOrigin});
test('ordinary account cookies never become operator authority',async()=>{
  const headers=new Headers({cookie:'galaxy-account-fixture=ordinary; __Host-galaxy-account=ordinary'});
  assert.equal(operatorCookies(headers,true),'');
  const session=await readOperatorSession(headers,{environment:{publicOrigin,bffOrigin,fixtureCookies:false},fetcher:async()=>{throw Error('must not request');}});
  assert.deepEqual(session,{state:'signed-out'});
  assert.equal(operatorCookies(new Headers({cookie:'__Host-galaxy-operator=opaque-value; ordinary=sensitive'})),'__Host-galaxy-operator=opaque-value');
  assert.equal(operatorCookies(new Headers({cookie:'__Host-galaxy-operator-login=pending-value; ordinary=sensitive'})),'__Host-galaxy-operator-login=pending-value');
});
test('browser proxy preserves callback navigation without manufacturing origin proof',()=>{
  assert.equal(policy('/v1/operations/users','GET',{'sec-fetch-site':'same-origin'}).forwardOrigin,publicOrigin);
  assert.equal(policy('/v1/operations/users','GET',{'sec-fetch-site':'same-site'}).allowed,false);
  assert.equal(policy('/v1/operations/users','GET',{origin:'https://unrelated.example.invalid'}).allowed,false);
  const callback=policy('/v1/operations/callback','GET',{'sec-fetch-site':'cross-site'});
  assert.equal(callback.allowed,true);assert.equal(callback.forwardOrigin,null);
  assert.equal(policy('/v1/operations/logout','POST',{'sec-fetch-site':'same-origin'}).allowed,false);
  assert.equal(policy('/v1/operations/logout','POST',{origin:publicOrigin}).allowed,true);
  assert.equal(policy('/v1/operations/anything','GET',{origin:publicOrigin}).allowed,false);
  assert.equal(isAdminWrite(new Headers({origin:'https://unrelated.example.invalid'}),publicOrigin),false);
  assert.equal(isAdminWrite(new Headers(),publicOrigin),false);
});
test('export excludes drafts and blocks executable links or unsupported release metadata',()=>{
  const settings={_status:'published',siteTitle:'银河',footerLinks:[]};
  const page={id:'page',_status:'published',path:'/about/',title:'关于',blocks:[{blockType:'prose',body:'实际内容'}],updatedAt:'2026-10-20T00:00:00Z'};
  const snapshot=publishedSnapshot({settings,pages:[page],media:[]});
  assert.equal(snapshot.version,1);assert.equal(snapshot.pages[0].blocks[0].body,'实际内容');
  assert.throws(()=>publishedSnapshot({settings,pages:[{...page,_status:'draft'}],media:[]}),/unpublished/);
  assert.throws(()=>publishedSnapshot({settings:{...settings,_status:'draft'},pages:[page],media:[]}),/unpublished/);
  assert.throws(()=>publishedSnapshot({settings,pages:[{...page,blocks:[{blockType:'hero',heading:'入口',links:[{label:'x',href:'javascript:alert(1)'}]}]}],media:[]}),/unsafe_site_link/);
  assert.throws(()=>publishedSnapshot({settings,pages:[{...page,blocks:[{blockType:'image',media:'missing'}]}],media:[]}),/published_media_unavailable/);
  assert.throws(()=>publishedSnapshot({settings,pages:[{...page,blocks:[{blockType:'releaseLinks',channel:'arbitrary'}]}],media:[]}),/unsupported_release_channel/);
  assert.equal(safeHref('https://example.invalid/ok'),true);assert.equal(safeHref('https://user:pass@example.invalid/'),false);
  assert.equal(safeHref('https://example.invalid/\nwrong'),false);assert.equal(safePagePath('/app/account/'),false);
  for(const path of ['/media/','/releases/','/archives/','/docs/arbitrary/','/downloads/arbitrary/','/404/'])assert.equal(safePagePath(path),false);
  for(const path of ['/','/docs/','/downloads/verification/','/new-help/'])assert.equal(safePagePath(path),true);
});
test('the actual proxy accepts its configured edge Host with an internal Next URL and preserves origin checks',()=>{
  const input={url:'http://127.0.0.1:3301/v1/operations/login?returnTo=%2Fadmin',method:'GET',headers:new Headers({host:'admin.example.invalid','sec-fetch-site':'same-origin'}),publicOrigin};
  assert.deepEqual(operationsProxyRequestPolicy(input),{allowed:true,forwardOrigin:publicOrigin,path:'/v1/operations/login?returnTo=%2Fadmin'});
  assert.equal(operationsProxyRequestPolicy({...input,headers:new Headers({'x-forwarded-host':'admin.example.invalid',host:'unrelated.example.invalid'})}).allowed,false);
  assert.equal(operationsProxyRequestPolicy({...input,headers:new Headers({'x-forwarded-host':'admin.example.invalid'})}).allowed,false);
  assert.equal(operationsProxyRequestPolicy({...input,url:'http://localhost:3301/v1/operations/logout',method:'POST',headers:new Headers({host:'admin.example.invalid',origin:'https://unrelated.example.invalid'})}).allowed,false);
});
test('server session reads preserve valid client addresses and reject an absent or malformed production proxy chain',async()=>{
  const headers=new Headers({cookie:'__Host-galaxy-operator=opaque-value','x-forwarded-for':'198.51.100.7, 127.0.0.1'});
  let forwarded;
  await readOperatorSession(headers,{environment:{publicOrigin,bffOrigin,fixtureCookies:false},fetcher:async(_url,options)=>{forwarded=new Headers(options.headers).get('x-forwarded-for');return Response.json({state:'signed-out'});}});
  assert.equal(forwarded,'198.51.100.7, 127.0.0.1');
  assert.throws(()=>operatorForwardedAddress(new Headers()),/forwarded_address_required/);
  assert.throws(()=>operatorForwardedAddress(new Headers({'x-forwarded-for':'198.51.100.7, not-an-ip'})),/forwarded_address_required/);
  assert.equal(operatorForwardedAddress(new Headers(),true),'127.0.0.1');
});
