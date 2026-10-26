import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Client,InMemoryTransport} from '../../integrations/native-v2/compact-app/node_modules/@modelcontextprotocol/client/dist/index.mjs';
const source=process.env.GALAXY_NATIVE_TEST_SOURCE,candidate=process.env.GALAXY_NATIVE_TEST_CANDIDATE;
assert.ok(source&&candidate,'Fixed source and built native artifact required');
const fixed=name=>import(pathToFileURL(join(source,name)).href);
const {receiptStatusFixture}=await fixed('packages/galaxy-official/test/receipt-status-workflow.mjs');
const {createHelpSearchClient}=await fixed("packages/galaxy-web/src/features/help-search/help-search-client.mjs");
const {createChoiceSyncClient}=await fixed("packages/galaxy-web/src/features/choice-sync/choice-sync-client.mjs");
const {createNativeRuntime}=await import(pathToFileURL(join(candidate,'runtime.js')).href);
const {createNativeToolServer}=await import(pathToFileURL(join(candidate,'server.js')).href);

test('built native SDK uses persisted current device after restart to recover only the original retained Choice receipt',async()=>{
 const t=await receiptStatusFixture(),directory=await mkdtemp(join(tmpdir(),'galaxy-native-built-receipt-'));
 let runtime,server,sdk,search,cloud,drop=false;
 const config={dataDirectory:directory,endpoint:t.f.access.endpoint,website:'https://galaxy.example.org',trustedKeys:t.trustedKeys,now:t.now,
  fetch:async(url,options)=>{const response=await t.transport(url,options);if(drop&&new URL(url).pathname==='/v2/choice-snapshots/put'){
   drop=false;throw new Error('synthetic committed response lost');}return response;}};
 try{
  runtime=await createNativeRuntime(config);await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});
  const subjectId=(await runtime.status()).identity;
  const facade={api:runtime.api,receiptStatus:runtime.receiptStatus,status:async()=>{const value=await runtime.status();return{...value,identity:{subjectId:value.identity}};},
   getLocal:key=>runtime.store.get('candidate-choice:'+subjectId+':'+key),putLocal:(key,value)=>runtime.store.put('candidate-choice:'+subjectId+':'+key,value)};
  search=createHelpSearchClient(facade,{authenticated:true,subjectId});cloud=createChoiceSyncClient(facade,{subjectId});
  const found=await search.query({type:'history',query:{query:'Retained receipt source'}}),selected=search.candidateKey(found.items[0]),id=randomUUID();
  await search.saveChoice({id,expectedVersion:0,localTaskRef:'Private built-native original work',visibleRationale:'Private built-native original reason',
   rationaleAuthor:'user',candidateKeys:[selected],selectedKeys:[selected],resultRefs:[]});
  await cloud.savePreference({endpoint:config.endpoint,expectedRevision:0,enabled:true,snapshotIds:[id]});
  drop=true;await assert.rejects(cloud.sync(id),/response lost/);
  const [row]=await cloud.retainedReceiptOperations();assert.equal(row.snapshotId,id);
  const operation={kind:'choice-snapshot',snapshotId:id,versionId:row.versionId,requestHash:row.requestHash};
  search.close();cloud.close();runtime.close();
  runtime=await createNativeRuntime(config);assert.equal(runtime.api.snapshot(),null);
  const before=Object.fromEntries(await Promise.all(['bindings','access_credentials','session_challenges','choice_snapshot_preferences','choice_snapshot_versions']
   .map(async table=>[table,(await t.f.db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows])));
  t.setTime(t.policy.takeoutUntil+1);assert.equal(t.retirement.phase(),'status-only');
  server=createNativeToolServer(runtime);sdk=new Client({name:'fixed-native-retained-receipt-review',version:'0.1.3'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await server.connect(serverTransport);await sdk.connect(clientTransport);
  const tool=(await sdk.listTools()).tools.find(x=>x.name==='galaxy_native_receipt_status');assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,true);
  const start=t.requests.length,result=await sdk.callTool({name:tool.name,arguments:operation});assert.notEqual(result.isError,true);
  const receipt=result.structuredContent;assert.ok(receipt);assert.equal(receipt.state,'acknowledged');assert.equal(receipt.contentReturned,false);assert.equal(receipt.currentAccessGranted,false);
  assert.equal(receipt.versionId,operation.versionId);assert.equal(receipt.requestHash,operation.requestHash);assert.equal(JSON.stringify(receipt).includes('Private built-native'),false);
  assert.deepEqual(t.requests.slice(start).map(x=>x.path),['/v2/receipt-status/challenges','/v2/receipt-status/query']);
  assert.ok(t.requests.slice(start).every(x=>!x.authorization));assert.equal(runtime.api.snapshot(),null);
  for(const [table,rows]of Object.entries(before))assert.deepEqual((await t.f.db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows,rows);
  const noCall=t.requests.length,invalid=await sdk.callTool({name:tool.name,arguments:{...operation,content:'Must not upload body'}});
  assert.equal(invalid.isError,true);assert.equal(t.requests.length,noCall);
  t.setTime(t.policy.statusUntil);assert.equal((await sdk.callTool({name:tool.name,arguments:operation})).isError,true);
 }finally{
  await sdk?.close();await server?.close();search?.close();cloud?.close();runtime?.close();await t.close();
  assert.equal(resolve(directory).startsWith(resolve(tmpdir())+'\\galaxy-native-built-receipt-')||resolve(directory).startsWith(resolve(tmpdir())+'/galaxy-native-built-receipt-'),true);
  await rm(directory,{recursive:true,force:true});
 }
});
