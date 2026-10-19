import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeLocalGalaxyId,setLocalUploadPrivacy} from '../packages/galaxy-core/src/local-store.mjs';
import {createLocalConversationArchive} from '../packages/galaxy-core/src/conversation-archive/index.mjs';
import {createLocalWorkHistory} from '../packages/galaxy-core/src/work-history/index.mjs';
import {createNativeArchiveSync} from '../packages/galaxy-edge-mcp/src/native-v2/archive-sync.mjs';
import {createNativeWorkSync} from '../packages/galaxy-edge-mcp/src/native-v2/work-sync.mjs';
import {accountWorkPutSchema} from '../packages/galaxy-official/src/shared/account-work-schema.mjs';

const endpoint='https://service.example.test',accountId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function fixture(run){const dataDirectory=await mkdtemp(join(tmpdir(),'galaxy-local-sync-'));
  try{const {identity}=await initializeLocalGalaxyId(dataDirectory);await run({dataDirectory,identity,getIdentity:()=>identity});}
  finally{await rm(dataDirectory,{recursive:true,force:true});}}

test('archive unknown chunk ACK resumes original snapshot and owner deletion stops that source scope',()=>fixture(async context=>{
  const archive=createLocalConversationArchive(context);
  await archive.configure({enabled:true,sessions:[{host:'opencode',sessionId:'selected'}],autoCleanAfterDays:null});
  const captured=await archive.captureMessage({host:'opencode',sessionId:'selected',messageId:'one',message:{role:'user'},parts:[{type:'text',text:'selected original'}]});
  await setLocalUploadPrivacy(context.dataDirectory,{level:'conversation-archive',includeFullConversations:true,sessionIds:[captured.archiveSessionId]});
  const records=new Map(),calls=[];let loseAck=true;
  const call=async(path,input,options={})=>{
    calls.push({path,input,options});if(path.endsWith('/accounts'))return {subjectId:context.identity.id,accounts:[{accountId,endpoint}]};
    assert.equal(options.accountId,accountId);
    const operation=path.split('/').at(-1),old=records.get(input.id);
    if(operation==='status')return old?{id:input.id,state:old.state,reason:old.reason,storedSequences:[...old.chunks.keys()]}:{id:input.id,state:'absent',storedSequences:[]};
    if(operation==='create'){assert.equal(options.localUpload.sessionId,captured.archiveSessionId);records.set(input.id,{state:'uploading',chunks:new Map()});return {id:input.id,state:'uploading'};}
    if(operation==='chunk'){old.chunks.set(input.sequence,input.content);if(loseAck){loseAck=false;throw Object.assign(new Error('lost_ack'),{code:'lost_ack'});}return {stored:true};}
    if(operation==='complete'){old.state='ready';return {id:input.id,state:'ready'};}
    throw new Error('unexpected_mock_operation');
  };
  const sync=createNativeArchiveSync({...context,endpoint,call});
  await sync.choose({choiceId:randomUUID(),enabled:true,targetAccountId:accountId,archiveSessionIds:[captured.archiveSessionId]});
  assert.equal((await sync.flush()).items[0].state,'unknown');
  const firstId=calls.find(row=>row.path.endsWith('/create')).input.id;
  assert.equal((await sync.flush()).items[0].state,'ready');
  assert.equal(calls.filter(row=>row.path.endsWith('/create')).length,1);
  assert.equal(calls.filter(row=>row.path.endsWith('/chunk')).length,1);
  assert.ok(calls.filter(row=>row.input.id).every(row=>row.input.id===firstId));
  records.get(firstId).state='deleted';records.get(firstId).reason='owner-deleted';
  await sync.flush();
  await archive.captureMessage({host:'opencode',sessionId:'selected',messageId:'two',message:{role:'assistant'},parts:[{type:'text',text:'later selected original'}]});
  await sync.onSessionComplete({host:'opencode',sessionId:'selected'});
  assert.equal(calls.filter(row=>row.path.endsWith('/create')).length,1);
  await sync.close();
}));

test('level-two real work put excludes prose and reconciles original operation ACK before further versions',()=>fixture(async context=>{
  const local=createLocalWorkHistory(context),first=await local.recordNote({host:'opencode',sessionId:'session',sourceId:'first',text:'private task details',title:'Private client project'});
  const calls=[],receipts=new Map();let current=null,loseAck=true;
  const call=async(path,input,options={})=>{
    calls.push({path,input,options});if(path.endsWith('/accounts'))return {subjectId:context.identity.id,accounts:[{accountId,endpoint}]};
    assert.equal(options.accountId,accountId);
    if(path.endsWith('/status'))return current?{...current}:{state:'absent',revision:0};
    if(path.endsWith('/put')){
      accountWorkPutSchema.parse(input);
      assert.equal(JSON.stringify(input).includes('private task details'),false);
      assert.equal(JSON.stringify(input).includes('Private client project'),false);
      const receipt={workId:input.workId,revision:input.revision,state:'stored'};
      receipts.set(input.operationId,receipt);current={...receipt,scopeId:input.scopeId,lastOperationId:input.operationId};
      if(loseAck){loseAck=false;throw Object.assign(new Error('lost_ack'),{code:'lost_ack'});}return receipt;
    }
    throw new Error('unexpected_mock_operation');
  };
  const sync=createNativeWorkSync({...context,endpoint,call});
  await sync.choose({choiceId:randomUUID(),enabled:true,targetAccountId:accountId,workIds:[first.workId],includeExisting:true,includeFutureWork:false});
  assert.equal((await sync.flush()).items[0].state,'unknown');
  const original=calls.find(row=>row.path.endsWith('/put')).input;
  assert.equal((await sync.flush()).items[0].state,'stored');
  assert.equal(calls.filter(row=>row.path.endsWith('/put')).length,1);
  assert.equal(receipts.has(original.operationId),true);
  current={state:'deleted',revision:2,scopeId:original.scopeId,deletedReason:'owner-deleted'};
  await local.recordNote({host:'opencode',sessionId:'session',sourceId:'second',text:'later private task material'});
  assert.equal((await sync.flush()).items[0].state,'deleted');
  await local.recordNote({host:'opencode',sessionId:'session',sourceId:'third',text:'another private update'});
  await sync.flush();assert.equal(calls.filter(row=>row.path.endsWith('/put')).length,1);
  await sync.close();
}));
