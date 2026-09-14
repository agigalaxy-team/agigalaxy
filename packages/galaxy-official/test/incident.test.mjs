import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createIncidentController,loadIncidentController } from '../src/operations/incident.mjs';
import { runtimeConfigSnapshot,recordRuntimeConfig,exportRuntimeConfigPage } from '../src/operations/runtime-config-audit.mjs';

const policy=(now=2000000000)=>({version:1,id:'synthetic-incident',revision:1,endpoint:'https://official.example.org',
  state:'contained',updatedAt:now,publicMessage:'Synthetic service incident. Sharing is paused.',recovery:null});

test('incident pauses HTTP sharing and publication while revocation survives explicit recovery',async()=>{
  const f=await serviceFixture(['binding','consent','case-teaser','data-export']);
  const input=policy(f.now), options={endpoint:f.bindings.endpoint,now:()=>f.now};
  let api;
  const start=async incident=>{
    if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}
    api=createApi({...f,incident});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    return async(method,path,body={},credential=f.credential)=>{
      const res=await fetch(`http://127.0.0.1:${api.address().port}${path}`,{method,
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${credential}`},
        ...(method==='POST'?{body:JSON.stringify(body)}:{})});
      return {status:res.status,data:await res.json()};
    };
  };
  try{
    const root={id:randomUUID(),kind:'case',localRef:'incident',title:'Synthetic',summary:'Private incident case',source:{kind:'local',reference:'synthetic'},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    const grant=await f.authorize(root);await f.cases.submit(f.actor,grant);
    const incident=createIncidentController(input,options);
    const request=await start(incident);
    assert.equal(incident.canProcessEvidence(),false);
    assert.equal((await request('GET','/healthz')).status,200);
    assert.equal((await request('GET','/readyz')).status,503);
    const notice=await request('GET','/v1/service-status');
    assert.equal(notice.status,200);assert.equal(notice.data.incident.state,'contained');
    assert.equal(notice.data.businessWritesAccepted,false);assert.equal(notice.data.downloadsAccepted,false);
    for(const [method,path] of [['POST','/v1/cases'],['GET',`/v1/cases/${root.id}`],['POST','/v1/context-grants'],['POST','/v1/data-exports/page'],['POST','/v1/history/query'],['POST','/mcp/docs'],['POST','/mcp/personal']]){
      const result=await request(method,path);assert.equal(result.status,503,path);assert.equal(result.data.error,'service_incident_contained');
    }
    assert.equal((await request('POST',`/v1/consents/${grant.consentId}/revoke`,{},'invalid')).status,401);
    assert.equal((await request('POST',`/v1/consents/${grant.consentId}/revoke`)).status,200);
    const recovered=createIncidentController({...input,revision:2,state:'resolved',recovery:{checkedAt:f.now,evidenceSha256:'a'.repeat(64)}},options);
    const after=await start(recovered);
    assert.equal((await after('GET','/readyz')).status,200);assert.equal(recovered.canProcessEvidence(),true);
    const revoked=await after('GET',`/v1/cases/${root.id}`);
    assert.notEqual(revoked.status,200);assert.notEqual(revoked.status,503);
    assert.ok(!JSON.stringify(revoked).includes('Private incident case'));
    const fresh={...root,id:randomUUID(),localRef:'after-recovery',source:{kind:'local',reference:'after-recovery'}};
    assert.equal((await after('POST','/v1/cases',await f.authorize(fresh))).status,200);
  }finally{if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}await f.db.close();}
});

test('API and Worker incident observations preserve revisions and recovery history without private message text',async()=>{
  const f=await serviceFixture();
  try{
    const first=policy(f.now), second={...first,revision:2,state:'recovery'};
    for(const component of ['api','worker']){
      const record=incident=>recordRuntimeConfig(f.db,{endpoint:first.endpoint,component,snapshot:runtimeConfigSnapshot({incident})});
      const start=await record(first);await record(first);
      await assert.rejects(record(null),/cannot be removed/);
      await assert.rejects(record({...first,publicMessage:'Same revision changed'}),/revision conflict/);
      await record(second);
      await assert.rejects(record(first),/revision conflict/);
      await record({...second,revision:3,state:'resolved',recovery:{checkedAt:f.now,evidenceSha256:'b'.repeat(64)}});
      const archive=await exportRuntimeConfigPage(f.db,{endpoint:first.endpoint,component});
      assert.equal(archive.events.length,4);
      assert.ok(!JSON.stringify(archive).includes(first.publicMessage));
      assert.ok(start.payload.snapshot.incident.sha256);
      await record(null);
    }
  }finally{await f.db.close();}
});

test('incident configuration is explicit, never expires into recovery, and requires a recovery evidence reference',async()=>{
  const first=policy(),directory=await mkdtemp(join(tmpdir(),'galaxy-incident-'));
  try{
    const path=join(directory,'incident.json');await writeFile(path,JSON.stringify(first));
    const incident=await loadIncidentController(path,{endpoint:first.endpoint,now:()=>first.updatedAt+864000});
    assert.equal(incident.canProcessEvidence(),false);
    assert.throws(()=>incident.assertRoute('POST','/v1/new-future-route'),/incident_contained/);
    assert.throws(()=>createIncidentController({...first,state:'resolved'},{endpoint:first.endpoint}),/./);
    assert.throws(()=>createIncidentController(first,{endpoint:'https://other.example.org',now:()=>first.updatedAt}),/mismatch/);
    const copy=incident.policy();copy.state='resolved';assert.equal(incident.snapshot().state,'contained');
    assert.equal((await loadIncidentController(null,{endpoint:first.endpoint})).canProcessEvidence(),true);
  }finally{await rm(directory,{recursive:true,force:true});}
});
