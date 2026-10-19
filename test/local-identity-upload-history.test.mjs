import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeLocalGalaxyId,initializeLocalWorkerGalaxyId,initializeGalaxyIntegration,getLocalSnapshot,getLocalUploadPrivacy,setLocalUploadPrivacy} from '../packages/galaxy-core/src/local-store.mjs';
import {allowsUploadDataType,projectWorkHistoryForUpload,assertNativeUploadAllowed} from '../packages/galaxy-core/src/upload-privacy.mjs';
import {createLocalConversationArchive} from '../packages/galaxy-core/src/conversation-archive/index.mjs';
import {localPaths} from '../packages/galaxy-core/src/storage/files.mjs';
import {redactLocalWorkData,assertNoWorkCredentials} from '../packages/galaxy-core/src/local-data-redaction.mjs';

async function withDirectory(run) {
  const directory=await mkdtemp(join(tmpdir(),'galaxy-local-work-'));
  try {await run(directory);} finally {await rm(directory,{recursive:true,force:true});}
}

test('normal person/organization and isolated Worker identities never retype an existing ID',()=>withDirectory(async directory=>{
  const normal=await initializeLocalGalaxyId(directory,{subjectType:'organization'});
  assert.equal(normal.identity.subjectType,'organization');
  await assert.rejects(initializeGalaxyIntegration(directory,{subjectType:'person'}),/local_identity_type_immutable/);
  await assert.rejects(initializeLocalGalaxyId(directory,{subjectType:'agent'}),/local_identity_subject_type_invalid/);
  const worker=await initializeLocalWorkerGalaxyId(directory,{workerId:'analysis'});
  assert.equal(worker.identity.subjectType,'agent');
  assert.equal(worker.identity.clientKind,'worker');
  assert.equal(worker.runtimeStarted,false);
  assert.notEqual(worker.identity.id,normal.identity.id);
  assert.equal((await getLocalSnapshot(directory)).identity.id,normal.identity.id);
}));

test('legacy missing subject type is preserved and cannot be silently declared personal',()=>withDirectory(async directory=>{
  const snapshot=await initializeLocalGalaxyId(directory);
  const path=localPaths(directory).identity;
  const identity=JSON.parse(await readFile(path,'utf8'));delete identity.subjectType;
  await writeFile(path,JSON.stringify(identity));
  assert.equal((await initializeLocalGalaxyId(directory)).identity.subjectType,undefined);
  await assert.rejects(initializeLocalGalaxyId(directory,{subjectType:'person'}),/local_identity_legacy_type_unconfirmed/);
  assert.equal((await getLocalSnapshot(directory)).identity.id,snapshot.identity.id);
}));

test('four upload levels persist, keep per-identity choices and require an explicit full-session scope',()=>withDirectory(async directory=>{
  const identity=(await initializeLocalGalaxyId(directory)).identity;
  assert.equal((await getLocalUploadPrivacy(directory)).settings.level,'history-overview');
  let changed=await setLocalUploadPrivacy(directory,{level:'conversation-archive'});
  assert.equal(changed.settings.includeFullConversations,false);
  await assert.rejects(setLocalUploadPrivacy(directory,{level:'conversation-archive',includeFullConversations:true}),/upload_privacy_session_scope_required/);
  changed=await setLocalUploadPrivacy(directory,{level:'conversation-archive',includeFullConversations:true,sessionIds:['selected-archive']});
  assert.equal(allowsUploadDataType(changed.settings,'full-conversation',{sessionId:'selected-archive'}),true);
  assert.equal(allowsUploadDataType(changed.settings,'full-conversation',{sessionId:'another-archive'}),false);
  const other={getIdentity:()=>({id:'adopted-test-identity'})};
  await setLocalUploadPrivacy(directory,{level:'local-only'},other);
  assert.equal((await getLocalUploadPrivacy(directory,other)).settings.level,'local-only');
  assert.equal((await getLocalUploadPrivacy(directory)).galaxyId,identity.id);
  assert.equal((await getLocalUploadPrivacy(directory)).settings.level,'conversation-archive');
  changed=await setLocalUploadPrivacy(directory,{level:'history-overview'});
  assert.equal(changed.settings.includeFullConversations,false);
  assert.deepEqual(changed.settings.sessionIds,[]);
}));

test('level-two field projection excludes raw observations and blocks signed context before sending',()=>{
  const settings={level:'history-overview'};
  const record={work:{workId:'work',galaxyId:'local',host:'host',sessionId:'session',title:'Private project title',summary:'Own model summary',outcome:'unknown'},
    observations:[{content:{excerpt:'private work body'}}],environments:[{version:1,facts:{host:'host',actualModel:'provider/model-v1',cwd:'C:/private/client',rules:'private rules text',tools:['read-file','https://private-endpoint']}}]};
  const projected=projectWorkHistoryForUpload(settings,record);
  assert.equal('summary' in projected.data,false);
  assert.equal(JSON.stringify(projected).includes('Private project title'),false);
  assert.equal(JSON.stringify(projected).includes('private/client'),false);
  assert.deepEqual(projected.data.environments[0].facts,{host:'host',actualModel:'provider/model-v1',tools:['read-file']});
  assert.equal('observations' in projected.data,false);
  assert.deepEqual(projected.omittedDataTypes,['work-summary','work-content']);
  assert.equal(projectWorkHistoryForUpload({level:'local-only'},record).data,null);
  const unsummarized=projectWorkHistoryForUpload({level:'work-content'},{...record,work:{...record.work,summary:'',summaryRevision:0,sourceKind:'host-observations'}});
  assert.equal(unsummarized.data.summary.title,'Private project title');
  assert.equal(unsummarized.data.summary.summary,'');
  assert.equal(unsummarized.data.summary.sourceKind,'host-observations');
  const signed={payloadJson:JSON.stringify({materials:[{content:'selected local original'}]})};
  assert.throws(()=>assertNativeUploadAllowed(settings,'/v2/context/grants',signed),/local_upload_type_not_allowed/);
  assert.equal(assertNativeUploadAllowed({level:'work-content'},'/v2/context/grants',signed),signed);
  assert.equal(assertNativeUploadAllowed({level:'local-only'},'/v2/search/query',{query:'user-selected keywords'}).query,'user-selected keywords');
});

test('private originals need exact host/session selection and remain separate from upload and other identities',()=>withDirectory(async directory=>{
  const identity=(await initializeLocalGalaxyId(directory)).identity;
  let current=identity;
  const archive=createLocalConversationArchive({dataDirectory:directory,getIdentity:()=>current,now:()=> '2026-10-19T00:00:00.000Z'});
  const original={host:'host',sessionId:'one',messageId:'message',message:{role:'user'},parts:[{type:'text',text:'actual original'}]};
  assert.equal((await archive.captureMessage(original)).captured,false);
  await archive.configure({enabled:true,sessions:[{host:'host',sessionId:'one'}],autoCleanAfterDays:null});
  assert.equal((await archive.captureMessage({...original,host:'other-host'})).captured,false);
  const captured=await archive.captureMessage(original);
  const exported=await archive.exportSession({archiveSessionId:captured.archiveSessionId});
  // Export is JSON data; redaction deliberately uses prototype-free objects.
  assert.deepEqual(JSON.parse(JSON.stringify(exported.messages[0].parts)),original.parts);
  assert.equal(exported.completeConversation,false);
  assert.equal((await getLocalUploadPrivacy(directory)).settings.includeFullConversations,false);
  current={id:'another-controlled-identity'};
  assert.deepEqual((await archive.list()).items,[]);
  await assert.rejects(archive.exportSession({archiveSessionId:captured.archiveSessionId}),/local_archive_session_unavailable/);
  current=identity;
  const deleted=await archive.deleteSession({archiveSessionId:captured.archiveSessionId});
  assert.equal(deleted.deletedMessages,1);
  assert.equal(deleted.hostOriginalsChanged,false);
  assert.equal((await archive.captureMessage(original)).captured,false);
}));

test('configured automatic cleanup deletes only old captured originals for that owner',()=>withDirectory(async directory=>{
  await initializeLocalGalaxyId(directory);
  let clock='2026-10-01T00:00:00.000Z';
  const archive=createLocalConversationArchive({dataDirectory:directory,now:()=>clock});
  await archive.configure({enabled:true,sessions:[{host:'host',sessionId:'one'}],autoCleanAfterDays:7});
  await archive.captureMessage({host:'host',sessionId:'one',messageId:'old',message:{role:'assistant'},parts:[{type:'text',text:'old original'}]});
  clock='2026-10-19T00:00:00.000Z';
  assert.equal((await archive.cleanup()).deletedMessages,1);
  const sessions=await archive.list();
  assert.equal(sessions.items[0].messageCount,0);
}));

test('credential fields and recognised credential text are excluded before archive persistence and export',()=>withDirectory(async directory=>{
  await initializeLocalGalaxyId(directory);
  const archive=createLocalConversationArchive({dataDirectory:directory});
  await archive.configure({enabled:true,sessions:[{host:'host',sessionId:'selected'}],autoCleanAfterDays:null});
  const captured=await archive.captureMessage({host:'host',sessionId:'selected',messageId:'one',message:{role:'user',password:'test-only-example'},parts:[{type:'text',text:'api_key=test-only-example'}]});
  const result=await archive.exportSession({archiveSessionId:captured.archiveSessionId});
  assert.equal(JSON.stringify(result).includes('test-only-example'),false);
  assert.ok(result.messages[0].exclusions.some(item=>item.kind==='credential'));
  assert.doesNotThrow(()=>assertNoWorkCredentials(result.messages));
  const twice=redactLocalWorkData(redactLocalWorkData({password:'test-only-example',text:'api_key=test-only-example'}).value);
  assert.deepEqual(twice.exclusions,[]);
}));
