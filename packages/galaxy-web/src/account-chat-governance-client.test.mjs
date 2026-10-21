import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAccountChatGovernanceClient} from './account-chat-governance-client.mjs';

function localRuntime(){const rows=new Map();return{api:{endpoint:'https://official.example.org'},getLocal:async(key,owner)=>structuredClone(rows.get(owner+'|'+key)),updateLocal:async(key,fn,owner)=>{const id=owner+'|'+key,value=fn(structuredClone(rows.get(id)));rows.set(id,structuredClone(value));return value;}};}
const input=()=>({operationId:randomUUID(),roomId:randomUUID(),roomVersion:3,category:'privacy',summary:'只提交自己的说明与明确选择的位置。',materials:[{messageId:randomUUID(),revision:2,attachmentIds:[]}]});
test('unknown ACK retains the exact operation and only resumes that account’s original intent',async()=>{
 const runtime=localRuntime(),payload=input(),calls=[];let fail=true,recorded=false;
 const network={call:async(path,body)=>{calls.push({path,body:structuredClone(body)});if(path.endsWith('/receipt'))return{state:recorded?'recorded':'absent',reportId:payload.operationId};if(fail)throw Error('network interrupted');recorded=true;return{reportId:payload.operationId};}};
 const session={account:{id:randomUUID()}},client=createAccountChatGovernanceClient({client:network,session,runtime});
 await assert.rejects(client.submit('report',payload),/network interrupted/);assert.equal((await client.pending()).length,1);
 fail=false;const original=(await client.pending())[0];await client.resume(original);
 assert.deepEqual(calls.filter(call=>call.path.endsWith('/report')).map(call=>call.body),[payload,payload]);assert.deepEqual(await client.pending(),[]);
 const second=createAccountChatGovernanceClient({client:network,session:{account:{id:randomUUID()}},runtime});assert.deepEqual(await second.pending(),[]);
});
test('a known rejection preserves the editable draft and never repeatedly sends a changed source',async()=>{
 const runtime=localRuntime(),session={account:{id:randomUUID()}},payload=input();
 const client=createAccountChatGovernanceClient({client:{call:async()=>{throw Object.assign(Error('chat_report_source_changed'),{outcome:'rejected'});}},session,runtime});
 const draft={summary:payload.summary,category:payload.category,selections:payload.materials};await client.saveDraft('room:'+payload.roomId,draft);
 await assert.rejects(client.submit('report',payload),/chat_report_source_changed/);assert.deepEqual(await client.pending(),[]);
 assert.deepEqual(await client.draft('room:'+payload.roomId),draft);assert.equal(JSON.stringify(await client.draft('room:'+payload.roomId)).includes('text'),false,'the journal does not save original message bodies');
});
test('recorded ACK clears only its original draft, retaining later edits while avoiding a second report',async()=>{
 const runtime=localRuntime(),session={account:{id:randomUUID()}},payload=input(),locator='room:'+payload.roomId;let writes=0;
 const network={call:async path=>{if(path.endsWith('/receipt'))return{state:'recorded',reportId:payload.operationId};writes++;throw Error('ACK lost');}};
 const client=createAccountChatGovernanceClient({client:network,session,runtime});
 await client.saveDraft(locator,{summary:payload.summary,selections:payload.materials});await assert.rejects(client.submit('report',payload));
 const operation=(await client.pending())[0];await client.saveDraft(locator,{summary:'另写的说明必须保留。',selections:[]});
 await client.resume(operation);assert.equal(writes,1);assert.equal((await client.draft(locator)).summary,'另写的说明必须保留。');assert.deepEqual(await client.pending(),[]);
});
