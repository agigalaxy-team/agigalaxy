import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {NodeStreamableHTTPServerTransport} from '@modelcontextprotocol/node';
import {createPersonalMcp} from '../src/personal-mcp.mjs';
import {verifyContextV2} from './context-v2-workflow.mjs';

test('actual MCP transport exposes per-participation Context without claiming execution or model service',{timeout:60000},async()=>{
 await verifyContextV2({afterWorkflow:async({f,p,task,fresh,clock})=>{
  const server=createServer(async(req,res)=>{const mcp=createPersonalMcp(f,p.actor),transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
   try{await mcp.connect(transport);await transport.handleRequest(req,res);}finally{await mcp.close();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const client=new Client({name:'context-v2-test',version:'1'});
  try{await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}`)));
   const tools=(await client.listTools()).tools;assert.equal(tools.filter(t=>t.name.startsWith('galaxy_context_v2_')).length,5);
   const call=async(name,input)=>{const result=await client.callTool({name,arguments:input});assert.equal(result.isError,undefined,JSON.stringify(result));return JSON.parse(result.content[0].text);};
   const expired=await call('galaxy_context_v2_get',{grantId:fresh.id});assert.equal(expired.state,'expired');assert.equal(expired.contextAccessGranted,false);
   const payload={...fresh,id:crypto.randomUUID(),expiresAt:clock.now+300,materials:[{id:crypto.randomUUID(),label:'MCP selected test',mediaType:'text/plain',content:'A specific excerpt.'}]};
   await f.contextV2.create(f.actor,await f.authorize(payload,'context.grant',{viewers:[p.actor.subjectId]}));
   const metadata=await call('galaxy_context_v2_get',{grantId:payload.id,metadataOnly:true});assert.equal(metadata.contextAccessGranted,false);
   const event={schemaVersion:2,id:crypto.randomUUID(),grantId:payload.id,taskId:task.taskId,participationId:payload.participationId,
    scopeVersion:payload.scopeVersion,materialsHash:metadata.metadata.materialsHash,kind:'accept'};
   const authorized=await p.authorize(event,'context.grant',{viewers:[f.actor.subjectId]});
   await call('galaxy_context_v2_event',{grantId:payload.id,...authorized});
   const view=await call('galaxy_context_v2_get',{grantId:payload.id});assert.equal(view.materials[0].content,payload.materials[0].content);
   assert.equal(view.executionPermissionGranted,false);assert.equal(view.roomMembershipGranted,false);assert.equal(view.capabilityVerified,false);
  }finally{await client.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 }});
});
