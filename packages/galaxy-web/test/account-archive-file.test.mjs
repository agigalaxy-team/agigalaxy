import test from 'node:test';
import assert from 'node:assert/strict';
import {readConversationArchiveFile,conversationArchiveParts,exportConversationArchive,conversationArchiveReading} from '../src/account-archive-file.mjs';

test('only explicitly selected sessions enter an archive, with complete UTF-8 content across chunk boundaries',()=>{
 const file=readConversationArchiveFile(JSON.stringify({workspaceId:'my-workspace',sessions:[{sessionId:'chosen',title:'需要保存',content:'真实会话🙂'.repeat(50000)},{sessionId:'excluded',content:'不允许附带上传的会话'}]}));
 const parts=conversationArchiveParts(file,['chosen']);assert.equal(parts.length>1,true);assert.equal(parts.every(part=>new TextEncoder().encode(part).length<=262144),true);
 const restored=JSON.parse(parts.join(''));assert.deepEqual(restored.sessions.map(value=>value.sessionId),['chosen']);assert.equal(restored.sessions[0].content,file.sessions[0].content);assert.equal(parts.join('').includes('不允许附带上传'),false);
 assert.throws(()=>conversationArchiveParts(file,[]));assert.throws(()=>conversationArchiveParts(file,['missing']));
});
test('an archive export reads every page and refuses a repeated or mismatched source instead of downloading partial content',async()=>{
 const calls=[],archive={id:'original-archive',title:'我的会话'};
 const result=await exportConversationArchive(async(path,input)=>{calls.push(input.sequence);return{archive,content:input.sequence===0?'first':'second',nextSequence:input.sequence===0?1:null};},archive.id);
 assert.equal(result.content,'firstsecond');assert.deepEqual(calls,[0,1]);
 await assert.rejects(exportConversationArchive(async()=>({archive,content:'partial',nextSequence:0}),archive.id),/分页位置/);
 await assert.rejects(exportConversationArchive(async()=>({archive:{id:'another-archive'},content:'private',nextSequence:null}),archive.id),/当前选择不一致/);
});
test('invalid or duplicate source sessions are rejected before any upload can be prepared',()=>{
 for(const value of [{sessions:[]},{workspaceId:'w',sessions:[{sessionId:'same',content:'a'},{sessionId:'same',content:'b'}]},{workspaceId:'w',sessions:[{sessionId:'missing-content'}]}])assert.throws(()=>readConversationArchiveFile(JSON.stringify(value)));
});
test('a real Native export retains unknown workspace, capture coverage and exclusions without claiming a complete host conversation',()=>{
 const source={format:'galaxy-private-conversation-v1',galaxyId:'GUID15'+'0'.repeat(26),session:{archiveSessionId:'chosen-native-session',host:'opencode',sessionId:'host-session',workspaceId:null,revision:4},messages:[{sequence:1,messageId:'m1',capturedAt:'2026-10-19T00:00:00.000Z',message:{role:'user'},parts:[{type:'text',text:'实际取得的原文'}],exclusions:[{path:'$.parts[1]',kind:'inline-binary'}]}],nextAfter:null,completeConversation:false,coverage:'只含开始捕获后取得的材料，已排除未取得的内容'};
 const file=readConversationArchiveFile(JSON.stringify(source));assert.equal(file.workspaceId,null);assert.equal(file.sessions[0].sessionId,source.session.archiveSessionId);assert.equal(file.sessions[0].completeConversation,false);assert.equal(file.sessions[0].excludedItems,1);assert.equal(file.sessions[0].coverage,source.coverage);
 const archived=JSON.parse(conversationArchiveParts(file,[source.session.archiveSessionId]).join(''));assert.deepEqual(archived.sessions[0].content,source);assert.equal(archived.sessions[0].completeConversation,false);
 const paged=readConversationArchiveFile(JSON.stringify({...source,nextAfter:1}));assert.equal(paged.sessions[0].hasMore,true);
 const unversioned={...source};delete unversioned.format;assert.deepEqual(readConversationArchiveFile(JSON.stringify(unversioned)).sessions[0].content,unversioned);
});

test('saved Native conversations read as messages while segment gaps and exclusions remain explicit',()=>{
 const native={format:'galaxy-private-conversation-v1',galaxyId:'GUID15'+'0'.repeat(26),session:{archiveSessionId:'segment',host:'opencode',sessionId:'original',workspaceId:null,title:'一次讨论'},messages:[{sequence:12,messageId:'question',message:{role:'user'},parts:[{type:'text',text:'需要解决的问题'}],exclusions:[]},{sequence:13,messageId:'answer',message:{role:'assistant'},parts:[{type:'text',text:'已保存的回答'}],exclusions:[{path:'$.parts[1]',kind:'credential'}]}],selectedCoverage:{afterSequence:11,throughSequence:13,sourceMessages:20,hasEarlier:true,hasLater:true},nextAfter:null,completeConversation:false};
 const file=readConversationArchiveFile(JSON.stringify(native));
 const sessions=conversationArchiveReading(conversationArchiveParts(file,['segment']).join(''));
 assert.equal(sessions.length,1);assert.equal(sessions[0].title,'一次讨论');assert.deepEqual(sessions[0].entries.map(row=>[row.role,row.text]),[['user','需要解决的问题'],['assistant','已保存的回答']]);assert.equal(sessions[0].excludedItems,1);assert.equal(sessions[0].hasEarlier,true);assert.equal(sessions[0].hasMore,true);assert.equal(sessions[0].completeConversation,false);
});
