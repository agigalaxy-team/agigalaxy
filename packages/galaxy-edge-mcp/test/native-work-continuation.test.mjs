import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadToolMcpClient} from '../../galaxy-web/scripts/browser-tool-runtime.mjs';
const {Client,InMemoryTransport}=await loadToolMcpClient();
import {communityForumFixture} from '../../galaxy-official/test/community-forum-fixture.mjs';
import {seedReadingBookmarkSources} from '../../galaxy-official/test/reading-bookmarks-sources-fixture.mjs';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../src/native-v2/runtime.mjs';
import {createNativeToolServer} from '../src/native-v2/server.mjs';
import {createWorkContinuationLink,readWorkContinuationLink,workContinuationLinkFromText,workContinuationPrompt} from '../src/native-v2/work/continuation-link.mjs';
import {createWorkContinuationReader} from '../src/native-v2/work/continuation.mjs';
import {nativeData} from './native-result.mjs';

const endpoint='https://official.example.org',website='https://selected.example',subjectId='GUID'+'A'.repeat(28);
const returnTo='/app/search?'+new URLSearchParams({q:'阅读',section:'methods'})+'#selected-item';
const input=(object,extra={})=>({version:1,endpoint,subjectId,object,purpose:'对照目前的说明，继续原来的问题',selectedMaterials:[],returnTo,...extra});

test('the copied ordinary request holds exact references and the original reading position, without source body or authority',()=>{
 const object={kind:'capsule',id:randomUUID(),versionId:randomUUID()},link=createWorkContinuationLink(website,input(object));
 assert.deepEqual(readWorkContinuationLink(link),{website,...input(object),sourceUrl:website+'/app/capsules/'+object.id+'/versions/'+object.versionId,returnUrl:website+returnTo});
 const prompt=workContinuationPrompt('阅读方法','对照目前的说明，继续原来的问题',link);
 assert.equal(/[\r\n]/.test(prompt),false,'the ordinary request can be pasted into a single-line host prompt without premature submission');
 assert.equal(workContinuationLinkFromText(prompt),link);assert.equal(workContinuationLinkFromText(prompt+'\n'+link),null);
 assert.ok(!prompt.includes('payloadJson'));assert.ok(!prompt.includes('materialBodies'));
 assert.throws(()=>createWorkContinuationLink(website,{...input(object),body:'private full body'}));
 assert.throws(()=>createWorkContinuationLink(website,input({kind:'capsule',id:object.id})));
 assert.throws(()=>createWorkContinuationLink(website,input(object,{returnTo:'//outside.example/app/'})));
 assert.throws(()=>readWorkContinuationLink(link.replace('/capsules/','/projects/')));
 assert.throws(()=>readWorkContinuationLink(link.replace('https://selected.example','https://user:password@selected.example')));
});

test('current identity and service are checked before source reads, and a late response cannot leave the old lease',async()=>{
 let calls=0,current=true,finish;const object={kind:'post',id:randomUUID()},link=createWorkContinuationLink(website,input(object));
 const runtime={website,api:{endpoint,call:async()=>{calls++;await new Promise(resolve=>{finish=resolve;});return{availability:'available',locator:{postId:object.id},payload:{title:'晚到正文',body:'不得送回新主体'}};}},
  status:()=>Promise.resolve({identity:subjectId,connected:true}),receiptStatus:{captureLease:()=>({subjectId,assertCurrent(){if(!current)throw Error('receipt_status_authority_changed');}})}};
 const read=createWorkContinuationReader(runtime);
 await assert.rejects(read({link:createWorkContinuationLink(website,input(object,{subjectId:'GUID'+'B'.repeat(28)}))}),/work_continuation_identity_mismatch/);assert.equal(calls,0);
 await assert.rejects(read({link:createWorkContinuationLink('https://other.example',input(object))}),/work_continuation_service_mismatch/);assert.equal(calls,0);
 const pending=read({link});while(!finish)await new Promise(resolve=>setImmediate(resolve));current=false;finish();
 await assert.rejects(pending,/receipt_status_authority_changed/);assert.equal(calls,1);
});

test('machine data excludes signed root requests and unrelated history; current result reports remain distinct from desired outcomes',async()=>{
 const taskId=randomUUID(),caseId=randomUUID(),resultId=randomUUID();
 const runtime={website,now:()=>100,api:{endpoint,call:async path=>path.startsWith('/v2/tasks/')?{taskId,caseId,requesterId:subjectId,version:1,state:'open',
  rootRequest:{summary:'RETAINED_ROOT_MUST_NOT_RETURN'},materialBodies:[{text:'RETAINED_MATERIAL_MUST_NOT_RETURN'}],
  request:{title:'继续文字说明',summary:'当前允许的说明',expectedOutcome:'希望完全解决',workContext:{goal:'检查解释',currentSituation:'已有局部观察'}}}:
  {caseId,version:3,scopeVersion:1,results:[{id:resultId,version:1,summary:'只完成了文字对照',reportedOutcome:'partial',limitations:'还未检查实际导出文件'}],resolution:{status:'unrecorded'},events:[{payload:'UNSELECTED_FULL_HISTORY'}]}},
  status:()=>Promise.resolve({identity:subjectId,connected:true}),receiptStatus:{captureLease:()=>({subjectId,assertCurrent(){}})}};
 const read=createWorkContinuationReader(runtime),data=await read({link:createWorkContinuationLink(website,input({kind:'task',id:taskId}))});
 assert.match(data.sources[0].content,/已有工作结果 · 部分完成/);assert.match(data.sources[0].content,/还未检查实际导出文件/);
 assert.equal(data.sources[0].data.workResults.results[0].id,resultId);assert.ok(!JSON.stringify(data).includes('RETAINED_'));assert.ok(!JSON.stringify(data).includes('UNSELECTED_FULL_HISTORY'));
 assert.equal(data.businessMutation,false);assert.equal(data.permissionExpanded,false);assert.equal(data.reuseOutcomeRecorded,false);
});

test('a profile freshness window ending during selected-source reads withholds its text without claiming permanent source expiry',async()=>{
 let now=100;const object={kind:'person',id:subjectId},selected={kind:'project',id:randomUUID()};
 const runtime={website,now:()=>now,api:{endpoint,call:async path=>path==='/v1/history/query'?{subjectId,selfDeclared:{displayName:'仅这次可读',about:'FRESH_PROFILE_BODY'},selfDeclaredReadExpiresAt:101,items:[{summary:'UNSELECTED_PERSON_HISTORY'}]}:
  (now=102,{projectId:selected.id,document:{title:'仍可读的项目',summary:'项目正文'}})},status:()=>Promise.resolve({identity:subjectId,connected:true}),receiptStatus:{captureLease:()=>({subjectId,assertCurrent(){}})}};
 const data=await createWorkContinuationReader(runtime)({link:createWorkContinuationLink(website,input(object,{selectedMaterials:[selected]}))});
 assert.equal(data.sources[0].state,'unavailable');assert.equal(data.sources[0].reason,'temporarily-unavailable');assert.equal(data.sources[1].state,'available');
 assert.ok(!JSON.stringify(data).includes('FRESH_PROFILE_BODY'));assert.ok(!JSON.stringify(data).includes('UNSELECTED_PERSON_HISTORY'));
});

test('method continuation uses only the reader-permitted exact source projection, without fetching the publisher Case',async()=>{
 const object={kind:'capsule',id:randomUUID(),versionId:randomUUID()},caseId=randomUUID(),resultId=randomUUID(),paths=[];let permitted=true;
 const apiData=()=>({capsuleId:object.id,versionId:object.versionId,version:{id:object.versionId,title:'已选方法',solutionStrategy:'先看原段落。'},sourceStatus:'current',
  sourceReading:{case:{status:permitted?'available':'unavailable',ref:{kind:'case-root',id:randomUUID(),version:1,caseId},title:'方法原问题',summary:'目前可读的原问题',rawEvents:['UNSELECTED_CASE_EVENTS']},
   result:{status:permitted?'available':'unavailable',ref:{kind:'result',id:resultId,version:2,caseId},summary:'当前许可下的精确原结果',reportedOutcome:'succeeded',limitations:'未检查别的环境',materialBodies:['PRIVATE_LATER_MATERIAL']}}});
 const runtime={website,api:{endpoint,call:async(path)=>{paths.push(path);return apiData();}},status:()=>Promise.resolve({identity:subjectId,connected:true}),receiptStatus:{captureLease:()=>({subjectId,assertCurrent(){}})}};
 const read=createWorkContinuationReader(runtime),link=createWorkContinuationLink(website,input(object));
 const first=await read({link});assert.match(first.sources[0].content,/方法来自的工作/);assert.match(first.sources[0].content,/原工作结果 · 报告完成/);
 assert.equal(first.sources[0].data.sourceReading.result.ref.version,2);assert.equal(first.reuseOutcomeRecorded,false);
 assert.ok(!JSON.stringify(first).includes('PRIVATE_LATER_MATERIAL'));assert.ok(!JSON.stringify(first).includes('UNSELECTED_CASE_EVENTS'));
 permitted=false;const withdrawn=await read({link});assert.match(withdrawn.sources[0].content,/原工作结果当前不可读，保持未知/);
 assert.ok(!JSON.stringify(withdrawn).includes('目前可读的原问题'));assert.ok(!JSON.stringify(withdrawn).includes('当前许可下的精确原结果'));
 assert.deepEqual(paths,['/v2/capsules/read','/v2/capsules/read']);
});

test('normal Native MCP re-reads exact signed HTTP sources, rejects private material and preserves withdrawal and repeated read semantics',{timeout:60000},async()=>{
 const f=await communityForumFixture({scopes:browserScopes}),directory=await mkdtemp(join(tmpdir(),'galaxy-native-work-continuation-'));
 let runtime,server,client;const calls=[];
 try{
  await f.login(f.owner,'synthetic-work-author');
  const original=await f.post({topic:'technology',title:'[合成] 第一版解释',body:'先按原段落检查。\n\n这是一份明确合成的说明。'});assert.equal((await f.write(f.owner,'create-post',original)).status,200);
  const revised=await f.post({postId:original.postId,expectedHeadVersion:1,title:'[合成] 新版解释',body:'第二版有新的说明。'});assert.equal((await f.write(f.owner,'publish-version',revised)).status,200);
  const submit=async(path,payload,action)=>{const signed=await f.owner.authorize(payload,action,{objectId:payload.eventId??payload.operationId??payload.id,visibility:'Public',purpose:'public-profile'});return{result:await f.ok(path,{input:signed}),consentId:signed.consentId};};
  const corpus=await seedReadingBookmarkSources({subjectId:f.owner.actor.subjectId,submit,now:f.clock.now,count:1}),method=corpus.capsules[0].reference;
  const privateTask={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',title:'PRIVATE_TASK_TITLE',summary:'PRIVATE_TASK_BODY',workContext:{goal:'本人问题',currentSituation:'不公开的背景',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.clock.now+3000};
  const signed=await f.owner.authorize(privateTask,'assistance.publish',{objectId:privateTask.operationId});assert.equal((await f.request('/v2/tasks',{input:signed})).status,200);
  runtime=await createNativeRuntime({dataDirectory:directory,endpoint,website,trustedKeys:f.owner.bindings.trustedKeys,now:()=>f.clock.now,
   fetch:async(url,options)=>{const path=new URL(url).pathname,response=await fetch(f.origin+path,options);calls.push({path,method:options?.method??'POST',status:response.status});return response;},openBrowser:async()=>({launched:false})});
  await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});const owner=runtime.api.snapshot().subjectId;
  server=createNativeToolServer(runtime);client=new Client({name:'synthetic-current-work-reader',version:'1'},{capabilities:{}});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  const link=createWorkContinuationLink(website,input({kind:'post',id:original.postId,versionId:original.versionId},{subjectId:owner,selectedMaterials:[{kind:'capsule',id:method.capsuleId,versionId:method.versionId},{kind:'task',id:privateTask.taskId}]}));
  const call=()=>client.callTool({name:'galaxy_work_continue',arguments:{link}}),first=await call(),data=nativeData(first);
  assert.notEqual(first.isError,true,JSON.stringify(first));assert.equal(data.sources[0].data.locator.versionId,original.versionId);assert.equal(data.sources[0].availableUntil,original.publishedUntil);assert.match(first.content[0].text,/先按原段落检查/);assert.ok(!first.content[0].text.includes(revised.body));
  assert.equal(data.sources[1].data.versionId,method.versionId);assert.equal(data.sources[2].state,'unavailable');assert.ok(!JSON.stringify(first).includes('PRIVATE_TASK_BODY'));
  assert.equal(data.returnUrl,website+returnTo);assert.ok(!first.content[0].text.includes('payloadJson'));
  const businessBefore=(await f.db.query('SELECT count(*)::int n FROM task_events')).rows[0].n;await call();assert.equal((await f.db.query('SELECT count(*)::int n FROM task_events')).rows[0].n,businessBefore);
  const firstRead=calls.length,foreign=await client.callTool({name:'galaxy_work_continue',arguments:{link:createWorkContinuationLink(website,input({kind:'post',id:original.postId},{subjectId:f.owner.actor.subjectId}))}});
  assert.equal(foreign.isError,true);assert.equal(calls.length,firstRead,'another subject never reaches the source API');
  await f.owner.consents.revoke(f.owner.actor,corpus.capsules[0].consentId);
  assert.equal((await f.write(f.owner,'withdraw-post',{schemaVersion:1,operationId:randomUUID(),postId:original.postId,expectedHeadVersion:2})).status,200);
  const unavailable=await call();assert.ok(!JSON.stringify(unavailable).includes(original.body));assert.ok(!JSON.stringify(unavailable).includes(corpus.capsules[0].title));assert.equal(nativeData(unavailable).sources[0].state,'unavailable');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM choice_snapshot_heads')).rows[0].n,0);assert.equal((await f.db.query('SELECT count(*)::int n FROM personal_summary_heads')).rows[0].n,0);
 }finally{await client?.close();await server?.close();await runtime?.close();await f.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-native-work-continuation-'));await rm(target,{recursive:true,force:true});}
});
