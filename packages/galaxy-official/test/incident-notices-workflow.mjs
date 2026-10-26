import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createIncidentController } from '../src/operations/incident.mjs';
import { deliverIncidentNotices } from '../src/operations/incident-notices.mjs';
import { runtimeConfigSnapshot,recordRuntimeConfig } from '../src/operations/runtime-config-audit.mjs';
import { createApi } from '../src/http.mjs';
import { deletionPreview } from '../src/operations/deletion-preview.mjs';
import { lockDeletionTables } from '../src/operations/deletion-execute.mjs';
import { transaction } from "../src/infrastructure/database.mjs";

export async function verifyIncidentNotices(database=null,options={}){
  const endpoint='https://official.example.org',now=2000000000;
  const policy={version:1,id:'synthetic-notices-'+randomUUID(),revision:1,endpoint,state:'contained',updatedAt:now,publicMessage:'Public outage notice',recovery:null};
  const incident=createIncidentController(policy,{endpoint,now:()=>now});
  const f=await serviceFixture(['binding','consent','case-teaser','notifications','data-export'],database,{...options,incident});
  const p=await serviceFixture(['binding','consent','notifications','data-export'],f.db,{...options,migrateDatabase:false,incident});
  const admin=options.operationsDb??f.db;
  const api=createApi({...f});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const send=async(actor,path,body={})=>{const res=await fetch(`http://127.0.0.1:${api.address().port}${path}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${actor.credential}`},body:JSON.stringify(body)});return {status:res.status,data:await res.json()};};
  try{
    await recordRuntimeConfig(admin,{endpoint,component:'api',snapshot:runtimeConfigSnapshot({incident:policy})});
    const notices=[{id:randomUUID(),subjectId:f.actor.subjectId,title:'Private incident update',summary:'Recipient A only'},
      {id:randomUUID(),subjectId:p.actor.subjectId,title:'Private incident update',summary:'Recipient B only'},
      {id:randomUUID(),subjectId:f.actor.subjectId,title:'Recovery advice',summary:'Recipient A recovery'}];
    const command={version:1,id:randomUUID(),endpoint,incidentId:policy.id,incidentRevision:1,operatorRef:'synthetic-operator',notices};
    assert.equal((await deliverIncidentNotices(admin,command)).delivered,3);
    assert.equal((await deliverIncidentNotices(admin,command)).replayed,true);
    await assert.rejects(deliverIncidentNotices(admin,{...command,operatorRef:'different'}),/conflict/);
    const page=await send(f,'/v1/notifications/query',{limit:1});assert.equal(page.status,200);assert.equal(page.data.items.length,1);assert.ok(page.data.nextAfter);
    const next=await send(f,'/v1/notifications/query',{after:page.data.nextAfter});assert.equal(next.data.items.length,1);
    assert.ok(!JSON.stringify([page,next]).includes('Recipient B only'));
    assert.equal((await send(p,'/v1/notifications/query')).data.items.length,1);
    assert.equal((await send(f,'/v1/notifications/read',{id:'incident:'+notices[1].id})).status,404);
    assert.equal((await send(f,'/v1/notifications/read',{id:page.data.items[0].id})).status,200);
    assert.equal((await send(f,'/v1/notifications/query',{unreadOnly:true})).data.items.length,1);
    const prefs=(await send(f,'/v1/notifications/preferences/read')).data;
    assert.equal((await send(f,'/v1/notifications/preferences/save',{expectedRevision:prefs.revision,settings:{...prefs.settings,incidents:false}})).status,200);
    assert.equal((await send(f,'/v1/notifications/query')).data.items.length,0);
    assert.equal((await send(f,'/v1/data-exports/page',{})).status,503);
    const ticket=await f.dataExport.create(f.actor,{id:randomUUID(),datasets:['incident-notices']});
    const exported=await f.dataExport.page(f.actor,{id:ticket.id,dataset:'incident-notices'});
    assert.equal(exported.items.length,2);assert.ok(!JSON.stringify(exported).includes('Recipient B only'));
    const preview=await deletionPreview(admin,f.actor.subjectId);assert.equal(preview.ownedDatasets['incident-notices'],2);
    await transaction(admin,db=>lockDeletionTables(db));
    const publicNotice=await (await fetch(`http://127.0.0.1:${api.address().port}/v1/service-status`)).json();
    assert.ok(!JSON.stringify(publicNotice).includes('Recipient A only'));
    await admin.query('DELETE FROM incident_notices WHERE id=$1',[notices[0].id]);
    await deliverIncidentNotices(admin,command);
    assert.equal((await admin.query('SELECT id FROM incident_notices WHERE id=$1',[notices[0].id])).rows.length,0);
    assert.ok(!JSON.stringify((await admin.query("SELECT * FROM audit_events WHERE action='incident.notice.deliver' AND request_id=$1",[command.id])).rows).includes('Recipient A only'));
  }finally{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!database)await f.db.close();}
}
