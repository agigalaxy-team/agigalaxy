import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {builderDeclaration} from './builders-workflow.mjs';
import {builderToolDefinitions} from '../src/personal-mcp-builders-v2.mjs';
import {createApi} from '../src/http.mjs';
export function supportFor(declaration){return {profile:'galaxy-builder-support/2',implementation:{name:declaration.name,version:declaration.release.version},
  galaxySchema:'2',protocols:[{name:'MCP',version:'fixture-version'}],sdks:[],objectActions:['case.read','attempt.map','proof.export'],
  missingCapabilities:['worker.execute'],authorization:'Exact signed consent for selected objects',limitations:'Synthetic compatibility scenario, not a tested real third-party product'};}
export function packFor(declaration){return {profile:'galaxy-worker-pack/1',name:declaration.name,version:declaration.release.version,
  source:declaration.release.artifact,sha256:declaration.release.buildHash,license:'Fixture licence declaration',licenseSource:'https://builder.example/license',
  dependencies:[{kind:'mcp',name:'fixture-mcp',version:'1',source:'https://builder.example/mcp',license:'Fixture'}],
  modelRequirements:'Owner supplied model',environment:'Fixture environment',permissions:[{resource:'Selected task',purpose:'Read explicitly granted context',required:true}],
  configurationRequirements:'Link a real separately recorded Configuration before actual work',capabilities:['Read selected metadata'],changes:'Initial synthetic fixture',
  installation:'Use original publisher mechanism',upgrade:'Choose a new version',rollback:'Return to prior host configuration',
  runtimeLocation:'user-controlled',automaticActivation:false};}
export async function verifyBuilderSupportV2Workflow(db=null,options={}){
  const scopes=['binding','consent','builders','data-export','data-delete'],f=await serviceFixture(scopes,db,{now:Math.floor(Date.now()/1000),...options}),
    assessor=await serviceFixture(scopes,f.db,{now:f.now,...options}),other=await serviceFixture(scopes,f.db,{now:f.now,...options});
  f.builders.assessorIds.add(assessor.actor.subjectId);const api=createApi({...f,rateLimit:1000});let address;
  const call=async(path,body,who=f)=>{const r=await fetch(address+path,{method:'POST',headers:{'Content-Type':'application/json',...(who?{Authorization:'Bearer '+who.credential}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const publish=async(event,who=f,view={visibility:'Public',purpose:'public-profile'})=>{
    const auth=await who.authorize(event,'builder.publish',view),result=await call('/v2/builders/support/events',auth,who);
    assert.equal(result.status,200,JSON.stringify(result.body));return {event,auth,receipt:result.body};
  };
  const read=id=>f.builders.v2.get(null,{builderId:id});
  try{
    await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));address='http://127.0.0.1:'+api.address().port;
    const builderId=randomUUID(),declaration=builderDeclaration('worker',f.actor.subjectId);
    const original={id:randomUUID(),kind:'declare',builderId,expectedRevision:0,declaration};
    await f.builders.publish(f.actor,await f.authorize(original,'builder.publish',{visibility:'Public',purpose:'public-profile'}));
    const initial=await read(builderId),event=fields=>({id:randomUUID(),builderId,expectedRevision:1,declarationId:initial.declarationId,declarationHash:initial.declarationHash,...fields});
    assert.equal(initial.support.state,'not-declared');assert.equal(initial.pack.actualUseCount,null);
    const profile=await publish(event({kind:'support-profile',support:supportFor(declaration)}));
    assert.equal((await read(builderId)).support.testedScopes.every(item=>item.state==='not-tested'),true);
    assert.deepEqual((await call('/v2/builders/support/events',profile.auth)).body,profile.receipt);
    const stale=event({kind:'support-profile',support:supportFor(declaration)});
    assert.equal((await call('/v2/builders/support/events',await f.authorize(stale,'builder.publish',{visibility:'Public',purpose:'public-profile'}))).status,409);
    const pack=await publish(event({kind:'pack-manifest',expectedRevision:2,manifest:packFor(declaration)}));
    const before=(await f.db.query('SELECT count(*)::int AS n FROM case_events')).rows[0].n;
    const exported=await call('/v2/builders/pack/export',{builderId,manifestId:pack.receipt.eventId},null);
    assert.equal(exported.status,200);assert.equal(exported.body.manifest.profile,'galaxy-worker-pack/1');assert.equal(exported.body.workerStarted,false);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM case_events')).rows[0].n,before,'export does not create Attempt or Result');
    const report=event({kind:'scope-report',expectedRevision:3,profile:'galaxy-builder-scope-report/1',supportId:profile.receipt.eventId,
      supportHash:(await read(builderId)).support.payloadHash,suite:{name:'fixture-suite',version:'1',sha256:'c'.repeat(64),source:'https://builder.example/suite'},
      run:{id:randomUUID(),sourceHash:'e'.repeat(64),reportHash:'f'.repeat(64),runnerVersion:'1',environment:'Synthetic selected integration scenario',testClass:'source-flow'},
      checks:[{action:'case.read',status:'pass',detail:'Fixture declared check'}],observedAt:f.now,expiresAt:f.now+1000,limitations:'Not a real third-party certification'});
    assert.equal((await call('/v2/builders/support/events',await f.authorize(report,'builder.publish',{visibility:'Public',purpose:'public-profile'}))).status,403);
    const passed=await publish(report,assessor);
    const view=await read(builderId);assert.equal(view.support.testedScopes[0].state,'reported-pass');assert.equal(view.support.testedScopes[1].state,'not-tested');assert.equal(view.reports[0].independentExecutionVerified,false);
    const viewTicket=await f.dataExport.create(other.actor,{id:randomUUID(),datasets:['authorized-views'],views:[{kind:'builder-support',id:builderId}]});
    const projected=await f.dataExport.page(other.actor,{id:viewTicket.id,dataset:'authorized-views'});
    assert.equal(projected.items[0].view.support.testedScopes[0].state,'reported-pass');
    const failed=await publish({...report,id:randomUUID(),expectedRevision:4,run:{...report.run,id:randomUUID()},checks:[{action:'case.read',status:'fail',detail:'Actual fixture failure report'}]},assessor);
    assert.equal((await read(builderId)).support.testedScopes[0].state,'reported-fail');
    await f.consents.revoke(assessor.actor,failed.auth.consentId);
    assert.equal((await read(builderId)).support.testedScopes[0].state,'not-tested','revoked newest failure does not revive older pass');
    const updated=await publish(event({kind:'support-profile',expectedRevision:5,support:{...supportFor(declaration),limitations:'Revised support scope'}}));
    assert.equal((await read(builderId)).reports.find(r=>r.id===passed.event.id).validity,'stale-support');
    await f.consents.revoke(f.actor,updated.auth.consentId);
    assert.equal((await read(builderId)).support.record,null,'no old support resurrection');
    const replacement={...original,id:randomUUID(),expectedRevision:6,declaration:{...declaration,release:{...declaration.release,version:'0.2.0'}}};
    await f.builders.publish(f.actor,await f.authorize(replacement,'builder.publish',{visibility:'Public',purpose:'public-profile'}));
    assert.equal((await read(builderId)).pack.state,'stale-declaration');assert.equal((await call('/v2/builders/pack/export',{builderId,manifestId:pack.event.id},null)).status,404);
    assert.equal((await f.builders.get(null,{builderId})).compatibility.state,'unverified','new scoped reports do not rewrite legacy meaning');
    const privateId=randomUUID(),privateDecl={...original,id:randomUUID(),builderId:privateId};
    await f.builders.publish(f.actor,await f.authorize(privateDecl,'builder.publish'));
    assert.equal((await call('/v2/builders/support/read',{builderId:privateId},other)).status,404);
    const mcp=builderToolDefinitions(f,f.actor);
    assert.equal((await mcp.galaxy_builder_support_read.run({builderId})).declarationId,replacement.id);
    assert.equal(mcp.galaxy_builder_support_publish.write,true);
    const ticket=await f.dataExport.create(f.actor,{id:randomUUID(),datasets:['builder-events']});
    const taken=await f.dataExport.page(f.actor,{id:ticket.id,dataset:'builder-events'});assert.ok(taken.items.some(row=>row.kind==='pack-manifest'));
  }finally{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!db)await f.db.close();}
}
