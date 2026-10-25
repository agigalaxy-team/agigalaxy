import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AgentOsConversations} from '../src/operations-agentos-conversations.mjs';

function fixture({configuration={prompt:'Only the current role work requirements.'},version=3,denyAt=0}={}){
 const row={id:randomUUID(),domain:'overview',session_id:randomUUID(),operator_id:'owned-reader'},calls=[];
 const service=Object.assign(Object.create(AgentOsConversations.prototype),{endpoint:'https://role-prompt.synthetic.invalid',now:()=>123,
  db:{async query(sql,values){calls.push({sql,values});assert.match(sql,/^SELECT configuration,prompt_version/);assert.deepEqual(values,[service.endpoint,row.domain]);return{rows:configuration===null?[]:[{configuration,prompt_version:version}]};}},
  async current(id){assert.equal(id,row.id);calls.push({current:true});if(denyAt&&calls.filter(call=>call.current).length===denyAt)throw Object.assign(Error('Changed authority'),{code:'operations_agentos_authority_changed'});return{row,actor:{}};}});
 return{row,service,calls};
}

test('native current-AI role prompt comes from the saved configuration, rechecks authorization and never enters the public view',async()=>{
 const {row,service,calls}=fixture();
 const result=await service.authorizeNative({conversationId:row.id,operation:'run'});
 assert.deepEqual(result.execution.rolePrompt,{version:3,text:'Only the current role work requirements.'});
 assert.equal(calls.filter(call=>call.current).length,2);assert.equal(service.view(row).rolePrompt,undefined);
 assert.deepEqual(result.resourceIds,['galaxy-conversation-overview']);
});

test('a later round reads the new version; absence is null and malformed configuration fails closed',async()=>{
 const missing=fixture({configuration:null});assert.equal((await missing.service.authorizeNative({conversationId:missing.row.id,operation:'run'})).execution.rolePrompt,null);
 for(const options of [{configuration:{prompt:'x'},version:0},{configuration:{prompt:42}},{configuration:{prompt:'x'.repeat(16001)}}]){
  const {row,service}=fixture(options);await assert.rejects(service.authorizeNative({conversationId:row.id,operation:'run'}),{code:'operations_agentos_role_prompt_unavailable'});
 }
 const latest=fixture({configuration:{prompt:'New current work requirements.'},version:4});assert.equal((await latest.service.authorizeNative({conversationId:latest.row.id,operation:'run'})).execution.rolePrompt.version,4);
});

test('revocation before or after configuration reading prevents returning any role instructions',async()=>{
 for(const denyAt of [1,2]){const {row,service,calls}=fixture({denyAt});await assert.rejects(service.authorizeNative({conversationId:row.id,operation:'run'}),{code:'operations_agentos_authority_changed'});if(denyAt===1)assert.equal(calls.filter(call=>call.sql).length,0);}
 const other=fixture();await assert.rejects(other.service.authorizeNative({conversationId:other.row.id,operation:'run',resourceId:'galaxy-conversation-messaging'}),{code:'operations_agentos_domain_mismatch'});assert.equal(other.calls.filter(call=>call.sql).length,0);
});
