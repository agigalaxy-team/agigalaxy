import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createApi} from '../src/http.mjs';
import {choiceToolDefinitions} from '../src/personal-mcp-choices-v2.mjs';
import {approveFixtureDeletion} from './deletion-execute-workflow.mjs';
import {executeDeletion} from '../src/operations/deletion-execute.mjs';
export async function verifyChoiceSnapshots(database=null,options={}){
 const f=await serviceFixture([...new Set([...browserScopes,'data-export'])],database,{...options,now:Math.floor(Date.now()/1000)});let api;
 try{
  const rootId=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:rootId,caseId:rootId,expectedVersion:0,actorId:f.actor.subjectId,
    localRef:randomUUID(),title:'Choice source',summary:'Source text must never enter cloud choice',synthetic:true,source:{kind:'local',reference:randomUUID()}};
  const signed=await f.authorize(root,'case.teaser.publish',{objectId:rootId,visibility:'Public',purpose:'public-profile'});await f.cases.submitV2(f.actor,signed);
  api=createApi({...f,rateLimit:1000});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`;
  const request=async(path,input,credential=f.credential)=>{const response=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',...(credential?{authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(input)});return{status:response.status,body:await response.json()};};
  const call=async(path,x)=>{const r=await request('/v2/choice-snapshots/'+path,x);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const search={type:'history',query:{query:'Choice',limit:8}},page=await f.search.v2.query(f.actor,search),item=page.items[0];assert.ok(item);
  const content={localVersion:1,localTaskRef:'my-task',visibleRationale:'Relevant diagnosis requires checking',rationaleAuthor:'user-agent',candidateRefs:[{type:item.type,...item.ref}],selectedRefs:[{type:item.type,...item.ref}],resultRefs:[]};
  const snapshotId=randomUUID(),put={snapshotId,versionId:randomUUID(),baseRevision:0,preferenceRevision:1,content,witnesses:[{search,ref:item.ref}]};
  assert.equal((await call('preferences/read',{})).enabled,false);
  assert.equal((await choiceToolDefinitions(f,f.actor).galaxy_choice_preferences.run()).category,'choice-snapshot');
  assert.equal((await request('/v2/choice-snapshots/put',put)).status,403);
  await f.summaries.savePreference(f.actor,{endpoint:f.access.endpoint,expectedRevision:0,enabled:true});
  assert.equal((await request('/v2/choice-snapshots/put',put)).status,403,'room summary permission never enables choices');
  await call('preferences/save',{endpoint:f.access.endpoint,expectedRevision:0,enabled:true,snapshotIds:[snapshotId]});
  assert.equal((await request('/v2/choice-snapshots/put',{...put,snapshotId:randomUUID()})).status,403);
  const first=await call('put',put);assert.equal(first.syncState,'synced');assert.equal(first.current.content.visibleRationale,content.visibleRationale);
  const expiry=first.current.expiresAt;assert.equal((Date.parse(expiry)-Date.parse(first.current.createdAt))/86400000,30);
  const replay=await call('put',put);assert.equal(replay.replayed,true);assert.equal(replay.current.expiresAt,expiry);
  const originalClock=f.access.now;f.access.now=()=>f.now+60;
  const unchanged=await call('put',{...put,versionId:randomUUID(),baseRevision:1,content:{...content,localVersion:2}});assert.equal(unchanged.current.expiresAt,expiry,'new transport/version number alone does not extend content retention');
  f.access.now=originalClock;
  assert.equal((await request('/v2/choice-snapshots/put',{...put,content:{...content,visibleRationale:'different'}})).status,409);
  const conflict=await call('put',{...put,versionId:randomUUID(),content:{...content,visibleRationale:'Other device alternative'}});assert.equal(conflict.syncState,'conflict');assert.equal(conflict.current.content.visibleRationale,content.visibleRationale);assert.equal(conflict.conflicts.length,1);
  const chosen=await call('put',{...put,versionId:randomUUID(),baseRevision:2,content:{...content,localVersion:3,visibleRationale:'Explicit comparison result'},resolveVersionIds:[conflict.conflicts[0].versionId]});
  assert.equal(chosen.revision,3);assert.equal(chosen.conflicts.length,0);
  const row=(await f.db.query('SELECT content,dependencies FROM choice_snapshot_versions WHERE version_id=$1',[chosen.current.versionId])).rows[0];
  assert.equal(JSON.stringify(row).includes(root.summary),false);assert.equal(JSON.stringify(row).includes('"query"'),false);assert.equal(JSON.stringify(row).includes('context'),false);
  assert.equal((await request('/v2/choice-snapshots/get',{snapshotId},null)).status,401);
  const other=await serviceFixture([...new Set([...browserScopes,'data-export'])],f.db,{migrateDatabase:false,now:f.now});
  assert.equal((await request('/v2/choice-snapshots/get',{snapshotId},other.credential)).body.current,null);
  await f.consents.revoke(f.actor,signed.consentId);
  const invalid=await call('get',{snapshotId});assert.equal(invalid.current.content.visibleRationale,null);assert.equal(invalid.current.priorRationaleCurrent,false);
  assert.equal((await request('/v2/choice-snapshots/put',{...put,versionId:randomUUID(),baseRevision:3})).status,409);
  const ticket=await f.dataExport.create(f.actor,{id:randomUUID(),datasets:['authorized-views','choice-snapshot-version-receipts'],views:[{kind:'choice-snapshot',id:snapshotId}]});
  const exported=await f.dataExport.page(f.actor,{id:ticket.id,dataset:'authorized-views'});assert.equal(exported.items[0].view.current.content.visibleRationale,null);
  const receipts=await f.dataExport.page(f.actor,{id:ticket.id,dataset:'choice-snapshot-version-receipts'});assert.ok(receipts.items.length);assert.equal(JSON.stringify(receipts).includes('Explicit comparison result'),false);
  const cleanup=await f.choices.purgeInvalidSources();assert.ok(cleanup.redacted>0);const cleaned=(await f.db.query('SELECT content FROM choice_snapshot_versions WHERE version_id=$1',[chosen.current.versionId])).rows[0];assert.equal(cleaned.content.visibleRationale,null);
  // Reaching a stored expiration is checked before any source body is read.
  await f.db.query('UPDATE choice_snapshot_versions SET expires_at=$2 WHERE version_id=$1',[chosen.current.versionId,new Date((f.now-1)*1000).toISOString()]);
  const expired=await call('get',{snapshotId});assert.equal(expired.current.state,'expired');assert.deepEqual(expired.current.content,{});
  await call('delete',{snapshotId,expectedRevision:3});assert.equal((await call('get',{snapshotId})).deleted,true);
  await call('preferences/save',{endpoint:f.access.endpoint,expectedRevision:1,enabled:false,snapshotIds:[]});
  assert.equal((await request('/v2/choice-snapshots/put',put)).status,403,'disabled sync rejects old replay');
  const admin=options.adminDatabase??f.db,command=await approveFixtureDeletion(f,admin,{auditUntil:f.now+60});
  const erased=await executeDeletion(admin,command,{now:()=>f.now});
  assert.ok(erased.physicalDeletionPerformed);for(const table of ['choice_snapshot_preferences','choice_snapshot_heads','choice_snapshot_versions'])assert.equal(Number((await admin.query(`SELECT count(*) AS n FROM ${table} WHERE subject_id=$1`,[f.actor.subjectId])).rows[0].n),0);
  return{actualHttp:true,ownerPrivate:true,conflictVersionsPreserved:true,sourceRevocation:true,cloudQueryStored:false};
 }finally{if(api)await new Promise(resolve=>api.close(resolve));if(!database)await f.db.close();}
}
