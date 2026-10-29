import {createHash} from 'node:crypto';
import {readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import {ListObjectsV2Command} from '@aws-sdk/client-s3';
import {recoveryExecutable,recoveryCall} from './go-recovery.mjs';
import {noSymlinkPath,postgresSqlArguments,runCommand} from '../operations-stack/host.mjs';

const fail=code=>Object.assign(Error(code),{code});
const recoveryCallExecutable=async(context,ledger,run)=>recoveryCall(await recoveryExecutable(context),{mode:'ledger-validate',ledger},run);
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const guid=/^GUID[A-Z0-9]{28}$/,digest=/^[a-f0-9]{64}$/;
const maximum=100000,maximumBytes=20*1024*1024;
const hash=value=>createHash('sha256').update(value).digest('hex');
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const tables=['chat_attachments','forum_attachments_v1','outcome_materials_v2','feedback_attachments_v1'];
const keyPattern=/^(?:attachments|outcome-materials|feedback-attachments)\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const columns=table=>'id,storage_key,encryption_key_id,sha256,byte_size,state,purge_pending,'+
 (table==='feedback_attachments_v1'?'NULL::text AS subject_id,NULL::text AS author_id,purged_at':table==='outcome_materials_v2'?'subject_id,author_id,purged_at':'subject_id,NULL::text AS author_id,purged_at')+
 ',lease_id,lease_until';
const identity=row=>row.table+':'+row.id;
const immutable=row=>JSON.stringify([row.table,row.id,row.storageKey,row.keyId,row.sha256,row.byteSize,row.subjectId,row.authorId]);
export const attachmentPointerCaptureSql='BEGIN; LOCK TABLE '+tables.join(',')+' IN SHARE MODE; SELECT json_build_object('+tables.map(table=>quote(table)+",(SELECT coalesce(json_agg(t),'[]'::json) FROM (SELECT "+columns(table)+' FROM '+table+' ORDER BY id LIMIT '+(maximum+1)+')t)').join(',')+'); COMMIT;';
export function objectReceiptArguments(cluster){const args=postgresSqlArguments(cluster,'');args.splice(1,0,'--interactive');args.splice(-2,2,'--quiet','--file','-');return args;}

// Neither purge_pending nor age is authorization. Only an actually executed
// request in the original complete signed/approved ledger supplies the owners.
export async function executedObjectDeletionSubjects(ledger,endpoint,{validate}={}){
 try{if(typeof validate!=='function')throw Error();await validate(ledger);}catch{throw fail('maintenance_object_deletion_ledger_invalid');}
 if(ledger.endpoint!==endpoint)throw fail('maintenance_object_deletion_endpoint_changed');
 return ledger.tables.deletion_requests.filter(x=>x.execution_result).map(row=>({subjectId:row.subject_id,requestId:row.id}));
}
export function attachmentPointersFromRows(input){
 if(!input||Object.keys(input).sort().join(',')!==[...tables].sort().join(','))throw fail('maintenance_object_inventory_invalid');
 const result=[];for(const table of tables){const rows=input[table];if(!Array.isArray(rows)||rows.length>maximum)throw fail('maintenance_object_inventory_limit');
  for(const row of rows){if(!uuid.test(row.id??''))throw fail('maintenance_object_inventory_invalid');
   // A text-only outcome has no S3 object. Its existing SQL/text lifecycle is
   // separate and is not expanded into an inferred object-erasure operation.
   if(row.storage_key===null){if(table!=='outcome_materials_v2')throw fail('maintenance_object_pointer_missing');continue;}
   const item={table,id:row.id,storageKey:row.storage_key,keyId:row.encryption_key_id,sha256:row.sha256,byteSize:Number(row.byte_size),subjectId:row.subject_id??null,authorId:row.author_id??null,
    state:row.state,purgedAt:row.purged_at==null?null:new Date(row.purged_at).toISOString(),leaseId:row.lease_id??null,leaseUntil:row.lease_until==null?null:new Date(row.lease_until).toISOString()};
   if(!keyPattern.test(item.storageKey)||!digest.test(item.sha256??'')||typeof item.keyId!=='string'||!/^[a-zA-Z0-9._-]{1,80}$/.test(item.keyId)||!Number.isSafeInteger(item.byteSize)||item.byteSize<0||item.subjectId!==null&&!guid.test(item.subjectId)&&!/^account:[a-f0-9-]{36}$/.test(item.subjectId)||item.authorId!==null&&!guid.test(item.authorId)&&!/^account:[a-f0-9-]{36}$/.test(item.authorId))throw fail('maintenance_object_inventory_invalid');
   result.push(item);
  }
 }
 if(result.length>maximum||Buffer.byteLength(JSON.stringify(result))>maximumBytes)throw fail('maintenance_object_inventory_limit');return result;
}
export async function attachmentPointersWithin(database){const result={};for(const table of tables)result[table]=(await database.query('SELECT '+columns(table)+' FROM '+table+' ORDER BY id LIMIT '+(maximum+1))).rows;return attachmentPointersFromRows(result);}

export function buildObjectDeletionPlan({current,point,canonical,deletedSubjects,now}){
 if(!Number.isSafeInteger(now)||deletedSubjects.some(x=>!guid.test(x.subjectId??'')||!uuid.test(x.requestId??'')))throw fail('maintenance_object_plan_invalid');
 const owners=new Set(deletedSubjects.map(x=>x.subjectId)),records=new Map(),keys=new Map();
 for(const row of [...current,...point,...canonical]){
  const prior=records.get(identity(row));if(prior&&immutable(prior)!==immutable(row))throw fail('maintenance_object_pointer_conflict');records.set(identity(row),row);
  const sameKey=keys.get(row.storageKey);if(sameKey&&identity(sameKey)!==identity(row))throw fail('maintenance_object_independent_reference_conflict');keys.set(row.storageKey,row);
 }
 const targets=[...records.values()].filter(row=>row.table!=='feedback_attachments_v1'&&(owners.has(row.subjectId)||row.table==='outcome_materials_v2'&&owners.has(row.authorId)));
  if(targets.some(row=>row.leaseId&&(!row.leaseUntil||!Number.isFinite(Date.parse(row.leaseUntil))||Date.parse(row.leaseUntil)>now*1000)))throw fail('maintenance_object_processing_busy');
 return{targets:targets.map(({leaseId:_leaseId,leaseUntil:_leaseUntil,state:_state,purgedAt:_purgedAt,...row})=>row),knownKeys:[...keys.keys()].sort((a,b)=>a<b?-1:a>b?1:0),deletedSubjects};
}

// Complete bounded native inventory is used only to deny an unowned/unknown
// restored key. It NEVER turns that key, an expired row, or a cleanup flag into
// a deletion target. No file body is read.
export async function nativeAttachmentInventory(store){
 let token=null;const seen=new Set(),tokens=new Set();
 for(;;){let page;try{page=await store.request(ListObjectsV2Command,{MaxKeys:1000,...(token?{ContinuationToken:token}:{})});}catch{throw fail('maintenance_object_inventory_unavailable');}
  if(!page||!Array.isArray(page.Contents??[])||typeof page.IsTruncated!=='boolean')throw fail('maintenance_object_inventory_unconfirmed');
  for(const row of page.Contents??[]){if(!keyPattern.test(row.Key??'')||seen.has(row.Key)||seen.size>=maximum)throw fail('maintenance_object_unknown_native_key');seen.add(row.Key);}
  if(!page.IsTruncated)break;const next=page.NextContinuationToken;if(typeof next!=='string'||!next||next.length>8192||tokens.has(next))throw fail('maintenance_object_inventory_unconfirmed');tokens.add(next);token=next;
 }return seen;
}
export async function reconcileExactOwnedObjects({store,plan,authorize=async()=>{}}){
 await authorize();const known=new Set(plan.knownKeys),native=await nativeAttachmentInventory(store);
 if([...native].some(key=>!known.has(key)))throw fail('maintenance_object_native_owner_unknown');
 const receipts=[];
 for(const row of plan.targets){
  await authorize();let before;try{before=await store.head({key:row.storageKey,keyId:row.keyId});}catch{throw fail('maintenance_object_readback_unavailable');}
  if(before&&(before.size!==row.byteSize||before.sha256!==row.sha256))throw fail('maintenance_object_content_changed');
  let acknowledged=false;
  if(before){await authorize();try{const result=await store.erase({key:row.storageKey});acknowledged=result?.objectRemoved===true;}catch{/* Lost ACK: query this exact immutable key, never expand scope. */}}
  await authorize();let after;try{after=await store.head({key:row.storageKey,keyId:row.keyId});}catch{throw fail('maintenance_object_delete_result_unknown');}
  if(after)throw fail('maintenance_object_delete_result_unknown');
  receipts.push({...row,objectAbsent:true,deleteAcknowledged:acknowledged,basis:before?'exact-native-key-absence':'already-absent'});
 }
 const after=await nativeAttachmentInventory(store);if([...after].some(key=>!known.has(key))||plan.targets.some(row=>after.has(row.storageKey)))throw fail('maintenance_object_delete_result_unknown');
 return{nativeOwnedObjectsReconciled:true,inspected:native.size,targets:plan.targets.length,confirmedAbsent:receipts.length,receipts,bodyReturned:false,physicalMediaErasureProven:false,serviceWideDeletionComplete:false};
}

export async function currentAttachmentStore({config={tools:{systemctl:'/usr/bin/systemctl'}},run=runCommand}={}){
 const envFile='/etc/galaxy/pilot/worker.env';await noSymlinkPath(envFile);const e=await lstat(envFile);if(!e.isFile()||e.uid!==0||(e.mode&0o077)||e.size>262144)throw fail('maintenance_attachment_configuration_unknown');
 const lines=(await readFile(envFile,'utf8')).split(/\r?\n/).filter(x=>x.startsWith('GALAXY_ATTACHMENTS_CONFIG_FILE='));
 if(lines.length>1)throw fail('maintenance_attachment_configuration_unknown');let path=lines[0]?.slice('GALAXY_ATTACHMENTS_CONFIG_FILE='.length);
 if(!path){
  // LoadCredential is the current production binding. Read only its source
  // reference; the runtime /run/credentials copy disappears when writers stop.
  const unit=(await run(config.tools.systemctl,['cat','galaxy-worker@pilot.service'],{timeout:10000,maxOutput:262144})).stdout;
  const refs=unit.split(/\r?\n/).map(x=>x.trim()).filter(x=>x.startsWith('LoadCredential=galaxy-attachments.json:'));
  if(refs.length!==1)throw fail('maintenance_attachment_configuration_unknown');path=refs[0].slice('LoadCredential=galaxy-attachments.json:'.length);
 }
 if(!path.startsWith('/etc/galaxy/')&&!path.startsWith('/var/lib/galaxy/config/'))throw fail('maintenance_attachment_configuration_unknown');await noSymlinkPath(path);
 const info=await lstat(path);if(!info.isFile()||info.uid!==0||(info.mode&0o077)||info.size>16384)throw fail('maintenance_attachment_configuration_unknown');
 const raw=await readFile(path,'utf8');let x;try{x=JSON.parse(raw);}catch{throw fail('maintenance_attachment_configuration_unknown');}
 if(!/^http:\/\/127[.]0[.]0[.]1:[0-9]{1,5}$/.test(x.store?.endpoint??''))throw fail('maintenance_attachment_native_binding_required');
 const {loadAttachmentConfiguration}=await import('../support/attachment-configuration.mjs');
 const loaded=await loadAttachmentConfiguration({GALAXY_ATTACHMENTS_CONFIG_FILE:path});if(!loaded?.store)throw fail('maintenance_attachment_configuration_unknown');
 return{store:loaded.store,binding:hash(raw)};
}
async function privateJson(path){await noSymlinkPath(path);const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o077)||info.size>maximumBytes)throw fail('maintenance_private_object_facts_required');return readFile(path,'utf8');}
export class MaintenanceObjectDeletion{
 constructor({config,run=runCommand,controlDirectory,storeFactory=()=>currentAttachmentStore({config,run}),now=()=>Math.floor(Date.now()/1000)}={}){Object.assign(this,{config,run,controlDirectory,storeFactory,now});}
 cluster(){const row=this.config.postgres.find(x=>x.id==='business');if(!row)throw fail('maintenance_business_cluster_unknown');return row;}
 async readLive(){const args=postgresSqlArguments(this.cluster(),attachmentPointerCaptureSql);args.splice(args.length-2,0,'--quiet');let raw;try{raw=JSON.parse((await this.run(this.config.tools.docker,args,{timeout:60000,maxOutput:maximumBytes})).stdout.trim());}catch{throw fail('maintenance_object_inventory_unavailable');}return attachmentPointersFromRows(raw);}
 async save(context,suffix,data){const payload=JSON.stringify(data),directory=this.controlDirectory+'/recovery-facts';if(!uuid.test(context.intent.operationId??'')||Buffer.byteLength(payload)>maximumBytes)throw fail('maintenance_object_plan_invalid');await noSymlinkPath(directory);await mkdir(directory,{recursive:true,mode:0o700});const path=directory+'/'+context.intent.operationId+'-'+suffix+'.json';await writeFile(path,payload,{flag:'wx',mode:0o600});return{operationId:context.intent.operationId,artifactPath:path,sha256:hash(payload)};}
 async read(context,ref,suffix){const path=this.controlDirectory+'/recovery-facts/'+context.intent.operationId+'-'+suffix+'.json';if(ref?.operationId!==context.intent.operationId||ref.artifactPath!==path)throw fail('maintenance_object_plan_invalid');const raw=await privateJson(path);if(hash(raw)!==ref.sha256)throw fail('maintenance_object_plan_changed');return JSON.parse(raw);}
 async inspect(){const {store}=await this.storeFactory();try{return{nativeKeys:(await nativeAttachmentInventory(store)).size,bodyReturned:false};}finally{store.close();}}
 async capture(context){const {store,binding}=await this.storeFactory();try{return await this.save(context,'objects-current',{version:1,binding,rows:await this.readLive()});}finally{store.close();}}
 async ledger(context){const c=context.currentFacts.deletion;const ledger=await this.read(context,c,'deletion');if(c.signatureValidated!==true)throw fail('maintenance_object_deletion_ledger_invalid');return{deletedSubjects:await executedObjectDeletionSubjects(ledger,context.authority.endpoint,{validate:value=>recoveryCallExecutable(context,value,this.run)}),ledgerSha256:c.sha256};}
 async point(database,context){const state=(await database.query('SELECT recovery_id,status FROM recovery_state WHERE singleton=true')).rows[0];if(state?.recovery_id!==context.intent.operationId||state.status!=='quarantined')throw fail('maintenance_exact_quarantine_required');return attachmentPointersWithin(database);}
 async prepare(database,context,point){const current=await this.read(context,context.currentFacts.objects,'objects-current'),{deletedSubjects,ledgerSha256}=await this.ledger(context),canonical=await this.point(database,context);
  const plan=buildObjectDeletionPlan({current:current.rows,point,canonical,deletedSubjects,now:this.now()});return this.save(context,'objects-plan',{version:1,binding:current.binding,ledgerSha256,...plan});}
 async authorize(context,plan){
  if(context.containment?.operationId!==context.intent.operationId||context.containment.publicActivation!==false||context.artifacts.garageSecurity?.currentBucketPermissionsPreserved!==true||context.artifacts.deletion?.quarantined!==true)throw fail('maintenance_object_containment_required');
  const c=this.cluster(),value=(await this.run(this.config.tools.docker,postgresSqlArguments(c,"SELECT recovery_id::text||':'||status FROM recovery_state WHERE singleton=true"),{timeout:15000,maxOutput:1024})).stdout.trim();if(value!==context.intent.operationId+':ready')throw fail('maintenance_exact_quarantine_required');
  const {deletedSubjects,ledgerSha256}=await this.ledger(context);if(ledgerSha256!==plan.ledgerSha256)throw fail('maintenance_object_plan_changed');
  // No resumed API/worker/application writer may race a key or ownership check.
  const allowed=new Set([context.footprint.containers.find(x=>x.id==='objects')?.name,...context.footprint.containers.filter(x=>['analytics-db','analytics-cache','analytics-events','recommendation-db','recommendation-cache'].includes(x.id)).map(x=>x.name)]);
  for(const writer of context.containment.activeWriters??[])if(!allowed.has(writer.name)&&writer.name!=='galaxy-accounts-pilot-keycloak-1'){
   if(!context.containment.stopped.some(x=>x.kind===writer.kind&&x.name===writer.name))throw fail('maintenance_object_writers_not_contained');
   const args=writer.kind==='container'?['inspect','--format','{{.State.Running}}',writer.name]:['is-active',writer.name],tool=writer.kind==='container'?this.config.tools.docker:this.config.tools.systemctl;
   const state=(await this.run(tool,args,{timeout:10000,maxOutput:1024,accepted:[0,3]})).stdout.trim();if(!['false','inactive','failed'].includes(state))throw fail('maintenance_object_writers_not_contained');
  }
  const live=await this.readLive(),rebuilt=buildObjectDeletionPlan({current:[],point:plan.targets,canonical:live,deletedSubjects,now:this.now()});
  if(rebuilt.targets.some(row=>!plan.targets.some(x=>immutable(x)===immutable(row))))throw fail('maintenance_object_plan_changed');
 }
 async reconcile(context){const plan=await this.read(context,context.artifacts.objectDeletionPlan,'objects-plan'),loaded=await this.storeFactory();
  try{if(loaded.binding!==plan.binding)throw fail('maintenance_attachment_configuration_changed');const result=await reconcileExactOwnedObjects({store:loaded.store,plan,authorize:()=>this.authorize(context,plan)});
   // Only positive native absence receipts mark exact existing source rows.
   // Missing rows are not recreated, and no unrelated pending/expired row runs.
   const sql=['BEGIN; LOCK TABLE '+tables.join(',')+' IN SHARE ROW EXCLUSIVE MODE'];
   for(const row of result.receipts){if(row.table==='feedback_attachments_v1')throw fail('maintenance_object_plan_invalid');
    const condition='id='+quote(row.id)+'::uuid AND storage_key='+quote(row.storageKey)+' AND encryption_key_id='+quote(row.keyId)+' AND sha256='+quote(row.sha256)+' AND byte_size='+row.byteSize;
    const fields=row.table==='outcome_materials_v2'?"body_text='',name='',media_type=''":"name='',media_type=''";
    sql.push('UPDATE '+row.table+" SET state='erased',"+fields+",purged_at=COALESCE(purged_at,transaction_timestamp()),purge_pending=false,lease_id=NULL,lease_until=NULL,last_error=NULL WHERE "+condition);
   }sql.push('COMMIT');const args=objectReceiptArguments(this.cluster());
   await this.run(this.config.tools.docker,args,{input:sql.join('; '),timeout:60000,maxOutput:1024});
   const {receipts,...summary}=result;return{...summary,receiptArtifact:await this.save(context,'objects-receipts',{version:1,planSha256:context.artifacts.objectDeletionPlan.sha256,receipts})};
  }finally{loaded.store.close();}
 }
 async verify(context){const plan=await this.read(context,context.artifacts.objectDeletionPlan,'objects-plan'),loaded=await this.storeFactory();try{
  if(loaded.binding!==plan.binding||context.artifacts.objectDeletion?.nativeOwnedObjectsReconciled!==true)throw fail('maintenance_object_delete_result_unknown');
  for(const row of plan.targets)if(await loaded.store.head({key:row.storageKey,keyId:row.keyId}))throw fail('maintenance_object_delete_result_unknown');return{nativeOwnedObjectsReconciled:true,confirmedAbsent:plan.targets.length,physicalMediaErasureProven:false};
 }finally{loaded.store.close();}}
}
