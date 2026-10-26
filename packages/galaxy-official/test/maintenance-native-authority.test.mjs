import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MaintenanceGarageSecurity} from '../deploy/maintenance-agent/garage-security.mjs';
import {captureGrafanaSecurity,reconcileGrafanaSecurity,grafanaKeyFileAllowed} from '../deploy/maintenance-agent/grafana-security.mjs';
import {MaintenanceEngineSecurity} from '../deploy/maintenance-agent/engine-security.mjs';
import {maintenanceNativeAuthorityGaps,createProductionRestoreAdapters} from '../deploy/maintenance-agent/production-restore.mjs';
import {maintenanceFileTransfers} from '../deploy/maintenance-agent/host-files.mjs';

const image='sha256:'+'a'.repeat(64),bid='b'.repeat(64),extra='c'.repeat(64),keyA='GK'+'a'.repeat(24),keyB='GK'+'b'.repeat(24),keyOld='GK'+'c'.repeat(24);
const no={read:false,write:false,owner:false},yes={read:true,write:true,owner:true},copy=structuredClone;
function garageDouble(){
 const state={keys:new Map(),buckets:new Map(),tokens:[],calls:[]};
 const bucket=id=>state.buckets.get(id),live=()=>[...state.keys.values()].filter(x=>!x.deleted);
 const bucketInfo=id=>{const b=bucket(id);return{id,globalAliases:[...b.globalAliases],websiteAccess:b.websiteAccess,websiteConfig:b.websiteConfig,keys:live().filter(k=>Object.values(b.permissions[k.id]??no).some(Boolean)||(b.localAliases[k.id]?.length??0)>0).map(k=>({accessKeyId:k.id,name:k.name,permissions:copy(b.permissions[k.id]??no),bucketLocalAliases:copy(b.localAliases[k.id]??[])})),corsRules:copy(b.corsRules),lifecycleRules:copy(b.lifecycleRules)};};
 const keyInfo=(id,secrets)=>{const k=state.keys.get(id);if(!k||k.deleted)throw Error('synthetic native no-such-key');return{accessKeyId:id,name:k.name,expiration:k.expiration,permissions:{createBucket:k.createBucket},...(secrets?{secretAccessKey:k.secret}:{}),buckets:[...state.buckets.keys()].filter(b=>Object.values(bucket(b).permissions[id]??no).some(Boolean)||(bucket(b).localAliases[id]?.length??0)>0).map(b=>({id:b,permissions:copy(bucket(b).permissions[id]??no),localAliases:copy(bucket(b).localAliases[id]??[])}))};};
 const run=async(file,args,options={})=>{
  assert.equal(file,'/usr/bin/docker');if(args.at(-1)==='--version')return{stdout:'garage v2.4.1 [features: sqlite]'};
  assert.deepEqual(args.slice(0,4),['exec','-i','galaxy-attachment-storage','/garage']);assert.equal(args.at(-1),'-');const endpoint=args.at(-2),x=JSON.parse(options.input);
  assert(!args.some(a=>a.includes('synthetic-secret')),'secrets only cross native stdin, never argv');state.calls.push(endpoint);
  let result=null;
  if(endpoint==='ListKeys')result=live().map(k=>({id:k.id,name:k.name}));
  else if(endpoint==='GetKeyInfo')result=keyInfo(x.id,x.showSecretKey);
  else if(endpoint==='ListBuckets')result=[...state.buckets.keys()].map(id=>({id}));
  else if(endpoint==='GetBucketInfo')result=bucketInfo(x.id);
  else if(endpoint==='ListAdminTokens')result=copy(state.tokens);
  else if(endpoint==='DeleteAdminToken')state.tokens=state.tokens.filter(t=>t.id!==x.id);
  else if(endpoint==='DenyBucketKey'||endpoint==='AllowBucketKey'){
   const p=bucket(x.bucketId).permissions[x.accessKeyId]??=copy(no);for(const flag of Object.keys(no))if(x.permissions[flag])p[flag]=endpoint==='AllowBucketKey';
  }else if(endpoint==='RemoveBucketAlias'||endpoint==='AddBucketAlias'){
   const b=bucket(x.bucketId),adding=endpoint==='AddBucketAlias';if(x.globalAlias)b.globalAliases=adding?[...b.globalAliases,x.globalAlias]:b.globalAliases.filter(a=>a!==x.globalAlias);
   else{const old=b.localAliases[x.accessKeyId]??[];b.localAliases[x.accessKeyId]=adding?[...old,x.localAlias]:old.filter(a=>a!==x.localAlias);}
  }else if(endpoint==='DeleteKey'){
   state.keys.get(x.id).deleted=true;for(const b of state.buckets.values()){delete b.permissions[x.id];delete b.localAliases[x.id];}
  }else if(endpoint==='ImportKey'){
   if(state.keys.has(x.accessKeyId))throw Error('synthetic native tombstone already exists');state.keys.set(x.accessKeyId,{id:x.accessKeyId,name:x.name,secret:x.secretAccessKey,expiration:null,createBucket:false});
  }else if(endpoint==='UpdateKey'){
   const k=state.keys.get(x.id);if(x.body.name!==undefined)k.name=x.body.name;if(x.body.expiration)k.expiration=x.body.expiration;if(x.body.neverExpires)k.expiration=null;if(x.body.deny?.createBucket)k.createBucket=false;if(x.body.allow?.createBucket)k.createBucket=true;
  }else if(endpoint==='UpdateBucket'){
   const b=bucket(x.id);b.websiteAccess=x.body.websiteAccess.enabled;b.websiteConfig=b.websiteAccess?{indexDocument:x.body.websiteAccess.indexDocument,errorDocument:x.body.websiteAccess.errorDocument??null}:undefined;b.corsRules=x.body.corsRules;b.lifecycleRules=x.body.lifecycleRules;
  }else throw Error('unexpected synthetic endpoint');
  return{stdout:JSON.stringify(result)};
 };
 return{state,run};
}

test('maintenance Garage uses native stdin RPC to retain current keys expiry and exact ACL while revoking point-only authorization and rejecting unexportable identities',async()=>{
 const f=garageDouble(),ctx={intent:{operationId:randomUUID(),moduleIds:['objects']},footprint:{containers:[{id:'objects',name:'galaxy-attachment-storage',state:'available',image}]}};ctx.containment={operationId:ctx.intent.operationId,publicActivation:false};
 const adapter=new MaintenanceGarageSecurity({config:{tools:{docker:'/usr/bin/docker'}},run:f.run});
 f.state.keys.set(keyA,{id:keyA,name:'current',secret:'synthetic-secret-current-a',expiration:'2025-01-01T00:00:00Z',createBucket:false});f.state.keys.set(keyB,{id:keyB,name:'new',secret:'synthetic-secret-current-b',expiration:null,createBucket:true});
 f.state.buckets.set(bid,{globalAliases:['current-bucket'],localAliases:{[keyA]:['current-alias']},permissions:{[keyA]:{...no,read:true},[keyB]:{...no,write:true}},websiteAccess:false,corsRules:[{allowedOrigins:['https://point.example.invalid']}],lifecycleRules:[{id:'point-rule',enabled:true}]});
 const facts=await adapter.capture(ctx);assert.equal(facts.keys.length,2);assert(!f.state.calls.some(x=>x==='ImportKey'));
 f.state.keys.delete(keyB);Object.assign(f.state.keys.get(keyA),{name:'older',expiration:null,createBucket:true});f.state.keys.set(keyOld,{id:keyOld,name:'revoked',secret:'synthetic-secret-old',expiration:null,createBucket:true});
 f.state.buckets.get(bid).permissions={[keyA]:copy(yes),[keyOld]:copy(yes)};f.state.buckets.get(bid).globalAliases=['old-bucket'];
 f.state.buckets.set(extra,{globalAliases:['old-public'],localAliases:{},permissions:{[keyOld]:copy(yes)},websiteAccess:true,websiteConfig:{indexDocument:'index.html'},corsRules:[],lifecycleRules:[{id:'preserve-point-expiration',enabled:true}]});f.state.tokens=[{id:'old-admin-token'}];
 const result=await adapter.restore(ctx,facts);assert.equal(result.currentBucketPermissionsPreserved,true);assert.deepEqual(f.state.buckets.get(bid).permissions[keyA],{...no,read:true});assert.equal(f.state.keys.get(keyA).expiration,'2025-01-01T00:00:00Z');assert.equal(f.state.keys.get(keyA).createBucket,false);assert.equal(f.state.keys.get(keyB).secret,'synthetic-secret-current-b');assert.equal(f.state.keys.get(keyOld).deleted,true);assert.equal(f.state.tokens.length,0);assert.equal(f.state.buckets.get(extra).websiteAccess,false);assert.deepEqual(f.state.buckets.get(extra).lifecycleRules,[{id:'preserve-point-expiration',enabled:true}]);
 f.state.buckets.get(bid).permissions[keyA].owner=true;await assert.rejects(adapter.verify(ctx,facts),{code:'maintenance_garage_current_authority_unconfirmed'});f.state.buckets.get(bid).permissions[keyA].owner=false;
 f.state.tokens=[{id:'current-non-exportable'}];await assert.rejects(adapter.capture(ctx),{code:'maintenance_garage_current_admin_token_not_exportable'});f.state.tokens=[];
 const calls=f.state.calls.length;f.state.keys.get(keyA).secret='synthetic-secret-conflicting';await assert.rejects(adapter.restore(ctx,facts),{code:'maintenance_garage_existing_secret_conflict'});assert(!f.state.calls.slice(calls).some(x=>['DenyBucketKey','DeleteKey','ImportKey','UpdateKey'].includes(x)));
 f.state.keys.get(keyA).secret='synthetic-secret-current-a';const conflict=copy(facts);conflict.buckets[0].id='d'.repeat(64);await assert.rejects(adapter.restore(ctx,conflict),{code:'maintenance_garage_current_bucket_missing_from_point'});
});

const quote=x=>'"'+x.replaceAll('"','""')+'"';
async function grafanaDatabase(){
 const metadata=JSON.parse(await readFile(new URL('./fixtures/maintenance-grafana-13.2.4.json',import.meta.url),'utf8')),db=new DatabaseSync(':memory:');
 for(const [table,layout]of Object.entries(metadata.tables)){
  const primary=layout.columns.filter(x=>x.pk).sort((a,b)=>a.pk-b.pk).map(x=>x.name),integer=primary.length===1&&layout.columns.find(x=>x.name===primary[0]).type.toUpperCase()==='INTEGER';
  const columns=layout.columns.map(x=>quote(x.name)+' '+x.type+(integer&&x.name===primary[0]?' PRIMARY KEY AUTOINCREMENT':''));if(primary.length&&!integer)columns.push('PRIMARY KEY('+primary.map(quote).join(',')+')');
  db.exec('CREATE TABLE '+quote(table)+'('+columns.join(',')+')');for(const [i,index]of layout.unique.entries())db.exec('CREATE UNIQUE INDEX '+quote(table+'_fixture_unique_'+i)+' ON '+quote(table)+'('+index.map(quote).join(',')+')');
 }
 const put=(table,row)=>{const names=Object.keys(row);db.prepare('INSERT INTO '+quote(table)+'('+names.map(quote).join(',')+') VALUES('+names.map(()=>'?').join(',')+')').run(...Object.values(row));};
 put('migration_log',{id:1,migration_id:'native-13.2.4-representative',success:1});
 return{db,put};
}
test('maintenance Grafana merges actual native SQLite identity credentials roles and UID-bound ACL without restoring old sessions or changing point dashboards',async t=>{
 const current=await grafanaDatabase(),point=await grafanaDatabase();t.after(()=>{current.db.close();point.db.close();});
 for(const f of[current,point]){f.put('org',{id:1,name:'organization'});f.put('user',{id:1,uid:'user-one',login:'one',email:'one@example.invalid',password:f===current?'current-password-hash':'old-password-hash',is_admin:f===current?0:1,is_disabled:f===current?1:0,is_service_account:0});}
 current.put('user',{id:3,uid:'service-account',login:'service',email:'service@example.invalid',is_admin:0,is_disabled:0,is_service_account:1});point.put('user',{id:2,uid:'removed-user',login:'removed',email:'removed@example.invalid',password:'revoked-hash',is_admin:1,is_disabled:0,is_service_account:0});
 current.put('org_user',{id:1,org_id:1,user_id:1,role:'Viewer'});point.put('org_user',{id:2,org_id:1,user_id:2,role:'Admin'});
 current.put('role',{id:1,uid:'role-current',name:'current-reader',org_id:1});current.put('permission',{id:1,role_id:1,action:'dashboards:read',scope:'dashboards:uid:dashboard-one'});current.put('user_role',{id:1,org_id:1,user_id:1,role_id:1});
 point.put('role',{id:1,uid:'role-old',name:'old-admin',org_id:1});point.put('permission',{id:1,role_id:1,action:'*',scope:'*'});
 current.put('api_key',{id:3,org_id:1,name:'current-revoked',key:'current-hash',role:'Viewer',is_revoked:1,service_account_id:3});point.put('api_key',{id:2,org_id:1,name:'old-live',key:'old-hash',role:'Admin',is_revoked:0});
 current.put('user_auth',{id:1,user_id:1,user_uid:'user-one',auth_module:'oauth_generic_oauth',auth_id:'current-external',o_auth_access_token:'synthetic-current-oauth'});point.put('user_auth',{id:2,user_id:2,user_uid:'removed-user',auth_module:'oauth_generic_oauth',auth_id:'old-external',o_auth_access_token:'synthetic-old-oauth'});
 current.put('data_keys',{name:'current-encryption-key',encrypted_data:Buffer.from([1,2,3]),active:1,provider:'secretKey.v1'});point.put('data_keys',{name:'old-encryption-key',encrypted_data:Buffer.from([9,9]),active:1,provider:'secretKey.v1'});
 current.put('signing_key',{id:1,key_id:'current-signing',private_key:'synthetic-current-private'});point.put('signing_key',{id:1,key_id:'old-signing',private_key:'synthetic-old-private'});
 current.put('data_source',{id:1,uid:'datasource-one',org_id:1,url:'https://current-target.example.invalid',password:'synthetic-current-connection'});point.put('data_source',{id:1,uid:'datasource-one',org_id:1,url:'https://old-target.example.invalid',password:'synthetic-old-connection'});
 current.put('dashboard',{id:10,uid:'dashboard-one',org_id:1,data:'current-business'});point.put('dashboard',{id:50,uid:'dashboard-one',org_id:1,data:'selected-point-business'});
 current.put('dashboard_acl',{id:1,org_id:1,dashboard_id:10,user_id:1,permission:1});point.put('dashboard_acl',{id:2,org_id:1,dashboard_id:50,user_id:2,permission:4});
 current.put('dashboard_public',{uid:'share-one',dashboard_uid:'dashboard-one',org_id:1,access_token:'synthetic-current-share',is_enabled:0});point.put('dashboard_public',{uid:'share-old',dashboard_uid:'dashboard-one',org_id:1,access_token:'synthetic-old-share',is_enabled:1});
 current.put('kv_store',{id:1,namespace:'alertmanager',key:'current',value:'synthetic-current-binding'});point.put('kv_store',{id:1,namespace:'alertmanager',key:'old',value:'synthetic-old-binding'});point.put('kv_store',{id:2,namespace:'infra.usagestats',key:'business-state',value:'point-state'});
 point.put('session',{key:'old-session',data:'old-cookie'});point.put('user_auth_token',{id:1,user_id:2,auth_token:'old-native-token'});point.put('resource',{guid:'point-dashboard',group:'dashboard.grafana.app',resource:'dashboards',namespace:'default',name:'dashboard-one',value:'selected-point-payload'});
 const facts=captureGrafanaSecurity(current.db),id=randomUUID();assert.throws(()=>reconcileGrafanaSecurity(point.db,facts,{operationId:id}),{code:'maintenance_grafana_private_candidate_required'});
 point.db.exec('CREATE TEMP TABLE galaxy_maintenance_recovery_guard(operation_id TEXT,private_candidate INTEGER)');point.db.prepare('INSERT INTO galaxy_maintenance_recovery_guard VALUES(?,1)').run(id);
 const result=reconcileGrafanaSecurity(point.db,facts,{operationId:id});assert.equal(result.currentPermissionsPreserved,true);assert.deepEqual({...point.db.prepare('SELECT id,password,is_admin,is_disabled FROM user WHERE id=1').get()},{id:1,password:'current-password-hash',is_admin:0,is_disabled:1});assert.equal(point.db.prepare('SELECT count(*) AS n FROM user WHERE id=2').get().n,0);
 assert.equal(point.db.prepare('SELECT count(*) AS n FROM session').get().n,0);assert.equal(point.db.prepare('SELECT count(*) AS n FROM user_auth_token').get().n,0);assert.equal(point.db.prepare('SELECT o_auth_access_token FROM user_auth').get().o_auth_access_token,'synthetic-current-oauth');
 assert.deepEqual({...point.db.prepare('SELECT key,is_revoked FROM api_key').get()},{key:'current-hash',is_revoked:1});assert.deepEqual({...point.db.prepare('SELECT action,scope FROM permission').get()},{action:'dashboards:read',scope:'dashboards:uid:dashboard-one'});assert.equal(point.db.prepare('SELECT dashboard_id FROM dashboard_acl').get().dashboard_id,50);
 assert.equal(point.db.prepare('SELECT data FROM dashboard').get().data,'selected-point-business');assert.equal(point.db.prepare('SELECT value FROM resource').get().value,'selected-point-payload');assert.equal(point.db.prepare('SELECT access_token FROM dashboard_public').get().access_token,'synthetic-current-share');
 assert.deepEqual(Buffer.from(point.db.prepare('SELECT encrypted_data FROM data_keys').get().encrypted_data),Buffer.from([1,2,3]));assert.equal(point.db.prepare('SELECT url FROM data_source').get().url,'https://current-target.example.invalid');assert.equal(point.db.prepare("SELECT value FROM kv_store WHERE namespace='infra.usagestats'").get().value,'point-state');
 const unknown=copy(facts);unknown.tables.dashboard_acl[0].dashboard_id={$integer:'999999'};assert.throws(()=>reconcileGrafanaSecurity(point.db,unknown,{operationId:id}),{code:'maintenance_grafana_current_acl_target_unknown'});
 point.put('resource',{guid:'unsupported-iam',group:'iam.grafana.app',resource:'roles',namespace:'default',name:'unhandled',value:'not-processed'});assert.throws(()=>reconcileGrafanaSecurity(point.db,facts,{operationId:id}),{code:'maintenance_grafana_unified_authority_not_supported'});assert.equal(point.db.prepare('SELECT password FROM user WHERE id=1').get().password,'current-password-hash');
});

test('maintenance native authority contributions are private and wired through capture merge and final qualification while chat gaps stay blocked',{skip:process.platform!=='linux'?'Private recovery artifacts require Linux owner/mode enforcement.':false},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-native-authority-'));t.after(()=>rm(directory,{recursive:true,force:true}));const calls=[],intent={operationId:randomUUID(),moduleIds:['objects','configuration']},context={intent,footprint:{},currentFacts:{}};
 const garage={read:async()=>{calls.push('garage-inspect');},capture:async()=>({secret:'synthetic-private-garage-secret'}),restore:async(_c,f)=>{assert.equal(f.secret,'synthetic-private-garage-secret');calls.push('garage-merge');return{currentBucketPermissionsPreserved:true};},verify:async()=>{calls.push('garage-final');}};
 const grafana={capture:async()=>({secret:'synthetic-private-grafana-oauth'}),prepare:async(_c,f)=>{assert.equal(f.secret,'synthetic-private-grafana-oauth');calls.push('grafana-merge');return{currentPermissionsPreserved:true};},verify:async()=>{calls.push('grafana-final');}};
 const engines=new MaintenanceEngineSecurity({config:{},run:async()=>{throw Error('unexpected native effect');},controlDirectory:directory,garage,grafana});
 await engines.inspect(context);const receipt=await engines.capture(context);context.currentFacts.engines=receipt;
 assert(!JSON.stringify(receipt).includes('synthetic-private'));assert.equal((await lstat(receipt.artifactPath)).mode&0o777,0o600);assert((await readFile(receipt.artifactPath,'utf8')).includes('synthetic-private-grafana-oauth'));
 await engines.prepareGrafana(context);await engines.restoreGarage(context);await engines.verifyNativeAuthority(context);assert.deepEqual(calls,['garage-inspect','grafana-merge','garage-merge','garage-final','grafana-final']);
 assert.deepEqual(maintenanceNativeAuthorityGaps(['objects','configuration']),[]);assert.deepEqual(maintenanceNativeAuthorityGaps(['chat']),['maintenance_current_chat_native_readiness_not_proven']);
 let contained=false;const adapter=createProductionRestoreAdapters({config:{},controlDirectory:directory,run:async()=>{throw Error('unexpected command');},engines:{inspect:async()=>{throw Object.assign(Error('closed'),{code:'maintenance_grafana_namespace_not_supported'});}},gate:{contain:async()=>{contained=true;}}});
 await assert.rejects(adapter.contain({intent:{moduleIds:['configuration']}}),{code:'maintenance_grafana_namespace_not_supported'});assert.equal(contained,false);
 const secret='/var/lib/galaxy/operations/secrets/current-key',file={id:'secret',path:secret,kind:'file'},base={intent,point:{manifest:{files:[file],maintenance:{sourceBindings:[{...file,modules:['configuration']}],coverage:[]}}},footprint:{containers:[{mounts:[{target:'/run/secrets/current',path:secret,writable:false}]}],sources:[]},artifacts:{files:'/synthetic-private-point'}};
 assert.deepEqual(maintenanceFileTransfers(base),[]);const parent=copy(base);parent.point.manifest.files[0].path='/var/lib/galaxy/operations';parent.point.manifest.maintenance.sourceBindings[0].path='/var/lib/galaxy/operations';assert.throws(()=>maintenanceFileTransfers(parent),{code:'maintenance_protected_native_configuration_in_point_transfer'});
 const metadata={isFile:()=>true,isSymbolicLink:()=>false,size:87,uid:472,gid:472,mode:0o400};assert.equal(grafanaKeyFileAllowed(metadata,{writable:false}),true);assert.equal(grafanaKeyFileAllowed(metadata,{writable:true}),false);assert.equal(grafanaKeyFileAllowed({...metadata,mode:0o444},{writable:false}),false);assert.equal(grafanaKeyFileAllowed({...metadata,uid:1001},{writable:false}),false);assert.equal(grafanaKeyFileAllowed({...metadata,uid:0,gid:0,mode:0o600},{writable:false}),true);
});
