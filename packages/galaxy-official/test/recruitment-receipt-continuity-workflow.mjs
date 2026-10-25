import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createServer} from "node:http";
import {Client,StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import {NodeStreamableHTTPServerTransport} from "@modelcontextprotocol/node";
import {verifyContactsV2} from "./contacts-v2-workflow.mjs";
import {createPersonalMcp} from "../src/adapters/mcp/personal/handler.mjs";
import {getProjectContactClient} from "../../galaxy-web/src/features/projects/clients/operations.mjs";
import {digest} from "../src/shared/digest.mjs";
import {recruitmentOperationReceiptResultSchema} from "../src/shared/recruitment-schema-v2.mjs";

// Real local OIDC, JWS, HTTP, Account/quota and PGlite. Caller journals and
// exposed connection tags are declared Map/lease contract fixtures, not IDB
// or actual device reconnects. Prior WebRuntime lease tests cover that boundary.
export async function verifyRecruitmentOperationReceipt(database=null,{after,...options}={}){
  return verifyContactsV2(database,{...options,afterWorkflow:async({f,p,request,project})=>{
    let revision=(await request(p,'/v2/projects/'+project.projectId,null)).revision;
    const role=async kind=>{
      const event={kind,operationId:randomUUID(),projectId:project.projectId,expectedRevision:revision,
        subjectId:f.actor.subjectId,role:'representative'};
      const result=await request(p,'/v2/projects',await p.authorize(event,'project.write',
        {objectId:event.operationId,visibility:'Public',purpose:'public-profile'}));revision=result.revision;
    };
    await role('grant-role');
    const recruitmentId=randomUUID(),publicationId=randomUUID(),unsentId=randomUUID();
    const document={title:'Synthetic ongoing parser role',role:'Discuss and maintain parsing',
      summary:'FICTIONAL original representative publication',functions:['table-extraction'],contactSubjectId:f.actor.subjectId};
    const publication={kind:'create',operationId:publicationId,recruitmentId,projectId:project.projectId,
      expectedRevision:0,document,expiresAt:f.now+3600};
    const unsent={...publication,kind:'revise',operationId:unsentId,expectedRevision:1,
      document:{...document,summary:'FICTIONAL never dispatched intent'}};
    const dispatch=[],reads=[],journals=[];
    function caller(failure){
      const values=new Map(),state={subjectId:f.actor.subjectId,endpoint:f.access.endpoint,bindingId:f.actor.bindingId,generation:1};
      const hooks={get:null,put:null,response:null};journals.push(values);let failOnce=true;
      const runtime={api:{endpoint:f.access.endpoint,snapshot:()=>structuredClone(state),
        authorizePayload:(payloadJson,{action,objectId,visibility,viewers})=>f.authorize(JSON.parse(payloadJson),action,
          {objectId,visibility,viewers,purpose:visibility==='Public'?'public-profile':'operational'}),
        call:async(path,input,{method}={})=>{
          if(path==='/v2/recruitment'&&failOnce&&failure==='before'){
            failOnce=false;throw new Error('Synthetic caller failed before business dispatch');
          }
          if(path==='/v2/recruitment')dispatch.push(JSON.parse(input.payloadJson).operationId);
          if(method==='GET')reads.push(path);
          const result=await request(f,path,method==='GET'?null:input);
          await hooks.response?.(path,result);
          if(path==='/v2/recruitment'&&failOnce&&failure==='after'){
            failOnce=false;throw new Error('Synthetic caller ACK lost after actual commit');
          }return result;
        }
      },getLocal:async key=>{const v=structuredClone(values.get(key));await hooks.get?.(key,v);return v;},
        putLocal:async(key,value)=>{values.set(key,structuredClone(value));await hooks.put?.(key,value);}};
      return{client:getProjectContactClient(runtime,f.actor.subjectId),values,hooks,
        rebind:()=>{state.bindingId=randomUUID();state.generation++;}};
    }
    const a=caller('after'),b=caller('before');
    await assert.rejects(a.client.submit('recruitment',publication,{visibility:'Public',confirmed:true}),e=>e.resultUnknown===true);
    await assert.rejects(b.client.submit('recruitment',unsent,{visibility:'Public',confirmed:true}),e=>e.resultUnknown===true);
    const savedA=structuredClone([...a.values.values()].flat().find(x=>x.operationId===publicationId));
    const savedB=structuredClone([...b.values.values()].flat().find(x=>x.operationId===unsentId));
    const original=async operationId=>(await f.db.query(
      'SELECT operation_id,recruitment_id,subject_id,revision,consent_id,payload_text,payload_hash,created_at FROM recruitment_events WHERE operation_id=$1',
      [operationId])).rows[0];
    const raw=await original(publicationId);assert.equal(raw.payload_text,savedA.payloadJson);
    assert.equal(raw.payload_hash,digest(savedA.payloadJson));assert.equal(await original(unsentId),undefined);
    await role('revoke-role');
    const ownerEvent={...unsent,operationId:randomUUID(),document:{...document,summary:'FICTIONAL current owner version',contactSubjectId:p.actor.subjectId}};
    await request(p,'/v2/recruitment',await p.authorize(ownerEvent,'recruitment.write',
      {objectId:ownerEvent.operationId,visibility:'Public',purpose:'public-profile'}));
    await request(f,'/v1/consents/'+savedA.submission.consentId+'/revoke',{});
    await request(f,'/v1/consents/'+savedB.submission.consentId+'/revoke',{});
    const current=await request(f,'/v2/recruitment/'+recruitmentId,null);
    assert.equal(current.revision,2);assert.equal(current.originalSource.operationId,ownerEvent.operationId);
    assert.equal((await request(f,'/v2/recruitment',savedA.submission,403)).error,'project_role_required');
    const ref={recruitmentId,operationId:publicationId,payloadHash:savedA.payloadHash};
    const absentRef={recruitmentId,operationId:unsentId,payloadHash:savedB.payloadHash};
    const url=x=>'/v2/recruitment/'+x.recruitmentId+'/receipt?'+new URLSearchParams({operationId:x.operationId,payloadHash:x.payloadHash});
    const receipt=async(x,who=f)=>{const result=await request(who,url(x),null);return recruitmentOperationReceiptResultSchema.parse(result);};
    const count=async()=>Number((await f.db.query('SELECT count(*) FROM recruitment_events WHERE recruitment_id=$1',[recruitmentId])).rows[0].count);
    const hosts=[],servers=[];
    const sdk=async who=>{
      const server=createServer(async(req,res)=>{let mcp;try{
        const credential=/^Bearer (.+)$/.exec(req.headers.authorization??'')?.[1];
        const actor=await f.access.authenticate(credential);mcp=createPersonalMcp(f,actor);
        const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
        await mcp.connect(transport);await transport.handleRequest(req,res);
      }catch{if(!res.headersSent)res.writeHead(401);res.end();}finally{await mcp?.close();}});
      servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      const host=new Client({name:'synthetic-recruitment-receipt',version:'1'});hosts.push(host);
      await host.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+server.address().port),
        {requestInit:{headers:{authorization:'Bearer '+who.credential}}}));return host;
    };
    try{
      return await after({f,p,request,project,recruitmentId,publicationId,unsentId,ownerEvent,a,b,savedA,savedB,raw,ref,absentRef,
        url,receipt,original,count,sdk,dispatch,reads,current});
    }finally{
      for(const host of hosts)await host.close();
      for(const server of servers)if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    }
  }});
}
