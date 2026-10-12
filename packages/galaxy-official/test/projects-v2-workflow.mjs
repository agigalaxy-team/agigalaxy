import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';

export async function verifyProjectsV2(database=null,options={}) {
  const config={...options,now:Math.floor(Date.now()/1000)},scopes=['binding','consent','history','notifications','data-export'];
  const f=await serviceFixture(scopes,database,config),p=await serviceFixture(scopes,f.db,{...config,migrateDatabase:false}),q=await serviceFixture(scopes,f.db,{...config,migrateDatabase:false});
  // Deliberate read/role workflow fixture. Actual OIDC/public Account acceptance
  // is tested separately; production construction always injects the registry.
  for(const fixture of [f,p,q])fixture.projects.requireAccountWithin=async()=>({syntheticFixture:true,accountVerificationNotTested:true});
  const api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`;
  const request=async(fixture,path,input,status=200)=>{
    const response=await fetch(origin+path,{method:input===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(fixture?{Authorization:'Bearer '+fixture.credential}:{})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;
  };
  const sign=(fixture,event,extra={})=>fixture.authorize(event,'project.write',{objectId:event.operationId,visibility:'Public',purpose:'public-profile',...extra});
  const write=async(fixture,event,status=200,extra={})=>{const grant=await sign(fixture,event,extra);return {event,grant,result:await request(fixture,'/v2/projects',grant,status)};};
  const projectId=randomUUID(),doc={kind:'module',title:'Synthetic table extraction',summary:'A module, not a verified accomplishment',functions:['table-extraction'],technologies:['Rust'],discoverable:true};
  const read=()=>request(null,'/v2/projects/'+projectId);
  let revision=1;
  const update=(fixture,kind,fields={},status=200)=>write(fixture,{operationId:randomUUID(),projectId,expectedRevision:revision,kind,...fields},status);
  try{
    const statement={id:randomUUID(),expectedRevision:0,selfDeclared:{projects:[{id:projectId,...doc}]}};
    const legacy=await f.authorize(statement,'profile.publish',{visibility:'Public',purpose:'public-profile'});
    await f.profiles.publish(f.actor,legacy);
    const created=await write(f,{operationId:randomUUID(),projectId,expectedRevision:0,kind:'create',document:doc,sourceStatementId:statement.id});
    assert.equal(created.result.projectId,projectId);
    assert.equal((await request(f,'/v2/projects',created.grant)).replayed,true);
    assert.equal((await f.db.query('SELECT payload_text FROM profile_statements WHERE id=$1',[statement.id])).rows[0].payload_text,legacy.payloadJson);
    const initial=await read();assert.equal(initial.ownerId,f.actor.subjectId);assert.equal(initial.source.sourceStatementId,statement.id);assert.equal(initial.legalOwnershipVerified,false);
    const portfolio=await request(null,'/v2/projects/portfolio/query',{ownerId:f.actor.subjectId});
    assert.deepEqual(portfolio.items.map(item=>item.projectId),[projectId]);
    assert.equal(portfolio.readingGrantsContact,false);
    assert.equal((await request(null,'/v2/projects/directory/query',{})).items.some(item=>item.projectId===projectId),false);
    await update(p,'revise',{patch:{summary:'No permission'}},403);
    await update(f,'grant-role',{subjectId:p.actor.subjectId,role:'editor'});revision++;
    const editor=await request(p,'/v2/projects/'+projectId);assert.equal(editor.permissions.edit,true);assert.equal(editor.permissions.represent,false);assert.equal(editor.permissions.agentControl,false);
    const edited=await update(p,'revise',{patch:{summary:'Editor independent contribution',extensions:{uninterpreted:'preserve-me'}}});revision++;
    assert.equal((await read()).document.summary,'Editor independent contribution');
    assert.deepEqual((await read()).document.technologies,['Rust'],'a partial patch must not apply creation defaults');
    await update(p,'grant-role',{subjectId:q.actor.subjectId,role:'representative'},403);
    await update(p,'revise',{patch:{discoverable:false}},403);
    await update(f,'revise',{patch:{title:'Updated title'}});revision++;
    assert.equal((await read()).document.extensions.uninterpreted,'preserve-me');
    await update(f,'revoke-role',{subjectId:p.actor.subjectId,role:'editor'});revision++;
    await update(p,'revise',{patch:{summary:'Revoked editor'}},403);
    assert.equal((await request(p,'/v2/projects/'+projectId)).permissions.edit,false);
    await p.consents.revoke(p.actor,edited.grant.consentId);
    await request(null,'/v2/projects/'+projectId,undefined,404);
    await update(f,'revise',{patch:{summary:'Owner replacement of unavailable source'}});revision++;
    assert.equal((await read()).document.summary,'Owner replacement of unavailable source');
    assert.equal((await read()).document.extensions,undefined,'revoked independent field is not resurrected');
    await update(f,'grant-role',{subjectId:q.actor.subjectId,role:'representative'});revision++;
    assert.equal((await request(q,'/v2/projects/'+projectId)).permissions.represent,true);
    assert.equal((await request(q,'/v2/projects/'+projectId)).permissions.edit,false);
    const cancelledTransfer=randomUUID();await update(f,'offer-transfer',{transferId:cancelledTransfer,toSubjectId:p.actor.subjectId});revision++;
    const offered=await request(p,'/v2/projects/query',{});
    assert.equal(offered.items.find(item=>item.projectId===projectId).management.transfers[0].transferId,cancelledTransfer);
    assert.deepEqual((await read()).management,{roles:[],transfers:[]},'public readers do not receive management lists');
    assert.equal((await read()).ownerId,f.actor.subjectId);
    await update(f,'cancel-transfer',{transferId:cancelledTransfer});revision++;
    assert.equal((await request(p,'/v2/projects/'+projectId)).management.transfers.length,0,'cancelled transfer is absent immediately');
    await update(p,'accept-transfer',{transferId:cancelledTransfer},409);
    const transferId=randomUUID();await update(f,'offer-transfer',{transferId,toSubjectId:p.actor.subjectId});revision++;
    await update(q,'accept-transfer',{transferId},409);
    const accepted=await update(p,'accept-transfer',{transferId});revision++;
    assert.equal((await read()).ownerId,p.actor.subjectId);assert.equal((await request(p,'/v2/projects',accepted.grant)).replayed,true);
    await update(f,'archive',{},403);
    await update(p,'archive');revision++;
    await request(null,'/v2/projects/'+projectId,undefined,404);
    assert.equal((await request(p,'/v2/projects/'+projectId)).state,'archived');
    await update(p,'restore');revision++;
    assert.equal((await read()).state,'active');
    const ownList=await request(p,'/v2/projects/query',{});assert.ok(ownList.items.some(item=>item.projectId===projectId));
    const publicDeclaration={operationId:randomUUID(),projectId:randomUUID(),expectedRevision:0,kind:'create',document:{...doc,participantKind:'agent'}};
    await write(q,publicDeclaration);
    for(const fixture of [f,p,q]){const prefs=await fixture.discovery.preferences(fixture.actor);await fixture.discovery.save(fixture.actor,{expectedRevision:prefs.revision,preferences:{enabled:true}});}
    const queryInput={context:{kind:'ephemeral',title:'Extraction',functions:['table-extraction']},purposes:['conversation']};
    const page=await request(null,'/v2/discovery/query',queryInput);
    assert.equal(page.items.filter(item=>item.projectId===projectId).length,1,'imported declaration and independent project must not duplicate');
    assert.equal(page.items.find(item=>item.projectId===projectId).subjectId,p.actor.subjectId);
    assert.equal(page.items.find(item=>item.projectId===publicDeclaration.projectId).participant.kind,'agent');
    const selected=page.items.find(item=>item.projectId===projectId);
    const detail=await request(null,'/v2/discovery/detail',{...queryInput,opportunityRef:selected.opportunityRef});
    assert.equal(detail.opportunity.opportunityRef.sourceKind,'project');
    await request(p,`/v2/projects/${projectId}/preferences/save`,{expectedRevision:0,preferences:{enabled:false}});
    assert.equal((await request(null,'/v2/discovery/query',queryInput)).items.some(item=>item.projectId===projectId),false);
    assert.ok((await request(null,'/v2/projects/portfolio/query',{ownerId:p.actor.subjectId})).items.some(item=>item.projectId===projectId),'an invitation preference does not erase a publicly shared work');
    assert.ok((await request(null,'/v2/discovery/query',queryInput)).items.some(item=>item.projectId===publicDeclaration.projectId),'project setting must not disable another project');
    await request(p,`/v2/projects/${projectId}/preferences/save`,{expectedRevision:1,preferences:null});
    assert.equal((await request(null,'/v2/discovery/query',queryInput)).items.some(item=>item.projectId===projectId),true);
    const active=await request(q,'/v2/discovery/query',{...queryInput,context:{kind:'project',projectId:projectId}});
    assert.equal(active.sourceContext.ref.sourceKind,'project');
    const failing={...publicDeclaration,operationId:randomUUID(),projectId:randomUUID()};
    const adapter=f.projects.requireAccountWithin;f.projects.requireAccountWithin=null;
    await write(f,failing,503);f.projects.requireAccountWithin=adapter;
    assert.equal((await f.db.query('SELECT id FROM projects_v2 WHERE id=$1',[failing.projectId])).rows.length,0);
    return {actualHttp:true,stableImport:true,editorRepresentativeOwnerSeparated:true,revocationNoOldValueFallback:true,
      acceptedTransfer:true,projectPreferences:true,discoveryIntegration:true,accountAdapterFailClosed:true};
  }finally{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!database)await f.db.close();}
}
