import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from "../../src/infrastructure/database.mjs";
import { serviceFixture } from '../service-fixture.mjs';
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { builderDeclaration } from '../builders-workflow.mjs';

export async function verifySearchWorker(){
  const admin=new pg.Pool();let db,apiDb,child,result;const events=[];
  async function stop(){if(!child||child.exitCode!==null)return;if(process.platform==='win32')child.send('stop-fixture');else{child.disconnect();child.kill('SIGTERM');}
    const ended=await result;assert.equal(ended.code,0);child=null;}
  const wait=async condition=>{for(let i=0;i<150;i++){if(await condition())return;if(child?.exitCode!==null&&child?.exitCode!==undefined)throw new Error('Index worker exited');await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Index worker did not settle');};
  try{
    await admin.query('CREATE DATABASE galaxy_integration');db=new pg.Pool({database:'galaxy_integration'});await migrate(db);
    for(const name of ['api','worker'])await db.query(await readFile(new URL(`../../src/infrastructure/${name}-role.sql`,import.meta.url),'utf8'));
    apiDb=new pg.Pool({database:'galaxy_integration',options:'-c role=galaxy_api'});
    const now=Math.floor(Date.now()/1000),f=await serviceFixture(['binding','consent','case-teaser','history','builders'],apiDb,{migrateDatabase:false,repositories:apiReads,now});
    const root={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Actual worker index',summary:'Public compiler source',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    const grant=await f.authorize(root,'case.teaser.publish',{visibility:'Public',purpose:'public-profile'});await f.cases.submit(f.actor,grant);
    const target={protocol:'a2a/1.0',transport:'JSONRPC',endpoint:'https://peer.example.org/a2a',cardUrl:'https://peer.example.org/.well-known/agent-card.json',tenant:''},builderId=randomUUID();
    const declare={id:randomUUID(),builderId,expectedRevision:0,kind:'declare',declaration:{...builderDeclaration('worker',f.actor.subjectId),a2a:target}};
    await f.builders.publish(f.actor,await f.authorize(declare,'builder.publish'));
    const current=await f.builders.get(f.actor,{builderId}),control={id:randomUUID(),builderId,expectedRevision:1,kind:'node-control',declarationId:declare.id,declarationHash:current.declarationHash,nodeId:f.actor.subjectId,ownerId:f.actor.subjectId,expiresAt:now+600};
    await f.builders.publish(f.actor,await f.authorize(control,'builder.publish'));
    const probe={id:randomUUID(),builderId,expectedRevision:2,kind:'probe-request',declarationId:declare.id,declarationHash:current.declarationHash,controlId:control.id,nodeId:f.actor.subjectId,target};
    const probeGrant=await f.authorize(probe,'builder.publish');await f.builders.publish(f.actor,probeGrant);await f.consents.revoke(f.actor,probeGrant.consentId);
    const url=new URL(`postgresql://${process.env.PGHOST}:${process.env.PGPORT}/galaxy_integration`);url.username=process.env.PGUSER;url.password=process.env.PGPASSWORD;
    const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('GALAXY_')&&name!=='DATABASE_URL'));
    Object.assign(env,{GALAXY_ENVIRONMENT:'integration',GALAXY_ENDPOINT:f.access.endpoint,DATABASE_URL:url.href,PGOPTIONS:'-c role=galaxy_evidence_worker',GALAXY_SEARCH_INDEX_ENABLED:'true'});
    function launch(){
      const args=process.platform==='win32'?['--import',new URL('./stop-channel.mjs',import.meta.url).href]:[];
      child=spawn(process.execPath,[...args,fileURLToPath(new URL('../../src/worker.mjs',import.meta.url))],{env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
      result=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
      for(const stream of [child.stdout,child.stderr]){let pending='';stream.on('data',bytes=>{pending+=bytes.toString();let end;
        while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);try{const row=JSON.parse(line);if(['search_index_job','builder_probe_job'].includes(row.event))events.push({event:row.event,state:row.state});}catch{}}
      });}
    }
    launch();await wait(async()=>Number((await db.query('SELECT count(*) FROM search_documents WHERE source_id=$1',[root.id])).rows[0].count)===2);
    await wait(async()=>(await db.query('SELECT observation FROM builder_probes WHERE request_id=$1',[probe.id])).rows[0]?.observation.status==='revoked');
    const served=await f.search.query(null,{type:'history',query:{subjectId:f.actor.subjectId}});assert.equal(served.items[0].id,root.id);assert.equal(served.index.mode,'public-candidate-index');
    await stop();await f.consents.revoke(f.actor,grant.consentId);
    assert.equal((await f.search.query(null,{type:'history',query:{subjectId:f.actor.subjectId}})).items.length,0);
    launch();await wait(async()=>Number((await db.query("SELECT count(*) FROM jobs WHERE kind='search-index' AND state IN ('pending','running')")).rows[0].count)===0);
    await stop();assert.equal((await db.query('SELECT * FROM search_documents WHERE source_id=$1',[root.id])).rows.length,0);
    assert.ok(events.some(row=>row.state==='indexed'));assert.ok(events.some(row=>row.state==='hidden'));
    assert.equal((await db.query("SELECT payload FROM runtime_config_events WHERE component='worker' ORDER BY sequence DESC LIMIT 1")).rows[0].payload.snapshot.searchIndexMode,'enabled');
    assert.ok(events.some(row=>row.event==='builder_probe_job'&&row.state==='revoked'));
    return {actualWorker:true,restart:true,publicSearch:true,revokedSourceHidden:true,builderProbeRevocation:true};
  }finally{try{await stop();}finally{if(apiDb)await apiDb.end();if(db)await db.end();await admin.end();}}
}
