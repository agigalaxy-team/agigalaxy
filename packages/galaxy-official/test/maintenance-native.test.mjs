import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {request} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMaintenanceNativeHttpServer} from '../deploy/maintenance-agent/server.mjs';
import {MaintenanceNativeRuntime} from '../deploy/maintenance-agent/runtime.mjs';
import {MaintenanceControlJournal} from '../deploy/maintenance-agent/journal.mjs';
import {MaintenanceRestoreExecutor} from '../deploy/maintenance-agent/restore-executor.mjs';
import {MaintenanceNativeClient,maintenanceRequestSignature} from '../src/operations-maintenance-native.mjs';
import {maintenanceOpeningConditions} from '../src/operations-maintenance-catalog.mjs';
import {resolveMaintenanceFootprint,maintenanceCaptureConfiguration,maintenanceCaptureContext,currentContainerBindings} from '../deploy/maintenance-agent/footprint.mjs';
import {createProductBackup} from '../deploy/operations-stack/backup.mjs';

const linux={skip:process.platform!=='linux'?'Native permission and Unix-socket contract requires Linux.':false};
const result=stdout=>({code:0,stdout});
const fail=code=>Object.assign(Error(code),{code});
async function temporary(t){const directory=await mkdtemp(join(tmpdir(),'galaxy-maintenance-native-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}

// These tests run the new socket server/runtime and filesystem journal. Native
// commands, monitoring transports and stage effects are explicit doubles. They
// never stop a real service, back up a repository or restore production data.
test('maintenance native socket authenticates before body, binds exact HMAC intent and exposes only closed read commands',linux,async t=>{
 const directory=await temporary(t),key='synthetic-maintenance-service-identity-20261023',now=1792742400;
 const runtime=new MaintenanceNativeRuntime({configuration:{controlDirectory:directory+'/control',operations:{environment:'synthetic',directories:{captures:directory},monitoring:{prometheusUrl:'http://127.0.0.1:1'},loki:{port:1}}},
  now:()=>new Date(now*1000),footprint:async()=>({coverage:[],services:[{id:'api',state:'available',active:true}],containers:[]}),
  fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({status:'success',data:{activeTargets:[],result:[]}})})});
 const server=createMaintenanceNativeHttpServer({runtime,serviceKey:key,now:()=>now}),socketPath=directory+'/native.sock';
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const post=({body='{"kind":"overview"}',suppliedKey=key,id=randomUUID(),at=String(now),signature=null,path='/v1/maintenance'}={})=>new Promise((resolve,reject)=>{
  const headers={'content-type':'application/json','content-length':Buffer.byteLength(body),'x-galaxy-request-id':id,'x-galaxy-request-at':at,'x-galaxy-service-signature':signature??maintenanceRequestSignature(key,{id,at,body})};if(suppliedKey!==null)headers['x-galaxy-service-key']=suppliedKey;
  const req=request({socketPath,path,method:'POST',headers},response=>{const chunks=[];response.on('data',c=>chunks.push(c));response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));});req.on('error',reject);req.end(body);
 });
 assert.equal((await post({suppliedKey:null,body:'not-json'})).status,401);
 assert.equal((await post({suppliedKey:'wrong-synthetic-key',body:'not-json'})).status,401);
 assert.equal((await post({signature:'0'.repeat(64)})).status,401);
 assert.equal((await post({path:'/v1/maintenance?kind=restore'})).status,404);
 const denied=await post({body:JSON.stringify({kind:'arbitrary-shell',command:'must-not-echo-this'})});assert.equal(denied.status,400);assert.ok(!JSON.stringify(denied).includes('must-not-echo-this'));
 const sameId=randomUUID(),okay=await post({id:sameId});assert.equal(okay.status,200);assert.equal(okay.body.components[0].health,'unknown');assert.equal(okay.body.components[0].processState,'running');
 assert.equal((await post({id:sameId})).status,409);
 const client=new MaintenanceNativeClient({socketPath,key,now:()=>now});assert.equal((await client.call({kind:'overview'})).availability.state,'available');
 await assert.rejects(client.call({kind:'overview',command:'forbidden'}),{code:'invalid_maintenance_request'});
 const body=JSON.stringify({operationId:randomUUID(),operatorId:'synthetic-operator',kind:'backup-create'}),id=randomUUID(),at=String(now);
 const ctx=client.verifyService({headers:{'x-galaxy-service-key':key,'x-galaxy-request-id':id,'x-galaxy-request-at':at,'x-galaxy-service-signature':maintenanceRequestSignature(key,{id,at,body})}});
 assert.doesNotThrow(()=>client.verifyBody(ctx,body));assert.throws(()=>client.verifyBody(ctx,body.replace('backup-create','backup-verify')),{code:'maintenance_service_denied'});
});

test('maintenance resolves current releases and owned volumes and aborts changed post-pause captures while resuming writers',linux,async t=>{
 const info=(file=false,link=false)=>({size:128,isFile:()=>file,isSymbolicLink:()=>link});let release='0.1.99';
 const config={tools:{systemctl:'/usr/bin/systemctl',docker:'/usr/bin/docker'},postgres:[{id:'business',container:'business-pg',socketPath:'/tmp',administrator:'postgres',database:'galaxy_pilot'},{id:'accounts',container:'accounts-pg',socketPath:'/tmp',administrator:'postgres',database:'galaxy_accounts'}],backup:{writers:[{kind:'systemd',name:'galaxy-api@pilot.service'}],sources:[
  {id:'configuration',path:'/etc/galaxy',kind:'tree'},{id:'prosody',path:'/var/lib/galaxy/prosody',kind:'tree'},{id:'garage',path:'/var/lib/galaxy/garage',kind:'tree'},
  {id:'website-release',path:'/srv/galaxy/website/current',kind:'tree'},{id:'api-release',path:'/opt/galaxy/releases/0.1.1',kind:'tree'},{id:'admin-release',path:'/srv/galaxy/admin/releases/0.1.1',kind:'tree'},{id:'website-base-release',path:'/srv/galaxy/website/releases/0.1.1',kind:'tree'}]}};
 const fs={lstat:async path=>info(path.endsWith('.env'),path.endsWith('/assets')),readFile:async path=>path.includes('agentos')?'GALAXY_AGENTOS_DATABASE_URL=postgresql://synthetic:never-export-this@127.0.0.1:15532/galaxy_agentos\n':`GALAXY_RELEASE_DIRECTORY=/opt/galaxy/releases/${release}\nUNRELATED_SECRET=never-export-this\n`,
  realpath:async path=>path==='/srv/galaxy/website/current'?'/srv/galaxy/website/releases/.cms-synthetic':path.endsWith('/assets')?`/srv/galaxy/website/releases/${release}/assets`:path,
  readdir:async path=>path.endsWith('.cms-synthetic')?['assets']:[]};
 const run=async(_command,args)=>{
  if(args[0]==='show'){const admin=args.includes('galaxy-admin-pilot.service');return result(`LoadState=loaded\nActiveState=active\nWorkingDirectory=${admin?'/srv/galaxy/admin/releases/'+release:'/opt/galaxy'}\nExecStart=/usr/bin/node runtime.mjs\nEnvironmentFiles=${admin?'':'/etc/galaxy/pilot/api.env (ignore_errors=no)'}\n`);}
  if(args[0]==='inspect'&&args[2]==='{{json .NetworkSettings.Ports}}')return result(JSON.stringify({'5432/tcp':[{HostIp:'127.0.0.1',HostPort:args.at(-1)==='business-pg'?'15532':'15533'}]}));
  if(args[0]==='inspect'){const binding=currentContainerBindings.find(x=>x.name===args.at(-1));assert.ok(binding);const mounts=binding.id==='agentos'?[]:[{Type:'volume',Source:'/var/lib/docker/volumes/galaxy-synthetic-'+binding.id+'/_data',Destination:'/data',RW:true}];return result(JSON.stringify({image:'sha256:'+'a'.repeat(64),state:'running',mounts,composeDirectory:'/opt/galaxy/operations-engines/releases/synthetic'}));}
  if(args.includes('psql'))return result(JSON.stringify(['galaxy_pilot','galaxy_accounts','galaxy_agentos']));
  throw Error('unexpected synthetic native command');
 };
 const footprint=await resolveMaintenanceFootprint(config,{run,fs});assert.ok(footprint.coverage.every(x=>x.state==='covered'));
 assert.ok(footprint.sources.some(s=>s.path==='/opt/galaxy/releases/0.1.99'));assert.ok(!footprint.sources.some(s=>s.path.endsWith('/0.1.1')));assert.ok(footprint.sources.some(s=>s.path==='/srv/galaxy/website/releases/0.1.99'));
 assert.ok(footprint.sources.some(s=>s.owner==='galaxy-discovery-op-ch-1'&&s.captureMode==='bounded-quiesced-volume'));assert.ok(!footprint.sources.some(s=>s.owner==='galaxy-attachment-scanner'));
 assert.ok(footprint.writers.findIndex(x=>x.name==='galaxy-discovery-op-api-1')<footprint.writers.findIndex(x=>x.name==='galaxy-discovery-op-db-1'));
 assert.equal(maintenanceCaptureConfiguration(config,footprint).backup.sources.length,footprint.sources.length);
 const context=await maintenanceCaptureContext(config,footprint,{run,resolve:()=>resolveMaintenanceFootprint(config,{run,fs})});assert.equal(context.moduleDatabaseBindings.agentos.stanza,'business');assert.ok(context.clusterDatabases.find(x=>x.stanza==='business').databases.includes('galaxy_agentos'));assert.ok(!JSON.stringify(context).includes('never-export-this'));
 release='0.2.0';await assert.rejects(maintenanceCaptureContext(config,footprint,{run,resolve:()=>resolveMaintenanceFootprint(config,{run,fs})}),{code:'maintenance_current_footprint_changed'});
 const unknown=await resolveMaintenanceFootprint(config,{run,fs:{...fs,readFile:async path=>path.includes('agentos')?'GALAXY_AGENTOS_DATABASE_URL=postgresql://synthetic:never-export-this@127.0.0.1:19999/galaxy_agentos':fs.readFile(path)}});
 assert.equal(unknown.coverage.find(x=>x.id==='agentos').state,'unknown');assert.throws(()=>maintenanceCaptureConfiguration(config,unknown),{code:'maintenance_capture_coverage_incomplete'});
 // This is the actual legacy backup function with the new post-pause hook.
 // Native command effects are doubled; filesystem status and pause ledger are real.
 const directory=await temporary(t);for(const name of ['source','repository','captures','restores','status'])await mkdir(directory+'/'+name,{mode:0o700});await writeFile(directory+'/repository-ref','synthetic-only',{mode:0o600});await writeFile(directory+'/password-ref','synthetic-only',{mode:0o600});
 const pg={id:'business',container:'synthetic-pg',socketPath:'/tmp',administrator:'postgres',database:'galaxy_pilot',composeFile:directory+'/compose.json',dataPath:'/var/lib/postgresql/18/docker',cipherFile:directory+'/cipher',uid:999,gid:999,systemIdentifier:'7654321098765432100',serverCommand:['postgres'],repository:directory+'/repository'};
 const backupConfig={targetHostname:'synthetic-maintenance-fixture',directories:{captures:directory+'/captures',restores:directory+'/restores',status:directory+'/status'},tools:{docker:'synthetic-docker',systemctl:'synthetic-systemctl',restic:'synthetic-restic'},postgres:[pg],backup:{sources:[{id:'source',path:directory+'/source',kind:'tree',optional:false}],writers:[{kind:'systemd',name:'synthetic-writer.service'}],statusGroupId:null,minimumFreeBytes:0,maxCaptureBytes:100000,repositoryFile:directory+'/repository-ref',passwordFile:directory+'/password-ref',resticHost:'synthetic',maxPauseSeconds:30,keycloakRealms:[]}};
 let active=true,transfers=0,hookCalls=0;const changes=[];
 const native=async(command,args)=>{
  if(command==='synthetic-systemctl'){if(args[0]==='show')return result(active?'active':'inactive');changes.push(args[0]);active=args[0]==='start';return result('');}
  if(command==='/usr/bin/du')return result('1\tignored');if(command==='/usr/bin/cp')return result('');
  if(command==='synthetic-docker'&&args.includes('psql'))return result(JSON.stringify({version:180000,dataPath:pg.dataPath,systemIdentifier:pg.systemIdentifier,archiveMode:'on',tablespaces:0}));
  if(command==='synthetic-docker'&&args.includes('--output=json'))return result(JSON.stringify([{backup:[{label:'20261020-031500F',timestamp:{stop:1792456500}}]}]));
  if(command==='synthetic-docker')return result('');if(command==='synthetic-restic'){transfers++;return result('');}throw Error('unexpected synthetic backup command');
 };
 await assert.rejects(createProductBackup(backupConfig,{run:native,captureContext:async()=>{hookCalls++;assert.equal(active,false);throw fail('maintenance_current_footprint_changed');}}),{code:'maintenance_current_footprint_changed'});
 assert.equal(hookCalls,1);assert.deepEqual(changes,['stop','start']);assert.equal(active,true);assert.equal(transfers,0);assert.equal(JSON.parse(await readFile(directory+'/status/create.json','utf8')).outcome,'failed');
});

test('maintenance independent restore journal never replays interrupted effects and opens only after every approved module and condition',linux,async t=>{
 const directory=await temporary(t),journal=new MaintenanceControlJournal({directory:directory+'/control'}),moduleIds=['business','chat'];
 const intent=()=>({kind:'restore-execute',operationId:randomUUID(),operatorId:'synthetic-human',planId:randomUUID(),revision:2,planDigest:'a'.repeat(64),footprintDigest:'b'.repeat(64),pointId:'c'.repeat(64),moduleIds,openingConditions:[...maintenanceOpeningConditions],approvedAt:new Date().toISOString()});
 const effects=[],checks={modules:Object.fromEntries(moduleIds.map(id=>[id,true])),conditions:Object.fromEntries(maintenanceOpeningConditions.map(id=>[id,true]))};let missing=false,complete=true,failOpen=false;
 const adapters={version:'synthetic-fixed-native-v1',moduleIds,openingConditions:[...maintenanceOpeningConditions]};
 for(const stage of ['contain','capture-current-facts','prepare','restore','reconcile','validate','activate','open'])adapters[stage]=async()=>{effects.push(stage);if(stage==='capture-current-facts')return{complete};if(stage==='validate')return missing?{...checks,modules:{business:true,chat:false}}:checks;if(stage==='open'){if(failOpen)throw Error('synthetic lost opening ACK');return{publicActivation:true};}return{accepted:true};};
 const executor=new MaintenanceRestoreExecutor({journal,adapters}),authorize=async()=>({endpoint:'https://galaxy.example.invalid'}),run=x=>executor.execute(x,{point:{},footprint:{digest:x.footprintDigest},authorize});
 const accepted=intent(),done=await run(accepted);assert.equal(done.state,'succeeded');assert.equal(done.publicActivation,true);assert.equal(effects.filter(x=>x==='open').length,1);const once=effects.length;assert.equal((await run(accepted)).state,'succeeded');assert.equal(effects.length,once);
 assert.equal(JSON.parse(await readFile(journal.path(accepted.operationId),'utf8')).approval.planDigest,accepted.planDigest);
 effects.length=0;missing=true;const blocked=await run(intent());assert.equal(blocked.code,'maintenance_required_modules_not_ready');assert.ok(!effects.includes('activate'));assert.ok(!effects.includes('open'));missing=false;
 effects.length=0;complete=false;assert.equal((await run(intent())).code,'maintenance_current_recovery_facts_incomplete');assert.ok(!effects.includes('restore'));complete=true;
 effects.length=0;let checksCount=0;const revoked=intent();assert.equal((await executor.execute(revoked,{point:{},footprint:{digest:revoked.footprintDigest},authorize:async()=>{if(++checksCount===3)throw fail('maintenance_current_authorization_denied');return{endpoint:'https://galaxy.example.invalid'};}})).state,'failed');assert.ok(!effects.includes('restore'));
 effects.length=0;failOpen=true;const ambiguous=intent(),unknown=await run(ambiguous);assert.equal(unknown.state,'unknown');assert.equal(unknown.publicActivation,null);const attempted=effects.length;assert.equal((await run(ambiguous)).state,'unknown');assert.equal(effects.length,attempted);
 const interrupted=intent(),started=await journal.begin(interrupted);started.row.steps.push({id:'restore',state:'running'});await journal.save(started.row);const restarted=new MaintenanceControlJournal({directory:directory+'/control'});assert.equal((await restarted.read(interrupted.operationId)).state,'unknown');assert.equal((await restarted.begin(interrupted)).created,false);
 await assert.rejects(restarted.begin({...interrupted,pointId:'d'.repeat(64)}),{code:'maintenance_operation_conflict'});
});
