import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {OperationsAgentOsClient} from '../src/operations-agentos-client.mjs';

test('native current-authority outage remains unavailable while an actual denial remains a denial in the conversation client',async()=>{
 const conversation={id:randomUUID(),domain:'overview',mode:'conversation',sessionId:randomUUID()},calls=[];
 let response={status:503,error:'agentos_authority_unavailable'};
 const client=new OperationsAgentOsClient({url:'http://127.0.0.1:1',signingKey:'explicit-synthetic-local-key-no-production',fetchImpl:async(url,request)=>{
  calls.push({url,method:request.method});return new Response(JSON.stringify({error:response.error,private:'PRIVATE_NATIVE_PROSE'}),{status:response.status});
 }});
 await assert.rejects(client.readConversation(conversation),{code:'operations_authorization_unavailable',status:503});
 response={status:403,error:'agentos_current_authority_denied'};
 await assert.rejects(client.readConversation(conversation),error=>error.code==='operations_agentos_authority_changed'&&error.status===403&&!String(error).includes('PRIVATE_'));
 assert.equal(calls.length,2);assert.ok(calls.every(call=>call.method==='GET'&&call.url.endsWith('/galaxy/conversations/'+conversation.id)));
});
