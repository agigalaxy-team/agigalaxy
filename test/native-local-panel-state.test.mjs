import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalPanelMemory,mergeLocalWorkPage} from '../integrations/native-v2/compact-app/local-work-state.mjs';
import {createNativeArchiveSync,archiveCloudListSchema} from '../packages/galaxy-edge-mcp/src/native-v2/archive-sync.mjs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {registerLocalWorkPanelTools} from '../integrations/native-v2/compact-app/local-work-server.mjs';

// Use the actual SDK installation owned by the compact App fixture. The root
// workspace does not declare a separate MCP Client dependency.
const sdk=createRequire(new URL('../integrations/native-v2/compact-app/package.json',import.meta.url));
const {Client,InMemoryTransport}=await import(pathToFileURL(sdk.resolve('@modelcontextprotocol/client')).href);
const {McpServer}=await import(pathToFileURL(sdk.resolve('@modelcontextprotocol/server')).href);

test('saving conversation settings keeps an unfinished work selection and reading position for the same identity',()=>{
  const memory=createLocalPanelMemory(),history={galaxyId:'local-one',view:'history',work:{items:[{workId:'older-work'}],nextAfter:'60'},selectedWork:{work:{workId:'older-work'}}};
  memory.remember({...history,selectedWork:null},{listScroll:620,pageScroll:120});memory.remember(history,{listScroll:620,pageScroll:480});
  const work={targetAccountId:'account-one',workIds:['older-work'],includeExisting:false};
  memory.edit('work',work,{...work,workIds:[]});memory.edit('settings',{level:'work-content'},{level:'history-overview'});
  memory.completed('galaxy_local_panel_settings_save');
  assert.deepEqual(memory.draft('work'),work);assert.equal(memory.draft('settings'),undefined);
  assert.equal(memory.page('history').selectedWork.work.workId,'older-work');assert.deepEqual(memory.position('history'),{listScroll:620,pageScroll:480});assert.deepEqual(memory.listPosition('history'),{listScroll:620,pageScroll:120});
  const draft=memory.draft('work');draft.workIds.push('not-saved');assert.deepEqual(memory.draft('work'),work);
  memory.useIdentity('local-two');assert.equal(memory.page('history'),undefined);assert.equal(memory.draft('work'),undefined);
});

test('list pagination retains the selected reader while a later detail page merges by source sequence',()=>{
  const current={galaxyId:'local-one',view:'history',work:{items:[{workId:'work-one'}],nextAfter:'30'},selectedWork:{work:{workId:'work-one'},observations:[{sequence:1,text:'old'},{sequence:2,text:'current'}],nextAfter:2},relatedArchiveSessionId:'actual-original'};
  const page=mergeLocalWorkPage(current,{galaxyId:'local-one',view:'history',work:{items:[{workId:'work-two'}],nextAfter:null},selectedWork:null},{appendList:true});
  assert.deepEqual(page.work.items.map(x=>x.workId),['work-one','work-two']);assert.equal(page.selectedWork,current.selectedWork);assert.equal(page.relatedArchiveSessionId,'actual-original');
  const detail=mergeLocalWorkPage(page,{galaxyId:'local-one',view:'history',work:{items:[{workId:'work-one'}],nextAfter:'30'},selectedWork:{work:{workId:'work-one'},observations:[{sequence:2,text:'updated'},{sequence:3,text:'later'}],nextAfter:null}},{append:true});
  assert.deepEqual(detail.selectedWork.observations.map(x=>x.text),['old','updated','later']);assert.equal(detail.work.nextAfter,null);
  const other=mergeLocalWorkPage(page,{galaxyId:'local-two',view:'history',work:{items:[],nextAfter:null}});assert.deepEqual(other.work.items,[]);assert.equal(other.selectedWork,undefined);
  detail.selectedWork.work.lastSequence=3;const returning={...detail,selectedWork:{work:{workId:'work-one',lastSequence:3},observations:[{sequence:1,text:'old'},{sequence:2,text:'updated'}],nextAfter:2}};
  const retained=mergeLocalWorkPage(detail,returning,{retainDetails:true});assert.equal(retained.selectedWork.observations.length,3);assert.equal(retained.selectedWork.nextAfter,null);
  const changed=mergeLocalWorkPage(detail,{...returning,selectedWork:{...returning.selectedWork,work:{workId:'work-one',lastSequence:4}}},{retainDetails:true});assert.equal(changed.selectedWork.observations.length,2);assert.equal(changed.selectedWork.nextAfter,2);
});

test('Native cloud archives continue opaque cursors with the same explicit target and bounded page size',async()=>{
  const calls=[],targetAccountId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',cursor='ac1.c3RhYmxlLXBvc2l0aW9u';
  const sync=createNativeArchiveSync({dataDirectory:'unused-read-only-transport',endpoint:'https://service.example.test',getIdentity:()=>null,call:async(...args)=>{calls.push(args);return {archives:[],nextAfter:null};}});
  try{await sync.listCloud({targetAccountId,after:cursor,limit:100});assert.deepEqual(calls,[[
    '/v2/account-archives/list',{after:cursor,limit:100},{accountId:targetAccountId},
  ]]);assert.equal(archiveCloudListSchema.safeParse({targetAccountId,after:'a'.repeat(513)}).success,false);assert.equal(archiveCloudListSchema.safeParse({targetAccountId,limit:101}).success,false);
  }finally{await sync.close();}
});

test('a no-identity panel read stays read-only and preparation recovers its finished original without a second review',async()=>{
  let galaxyId=null,approved=false,created=0,reviews=0,recoveryRequired=false;const reviewed=[];
  const local={privacyGet:async()=>({galaxyId,recoveryRequired}),work:{list:async()=>({galaxyId,items:[],nextAfter:null})},archive:{},
    prepareLocal:async input=>{created++;assert.equal(input.subjectType,'organization');galaxyId='actual-local-organization';return {initialized:true};}};
  const server=new McpServer({name:'local-panel-preparation-fixture',version:'1'}),client=new Client({name:'synthetic-panel-user',version:'1'},{capabilities:{}});
  registerLocalWorkPanelTools(server,{resourceUri:'ui://galaxy/local-reading-test',local,reviewAction:async request=>{
    reviews++;reviewed.push(request.name);return {content:[{type:'text',text:JSON.stringify(approved?await request.run():{state:'user-choice-needs-browser'})}]};
  }});
  const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(left);await client.connect(right);
  const call=(name,args={})=>client.callTool({name,arguments:args});
  try{
    assert.equal((await call('galaxy_local_panel'))._meta.galaxyLocalWork.notInitialized,true);assert.equal(created,0);assert.equal(reviews,0);
    const input={view:'history',subjectType:'organization'};
    assert.equal((await call('galaxy_local_panel_prepare',input))._meta.galaxyLocalWork.choice.state,'user-choice-needs-browser');assert.equal(created,0);
    approved=true;const prepared=await call('galaxy_local_panel_prepare',input);assert.equal(prepared._meta.galaxyLocalWork.galaxyId,'actual-local-organization');assert.equal(created,1);
    const reviewCount=reviews;await call('galaxy_local_panel_prepare',input);assert.equal(created,1);assert.equal(reviews,reviewCount);assert.ok(reviewed.every(name=>name==='galaxy_native_initialize'));
    recoveryRequired=true;const stopped=await call('galaxy_local_panel_prepare',input);assert.equal(stopped.isError,true);assert.equal(stopped._meta.galaxyLocalWork.error,'local_identity_recovery_required');assert.equal(created,1);assert.equal(reviews,reviewCount);
  }finally{await client.close();await server.close();}
});
