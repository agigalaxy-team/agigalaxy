import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {NodeStreamableHTTPServerTransport} from '@modelcontextprotocol/node';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {createPersonalMcp} from '../src/personal-mcp.mjs';
import {createModerationFlow} from '../src/moderation-flow.mjs';
import {createModerationClient} from '../src/moderation-client.mjs';
import {createSessionMemory} from '../src/session-memory.mjs';
import {digest} from '../src/shared/digest.mjs';

const names=['galaxy_moderation_config','galaxy_moderation_query','galaxy_moderation_get','galaxy_moderation_report','galaxy_moderation_event','galaxy_moderation_receipt'];
async function fixture(){
  const scopes=['binding','consent','case-teaser','assistance','moderation'],f=await serviceFixture(scopes);
  let api,mcp;const hosts=[];
  try{
    const reporter=await serviceFixture(scopes,f.db,{migrateDatabase:false}),moderator=await serviceFixture(scopes,f.db,{migrateDatabase:false}),
      verifier=await serviceFixture(scopes,f.db,{migrateDatabase:false}),decliner=await serviceFixture(scopes,f.db,{migrateDatabase:false}),outsider=await serviceFixture(scopes,f.db,{migrateDatabase:false});
    f.moderation.moderatorIds=[moderator.actor.subjectId];
    api=createApi({...f,rateLimit:1000});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    mcp=createServer(async(req,res)=>{
      let server;
      try{
        const credential=/^Bearer (.+)$/.exec(req.headers.authorization??'')?.[1],actor=await f.access.authenticate(credential);
        server=createPersonalMcp(f,actor);const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
        await server.connect(transport);await transport.handleRequest(req,res);
      }catch{if(!res.headersSent)res.writeHead(401);res.end();}finally{await server?.close();}
    });
    await new Promise(resolve=>mcp.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${api.address().port}`,mcpUrl=new URL(`http://127.0.0.1:${mcp.address().port}`),endpoint=f.access.endpoint;
    const http=async(who,path,input)=>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${who.credential}`},body:JSON.stringify(input)});
      return{status:response.status,body:await response.json()};};
    async function host(who){
      const model=new Client({name:'moderation-journey-consumer',version:'1'});
      await model.connect(new StreamableHTTPClientTransport(mcpUrl,{requestInit:{headers:{authorization:`Bearer ${who.credential}`}}}));
      const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});
      sessions.adopt({endpoint,subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>who.credential});
      let lose=false,writes=0;
      const raw=(name,input)=>model.callTool({name,arguments:input});
      const call=async(name,input)=>{const result=await raw(name,input);if(result.isError)throw new Error(result.content[0].text);return JSON.parse(result.content[0].text);};
      const send=async(url,{bodyJson})=>{
        const path=new URL(url).pathname,input=JSON.parse(bodyJson),parts=path.split('/'),reportId=parts[4];
        const name=path.endsWith('/config')?'galaxy_moderation_config':path.endsWith('/query')?'galaxy_moderation_query':path.endsWith('/read')?'galaxy_moderation_get':
          path.endsWith('/receipt')?'galaxy_moderation_receipt':path.endsWith('/events')?'galaxy_moderation_event':'galaxy_moderation_report';
        const args=name==='galaxy_moderation_get'?{reportId}:['galaxy_moderation_event','galaxy_moderation_receipt'].includes(name)?{...input,reportId}:input;
        const write=['galaxy_moderation_report','galaxy_moderation_event'].includes(name);if(write)writes++;
        const result=await call(name,args);if(write&&lose){lose=false;throw new Error('synthetic MCP ACK lost after actual commit');}return result;
      };
      const flow=createModerationFlow({endpoint,sessions,moderationSend:send,now:()=>f.now,
        signIntent:async(payload,typ)=>{assert.equal(flow.isSigningIntent(payload),true,'host signs only the exact preview accepted through flow.execute');return who.signForTest(payload,typ);},
        consentSend:async(url,{bodyJson})=>{const result=await http(who,new URL(url).pathname,JSON.parse(bodyJson));assert.equal(result.status,200,JSON.stringify(result.body));return result.body;}});
      const value={who,model,flow,read:createModerationClient({endpoint,sessions,send}),raw,call,lose:()=>{lose=true;},writes:()=>writes,
        close:async()=>{sessions.close();await model.close();}};hosts.push(value);return value;
    }
    const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'Synthetic MCP Case review',summary:'Private original source',
      source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    const source=await f.authorize(root,'case.teaser.publish',{viewers:[reporter.actor.subjectId,moderator.actor.subjectId,verifier.actor.subjectId,decliner.actor.subjectId]});
    await f.cases.submit(f.actor,source);
    return{...f,reporter,moderator,verifier,decliner,outsider,root,source,http,host,
      close:async()=>{await Promise.all(hosts.map(h=>h.close()));for(const server of [mcp,api]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await f.db.close();}};
  }catch(error){await Promise.all(hosts.map(h=>h.close()));for(const server of [mcp,api])if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await f.db.close();throw error;}
}
const reportInput=f=>({kind:'report',caseId:f.root.id,caseVersion:1,targetEventId:f.root.id,category:'false-verification',summary:'Synthetic process concern, not a real allegation'});
const action=async(host,input)=>{const preview=await host.flow.prepare(input);return{preview,receipt:await host.flow.execute(preview,preview.confirmation)};};

test('ordinary MCP exposes the complete exact-Consent Case review journey with distinct invitation, response, withdrawal and appeal',async()=>{
  const f=await fixture();try{
    const r=await f.host(f.reporter),m=await f.host(f.moderator),v=await f.host(f.verifier),d=await f.host(f.decliner),o=await f.host(f.outsider);
    const listed=(await r.model.listTools()).tools.filter(tool=>tool.name.startsWith('galaxy_moderation_'));
    assert.deepEqual(listed.map(t=>t.name).sort(),[...names].sort());
    for(const tool of listed)assert.equal(tool.annotations.readOnlyHint,!['galaxy_moderation_report','galaxy_moderation_event'].includes(tool.name));
    const config=await r.call('galaxy_moderation_config',{});assert.equal(config.verifierParticipation,1);assert.equal(config.guaranteesResolution,false);
    const preview=await r.flow.prepare(reportInput(f));assert.equal(preview.payloadHash,digest(preview.payloadJson));
    assert.deepEqual(JSON.parse(preview.intentJson).viewers,[f.moderator.actor.subjectId]);
    await assert.rejects(r.flow.execute(preview,'model-only-confirmation'),/confirmation/);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM moderation_reports')).rows[0].count),0);
    const created=await r.flow.execute(preview,preview.confirmation),id=created.reportId;
    assert.equal(created.version,1);assert.deepEqual((await r.read.query({caseId:f.root.id})).items.map(x=>x.reportId),[id]);
    assert.deepEqual((await o.read.query({caseId:f.root.id})).items,[]);await assert.rejects(o.read.get(id),/not_found/);
    const malformed=await r.raw('galaxy_moderation_query',{caseId:f.root.id,assistanceId:randomUUID()});assert.equal(malformed.isError,true);
    const invite=await action(m,{kind:'invite-verifier',reportId:id,verifierId:f.verifier.actor.subjectId,scope:'仅核对合成来源和失败范围',expiresAt:f.now+100,summary:'邀请独立的本人选择'});
    const target=JSON.parse(invite.preview.payloadJson).target;assert.deepEqual(target,{caseId:f.root.id,caseVersion:1,targetEventId:f.root.id});
    assert.equal((await v.read.get(id)).verifierParticipation.own.status,'invited');
    await action(v,{kind:'accept-verifier',reportId:id,invitationId:invite.receipt.eventId,summary:'本人接受有限复核'});
    const second=await action(m,{kind:'invite-verifier',reportId:id,verifierId:f.decliner.actor.subjectId,scope:'可独立拒绝的邀请',expiresAt:f.now+100,summary:'不替对方接受'});
    await action(d,{kind:'decline-verifier',reportId:id,invitationId:second.receipt.eventId,summary:'本人拒绝'});
    assert.equal((await d.read.get(id)).canAppeal,false);
    const response=await action(v,{kind:'verification-response',reportId:id,invitationId:invite.receipt.eventId,conclusion:'inconclusive',references:[{kind:'case',id:f.root.id}],summary:'签署有限意见，不宣称认证'});
    const view=await v.read.get(id),event=view.events.find(e=>e.id===response.receipt.eventId);
    assert.equal(event.authority,'participant-signed-review');assert.equal(event.independenceVerified,false);assert.equal(event.capabilityVerified,false);
    await action(v,{kind:'correct',reportId:id,correctsEventId:response.receipt.eventId,reason:'仅纠正本人文字',summary:'原意见强度不变'});
    await action(v,{kind:'withdraw-verifier',reportId:id,invitationId:invite.receipt.eventId,summary:'本人退出复核'});
    const withdrawn=await v.read.get(id);assert.equal(withdrawn.canSubmitVerification,false);assert.equal(withdrawn.canSupplement,true);assert.equal(withdrawn.canAppeal,true);
    const selfVerdict={id:randomUUID(),reportId:id,expectedVersion:withdrawn.version,kind:'resolve',verdict:'dismissed',summary:'历史参与者不能裁定自己案件'};
    const forgedRole=await f.verifier.authorize(selfVerdict,'moderation.publish',{viewers:[f.moderator.actor.subjectId,f.actor.subjectId,f.reporter.actor.subjectId]});
    const deniedRole=await v.raw('galaxy_moderation_event',{reportId:id,...forgedRole});assert.equal(deniedRole.isError,true);assert.equal(deniedRole.content[0].text,'moderation_role_denied');
    await action(m,{kind:'resolve',reportId:id,verdict:'dismissed',summary:'独立处理过程结论'});
    await action(v,{kind:'appeal',reportId:id,summary:'历史参与者对处理结论申诉'});
    await action(v,{kind:'supplement',reportId:id,references:[],summary:'本人有限补充，不授引用读权'});
    const final=await v.read.get(id);assert.equal(final.state,'appealed');assert.equal(final.automaticallyVerified,false);
    assert.equal(final.verifierParticipation.own.status,'withdrawn');
    assert.ok(final.events.some(e=>e.id===response.receipt.eventId));
    const viaHttp=await f.http(f.verifier,`/v1/moderation/reports/${id}/read`,{});assert.equal(viaHttp.status,200);assert.deepEqual(viaHttp.body,final);
    const request={id:randomUUID(),caseId:f.root.id,title:'Synthetic legacy Assistance',problem:'A separate existing target',attemptedApproaches:[],
      scope:'有限协助范围',visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+100};
    await f.assistance.create(f.actor,await f.authorize(request,'assistance.publish',{viewers:[f.reporter.actor.subjectId,f.moderator.actor.subjectId]}));
    const assistance=await action(r,{kind:'report',assistanceId:request.id,category:'scope',summary:'旧协助目标保持原合同'});
    const assistanceView=await m.read.get(assistance.receipt.reportId);assert.equal(assistanceView.assistanceId,request.id);assert.equal(assistanceView.caseId,undefined);
    const assistanceInvite=await action(m,{kind:'invite-verifier',reportId:assistance.receipt.reportId,verifierId:f.verifier.actor.subjectId,
      scope:'仅本次协助范围',expiresAt:f.now+100,summary:'独立对象邀请'});
    assert.deepEqual(JSON.parse(assistanceInvite.preview.payloadJson).target,{assistanceId:request.id});
    await action(v,{kind:'decline-verifier',reportId:assistance.receipt.reportId,invitationId:assistanceInvite.receipt.eventId,summary:'本人拒绝另一对象'});
    assert.deepEqual((await r.read.query({assistanceId:request.id})).items.map(x=>x.reportId),[assistance.receipt.reportId]);
  }finally{await f.close();}
});

test('ordinary MCP cannot use an original receipt or a signed envelope to bypass current source, audience or author permissions',async()=>{
  const f=await fixture();try{
    const r=await f.host(f.reporter),o=await f.host(f.outsider),m=await f.host(f.moderator);
    const inaccessible=await o.flow.prepare(reportInput(f));await assert.rejects(o.flow.execute(inaccessible,inaccessible.confirmation),/not_found/);
    const wrongAudience={...reportInput(f),id:randomUUID()};delete wrongAudience.kind;
    const audienceConsent=await f.reporter.authorize(wrongAudience,'moderation.publish',{viewers:[f.outsider.actor.subjectId]});
    const deniedAudience=await r.raw('galaxy_moderation_report',audienceConsent);assert.equal(deniedAudience.isError,true);assert.equal(deniedAudience.content[0].text,'moderation_recipient_mismatch');
    const preview=await r.flow.prepare(reportInput(f));r.lose();await assert.rejects(r.flow.execute(preview,preview.confirmation),/ACK lost/);
    const reference=r.flow.recoveryReference(preview),before=r.writes(),ack=await r.flow.recover(reference);
    assert.equal(ack.state,'acknowledged');assert.deepEqual(ack.receipt,{reportId:reference.reportId,eventId:reference.eventId,version:1});assert.equal(r.writes(),before);
    await assert.rejects(r.flow.prepareExisting({reference,payloadJson:preview.payloadJson}),/confirmed absent/);
    const append=await r.flow.prepare({kind:'supplement',reportId:reference.reportId,summary:'本人原准确说明',references:[]});r.lose();
    await assert.rejects(r.flow.execute(append,append.confirmation),/ACK lost/);
    const appended=r.flow.recoveryReference(append);
    await f.consents.revoke(f.reporter.actor,JSON.parse(preview.intentJson).id);await f.consents.revoke(f.reporter.actor,JSON.parse(append.intentJson).id);await f.consents.revoke(f.actor,f.source.consentId);
    const report=await m.read.get(reference.reportId);assert.equal(report.report,null);assert.equal(report.source,null);assert.ok(!report.events.some(e=>e.id===append.eventId));
    const query={reportId:reference.reportId,eventId:reference.eventId,payloadHash:reference.payloadHash};
    const minimal=await r.call('galaxy_moderation_receipt',query);assert.equal(minimal.currentAccessGranted,false);assert.equal(minimal.contentReturned,false);
    assert.deepEqual(Object.keys(minimal).sort(),['authority','capabilityVerified','contentReturned','currentAccessGranted','eventId','independenceVerified','payloadHash','receipt','reportId','state'].sort());
    assert.equal((await r.flow.recover(appended)).receipt.version,2);assert.equal((await o.call('galaxy_moderation_receipt',query)).state,'absent');
    assert.equal((await r.call('galaxy_moderation_receipt',{...query,payloadHash:'0'.repeat(64)})).state,'conflict');
    const receiptHttp=await f.http(f.reporter,`/v1/moderation/reports/${query.reportId}/receipt`,{eventId:query.eventId,payloadHash:query.payloadHash});assert.equal(receiptHttp.status,200);assert.deepEqual(receiptHttp.body,minimal);
    const replay=await r.raw('galaxy_moderation_report',{consentId:JSON.parse(preview.intentJson).id,payloadJson:preview.payloadJson});assert.equal(replay.isError,true);
    const unapproved=await r.raw('galaxy_moderation_report',{consentId:randomUUID(),payloadJson:preview.payloadJson,confirmed:true});assert.equal(unapproved.isError,true);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM moderation_reports')).rows[0].count),1);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM moderation_events')).rows[0].count),1);
  }finally{await f.close();}
});
