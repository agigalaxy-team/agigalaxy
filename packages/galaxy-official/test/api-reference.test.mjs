import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { businessApiReference,specialApiReference } from '../api-reference.mjs';
import { createRoutes } from '../src/adapters/http/routes.mjs';
import { officialRoutes } from '../deploy/caddy-routes.mjs';
import { buildApiReference } from '../../../scripts/build-api-reference.mjs';

const id='11111111-1111-4111-8111-111111111111',subjectId='GUID'+'0'.repeat(28),endpoint='https://official.example.org';
const parameters={id,subjectId,providerId:'fixture',ruleId:'synthetic',ruleVersion:'1.0'};
const expand=path=>path.replace(/\{([^}]+)\}/g,(_match,key)=>parameters[key]);
const classes={identity:['identity-links','IdentityLinkService'],bindings:['bindings','BindingService'],access:['access','AccessService'],
  consents:['consents','ConsentService'],cases:['cases','CaseService'],evidence:['evidence','EvidenceService'],proofs:['proofs','ProofService'],
  history:['history','HistoryService'],profiles:['profile','ProfileService'],discovery:['discovery','DiscoveryService'],search:['search','SearchService'],assistance:['assistance','AssistanceService'],
  context:['context','ContextService'],notifications:['notifications','NotificationService'],qualification:['qualification','QualificationService'],
  moderation:['moderation','ModerationService'],honor:['honor','HonorService'],capsules:['capsules','CapsuleService'],builders:['builders','BuilderService'],
  audit:['audit','AuditService'],dataExport:['data-export','DataExportService'],deletion:['deletion','DeletionService']};

test('authored API reference matches real dispatch, concrete service methods and optional/required session scopes',async()=>{
  const calls=[],authentication=[],services={};
  for(const [name,[file,exportName]] of Object.entries(classes)){
    const Constructor=(await import('../src/'+file+'.mjs'))[exportName];
    services[name]={};
    for(const item of businessApiReference.filter(item=>item.service===name)){
      assert.equal(typeof Constructor.prototype[item.operation],'function',name+'.'+item.operation);
      services[name][item.operation]=(...args)=>{calls.push({name:name+'.'+item.operation,args});return {fixture:name+'.'+item.operation};};
    }
  }
  const actor={subjectId,bindingId:id};
  services.access.authenticate=async(token,scope)=>{authentication.push({token,scope});return actor;};
  services.bindings.endpoint=endpoint;
  const dispatch=createRoutes(services),seen=new Set();
  for(const item of businessApiReference){
    const key=item.method+' '+item.path;assert.ok(!seen.has(key));seen.add(key);
    const path=expand(item.path),input=Object.fromEntries((item.input?.fields??[]).map(key=>[key,key==='payloadJson'?JSON.stringify({kind:item.path==='/v1/case-events'?'attempt':'case'}):'synthetic']));
    if(item.path==='/v1/search/query')Object.assign(input,{type:'case',query:{}});
    for(const authorized of item.authentication==='optional-galaxy-session'?[false,true]:[item.authentication==='galaxy-session']){
      calls.length=0;authentication.length=0;
      const request=Readable.from([Buffer.from(JSON.stringify(input))]);request.method=item.method;
      request.headers={'content-type':'application/json',host:new URL(endpoint).host,...(authorized?{authorization:'Bearer synthetic'}:{})};
      let result;
      await dispatch({request,response:{setHeader(){},getHeader(){}},requestId:id,url:new URL(path,endpoint),send:(status,body)=>{result={status,body};}});
      assert.deepEqual(result,{status:item.status,body:{fixture:item.service+'.'+item.operation}},key);
      assert.equal(calls.length,1,key);
      assert.deepEqual(authentication,authorized?[{token:'synthetic',scope:item.scope==='query-type'?'history':item.scope}]:[],key);
    }
    if(item.authentication==='galaxy-session'){
      const request=Readable.from([Buffer.from(JSON.stringify(input))]);request.method=item.method;request.headers={'content-type':'application/json'};
      await assert.rejects(dispatch({request,response:{setHeader(){},getHeader(){}},requestId:id,url:new URL(path,endpoint),send(){}}),error=>error.status===401,key);
    }
    assert.ok((await readFile(new URL('../../../'+item.documentation,import.meta.url),'utf8')).length);
  }
});

test('every documented external route reaches the exact-host Caddy matcher, while probes and unknown routes remain internal',()=>{
  const matchers=officialRoutes({endpoint,apiPort:43121})[0].match;
  const forwards=(method,path,host='official.example.org')=>matchers.some(item=>item.host.includes(host)&&item.method.includes(method)
    &&(item.path?.some(pattern=>pattern===path||pattern.endsWith('/*')&&path.startsWith(pattern.slice(0,-1)))||item.path_regexp&&new RegExp(item.path_regexp.pattern).test(path)));
  const missing=[];
  for(const item of [...businessApiReference,...specialApiReference]){
    const yes=forwards(item.method,expand(item.path));
    if(item.exposure==='internal-only')assert.equal(yes,false,item.path);
    else if(!yes)missing.push(item.method+' '+item.path);
    assert.equal(forwards(item.method,expand(item.path),'unrelated.example.org'),false);
  }
  assert.deepEqual(missing,[],'documented implemented endpoints missing from proxy');
  assert.equal(forwards('GET','/v1/unknown'),false);
  assert.equal(forwards('POST','/.well-known/oauth-protected-resource/mcp/personal'),false);
});

test('generated API reference and error declarations match current source and never supply a production API server',async()=>{
  await buildApiReference({check:true});
  const catalog=JSON.parse(await readFile(new URL('../../../docs/technical/reference/development-api-reference-v1.json',import.meta.url),'utf8'));
  assert.deepEqual(catalog.publicApiEndpoints,[]);assert.equal(catalog.kind,'development-source-reference-not-deployed-api');
  assert.equal(catalog.entries.length,businessApiReference.length+specialApiReference.length);
});
