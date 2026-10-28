// Synthetic loopback management/file fixture. No host runtime config is read.
import pg from '../../../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,stat,unlink} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {BusinessAdminService} from '../../../../packages/galaxy-official/src/operations/audit/service.mjs';
import {OperationsPermissionsService} from '../../../../packages/galaxy-official/src/operations/permissions/service.mjs';
import {OperationsFilesService} from '../../../../packages/galaxy-official/src/operations/files/service.mjs';
import {OperationsFileAccessService} from '../../../../packages/galaxy-official/src/operations/files/access-service.mjs';
import {OperationsFileCleanupService} from '../../../../packages/galaxy-official/src/operations/files/cleanup-service.mjs';
import {ForumAttachmentsV1Service} from '../../../../packages/galaxy-official/src/community/forum-attachments-v1.mjs';
import {CommunityForumV1} from '../../../../packages/galaxy-official/src/community/community-forum-v1.mjs';
import {fileProcessingVersion,fileProcessingFacts,fileRetryState} from '../../../../packages/galaxy-official/src/operations/files/processing.mjs';
import {fileCleanupEligibility} from '../../../../packages/galaxy-official/src/operations/files/cleanup-eligibility.mjs';
import {migrate} from '../../../../packages/galaxy-official/src/infrastructure/database.mjs';
const u=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(u.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(u.pathname))throw Error('isolated DB required');
let text='';for await(const c of process.stdin)text+=c;const x=text?JSON.parse(text):{},mode=process.argv[2],now=()=>x.now??2000000000;
if(mode==='oracle'){console.log(JSON.stringify({rows:x.rows.map(row=>({version:fileProcessingVersion(row),facts:fileProcessingFacts(row,now()),retry:fileRetryState(row,now())})),eligibility:(x.eligibility??[]).map(({row,source})=>fileCleanupEligibility(row,source,now()))}));process.exit(0)}
const db=new pg.Pool({connectionString:u.href,max:2}),endpoint='https://permissions.example.invalid',issuer='https://management.example.invalid/realms/management',digest=b=>createHash('sha256').update(b).digest('hex'),ids=Object.fromEntries(['root','writer','empty'].map(s=>[s,digest(issuer+'\0'+s)])),actor={kind:'business-operator',endpoint,operatorId:ids[x.who??'root'],role:(x.who??'root')==='root'?'administrator':'reader'};
const permissions=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:async a=>a.operatorId===ids.root?'administrator':Object.values(ids).includes(a.operatorId)?'reader':null});
const businessAdmin=new BusinessAdminService({db,endpoint,now});businessAdmin.permissions=permissions;businessAdmin.operatorAuthorization=permissions.operatorAuthorization;
let store;if(x.dir){if(!isAbsolute(x.dir))throw Error('absolute isolated store required');const name=key=>join(x.dir,Buffer.from(key).toString('base64url'));store={keyId:'isolated-managed-key',put:async({key,bytes})=>writeFile(name(key),bytes),get:async({key})=>readFile(name(key)),head:async({key})=>{try{const b=await readFile(name(key));return{size:b.length,sha256:digest(b)}}catch(e){if(e.code==='ENOENT')return null;throw e}},erase:async({key})=>{try{await unlink(name(key))}catch(e){if(e.code!=='ENOENT')throw e}return{objectRemoved:true}}};}
const forum=new CommunityForumV1({db,endpoint,now},null),files=new ForumAttachmentsV1Service({forum,store,scanner:{scan:async()=>({state:'clean',checkedAt:now()})}}),opts={businessAdmin,forumAttachments:files,now},reader=new OperationsFilesService(opts),access=new OperationsFileAccessService(opts),cleanup=new OperationsFileCleanupService(opts);
try{
 if(mode==='setup'){
  await migrate(db,{roles:['api','worker']});
  const codes=['files.read','files.scan.retry','files.access.stop','files.access.restore','files.cleanup.plan','files.cleanup.approve'];
  const role=(await permissions.saveRole({...actor,operatorId:ids.root,role:'administrator'},{operationId:randomUUID(),expectedVersion:0,name:'File maintainer',description:'Synthetic file authority',enabled:true,permissions:codes},{authorize:async()=>({...actor,operatorId:ids.root,role:'administrator'})})).role;
  await permissions.saveAssignment({...actor,operatorId:ids.root,role:'administrator'},{operationId:randomUUID(),expectedVersion:0,operatorId:ids.writer,roleId:role.id,enabled:true},{authorize:async()=>({...actor,operatorId:ids.root,role:'administrator'})});
  const account=randomUUID();await db.query("INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1::uuid,$2,$3,$1::text,'external-account',$4,$4)",[account,endpoint,issuer,new Date((now()-10000)*1000)]);
  const rows=[];for(const kind of ['expired','available','scan']){const id=randomUUID(),bytes=Buffer.from('Synthetic managed bytes '+id),key='forum-attachments/'+id;await store.put({key,bytes});const at=new Date(now()*1000),expires=new Date((now()+(kind==='expired'?-1:3600))*1000);await db.query(`INSERT INTO forum_attachments_v1(id,account_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at,uploaded_at,expires_at,scan_attempts,scan_result,last_error) VALUES($1,$2,$3,$4,'text/plain',$5,$3,$6,'isolated-managed-key',$7,$8,$9,$8,$9,$10,$11,$12)`,[id,account,digest(bytes),'原文件 '+kind+' 🚀',bytes.length,key,kind==='scan'?'scan-pending':'available',at,expires,1,kind==='scan'?null:JSON.stringify({state:'clean',checkedAt:now()-1}),kind==='scan'?'attachment_scan_failed':null]);rows.push({id,kind,key,hash:digest(bytes),size:bytes.length})}
  console.log(JSON.stringify({rows,role,codes,account}));
 }else if(mode==='permissions'){
  const current=(await db.query('SELECT version FROM operations_business_roles_v1 WHERE endpoint=$1 AND id=$2',[endpoint,x.roleId])).rows[0];const saved=await permissions.saveRole({...actor,operatorId:ids.root,role:'administrator'},{operationId:randomUUID(),id:x.roleId,expectedVersion:current.version,name:'File maintainer',description:'Synthetic file authority',enabled:true,permissions:x.codes},{authorize:async()=>({...actor,operatorId:ids.root,role:'administrator'})});console.log(JSON.stringify(saved));
 }else{
  let out;if(mode==='get')out=await reader.get(actor,x.kind,x.id);else if(mode==='list')out=await reader.list(actor,x.input??{});else if(mode==='summary')out=await reader.summary(actor,x.input??{});else if(mode==='access-operation')out=await access.operation(actor,x.operationId);else if(mode==='cleanup-plan')out=await cleanup.plan(actor,x.id);else if(mode==='cleanup-operation')out=await cleanup.operation(actor,x.operationId);else if(mode==='cleanup-cancel')out=await cleanup.cancel(actor,x.id,x.input,{authorize:async()=>actor});else throw Error('unknown mode');console.log(JSON.stringify(out));
 }
}finally{await db.end()}
