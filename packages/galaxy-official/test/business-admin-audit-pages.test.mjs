import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {businessAuditQuerySchema} from '../src/shared/business-admin-schema.mjs';
import {businessAuditMetadata} from '../src/business-admin-audit-view.mjs';

test('audit result pages freeze visible records, complete safe search, and recheck current PG authority',{timeout:180000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await migrate(db,{roles:['api']});
 const endpoint='https://audit-pages.example.invalid',foreignEndpoint='https://foreign-audit-pages.example.invalid',operatorId='a'.repeat(64),otherId='b'.repeat(64),
  actor={kind:'business-operator',operatorId,role:'administrator',endpoint},otherActor={...actor,operatorId:otherId},account=randomUUID(),otherAccount=randomUUID(),resource=randomUUID(),hiddenResource=randomUUID();
 let clock=Date.parse('2026-10-24T04:00:00Z')/1000,upstreamRole='administrator';const now=()=>clock;
 for(const id of [operatorId,otherId])await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://management.example.invalid',$1,$3,$4,$4)`,[id,endpoint,'合成审计维护者',new Date(clock*1000).toISOString()]);
 const permissions=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:async()=>upstreamRole}),service=new BusinessAdminService({db,endpoint,permissions,now});
 t.after(()=>service.auditPages.close());
 // Leave unused lower sequences so a later-visible insert can demonstrate why
 // a high-water sequence alone is not a stable cross-request snapshot.
 await db.query("SELECT setval(pg_get_serial_sequence('business_admin_audit_v1','sequence'),100)");
 async function append({id=randomUUID(),sequence=null,targetEndpoint=endpoint,action='feedback-update',operator='safe-filler',selection={},result={},at='2026-10-24T01:00:00Z',accountId=account}={}){
  const row=(await db.query(`INSERT INTO business_admin_audit_v1(sequence,id,endpoint,operator_id,operator_role,action,account_id,selection,result,created_at)
   VALUES(COALESCE($1,nextval(pg_get_serial_sequence('business_admin_audit_v1','sequence'))),$2,$3,$4,'administrator',$5,$6,$7,$8,$9) RETURNING id,sequence`,
   [sequence,id,targetEndpoint,operator,action,accountId,JSON.stringify(selection),JSON.stringify(result),at])).rows[0];return {...row,sequence:String(row.sequence)};
 }
 const found=[];
 for(let index=0;index<73;index++)found.push(await append({operator:'SAFE_MATCH_'+index,selection:{resourceId:resource,state:'processing'},result:{feedbackId:resource,revision:index},at:'2026-10-24T00:00:00Z'}));
 const privateTerm='PRIVATE_HIDDEN_AUDIT_TERM';
 await append({selection:{id:resource,resourceId:resource,state:privateTerm,reason:privateTerm,body:privateTerm,query:privateTerm},result:{feedbackId:resource,revision:1,note:privateTerm}});
 await append({action:'audit-read',selection:{id:hiddenResource,body:privateTerm},result:{count:0}});
 await append({targetEndpoint:foreignEndpoint,operator:'FOREIGN_SCOPE_NEEDLE'});await append({accountId:otherAccount,operator:'OTHER_ACCOUNT_NEEDLE'});
 const early=await append({action:'restriction-set',at:'2026-10-23T15:59:59.999Z'}),start=await append({action:'restriction-set',at:'2026-10-23T16:00:00Z'}),end=await append({action:'restriction-set',at:'2026-10-24T15:59:59.999Z'}),late=await append({action:'restriction-set',at:'2026-10-24T16:00:00Z'});
 await db.query(`INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,account_id,selection,result,created_at)
  SELECT x.id,$1,'safe-filler','administrator','feedback-update',$2,'{}','{}','2026-10-24T02:00:00Z'
  FROM jsonb_to_recordset($3::jsonb) AS x(id uuid)`,[endpoint,account,JSON.stringify(Array.from({length:1005},()=>({id:randomUUID()})))]);
 await db.exec('SET ROLE galaxy_api');

 const legacy=await service.audit(actor,{action:'restriction-set',day:'2026-10-24',limit:1});assert.equal(legacy.items[0].id,end.id);
 assert.equal((await service.audit(actor,{action:'restriction-set',day:'2026-10-24',limit:1,after:legacy.nextAfter})).items[0].id,start.id);
 const day=await service.audit(actor,{page:1,pageSize:20,action:'restriction-set',day:'2026-10-24',sort:'oldest'});
 assert.deepEqual(day.items.map(item=>item.id),[start.id,end.id]);assert.equal(day.pagination.total,2);assert(!day.items.some(item=>[early.id,late.id].includes(item.id)));
 assert.equal((await service.audit(actor,{page:1,kind:'reads',action:'restriction-set'})).pagination.total,0);

 const before=Number((await db.query('SELECT count(*) AS total FROM business_admin_audit_v1 WHERE endpoint=$1',[endpoint])).rows[0].total),first=await service.audit(actor,{page:1,pageSize:20});
 assert.equal(first.pagination.total,before);assert.equal(first.items.length,20);assert.equal(first.pagination.totalPages,Math.ceil(before/20));assert.equal(first.search.complete,true);
 assert.equal(first.readExpiresAt-first.checkedAt,30);
 const inserted=await append({sequence:50,operator:'LATE_VISIBLE_LOW_SEQUENCE',at:'2026-10-24T03:00:00Z'}),snapshot=first.pagination.snapshot;
 const all=[];
 for(let page=1;page<=Math.ceil(before/100);page++){
  const current=await service.audit(actor,{page,pageSize:100,snapshot});assert.equal(current.pagination.total,before);assert.equal(current.pagination.snapshot,snapshot);all.push(...current.items.map(item=>item.id));
 }
 assert.equal(all.length,before);assert.equal(new Set(all).size,before);assert(!all.includes(inserted.id));
 const outside=await service.audit(actor,{page:1000000,pageSize:100,snapshot});assert.equal(outside.items.length,0);assert.equal(outside.pagination.total,before);assert.equal(outside.pagination.hasNext,false);
 const fresh=await service.audit(actor,{page:1,pageSize:100});assert(fresh.pagination.total>before);assert(fresh.items.some(item=>item.id===inserted.id));

 const base={page:1,pageSize:20,query:'SAFE_MATCH_',accountId:account};
 let search=await service.audit(actor,base);assert.equal(search.search.state,'scanning');assert.equal(search.items.length,0);assert.equal(search.pagination.total,null);assert.equal(search.pagination.totalPages,null);assert.equal(search.pagination.hasNext,null);
 const searchId=search.pagination.snapshot;search=await service.audit(actor,{...base,snapshot:searchId});assert.equal(search.search.state,'ready');assert.equal(search.pagination.total,73);assert.equal(search.pagination.totalPages,4);assert.equal(search.items.length,20);
 const matches=[];for(let page=1;page<=4;page++)matches.push(...(await service.audit(actor,{...base,snapshot:searchId,page})).items.map(item=>item.id));
 assert.deepEqual(new Set(matches),new Set(found.map(item=>item.id)));assert.equal(matches.length,73);
 await assert.rejects(service.audit(otherActor,{...base,snapshot:searchId}),{code:'audit_snapshot_unavailable',status:404});
 for(const updates of [{query:'different'},{resourceId:resource},{sort:'oldest'},{accountId:otherAccount}])await assert.rejects(service.audit(actor,{...base,snapshot:searchId,...updates}),{code:'audit_snapshot_mismatch',status:409});
 await assert.rejects(service.audit({...actor,endpoint:foreignEndpoint},{page:1,snapshot}),{code:'business_admin_denied'});
 async function complete(query){let result=await service.audit(actor,{page:1,...query});for(let pass=0;result.search.state==='scanning'&&pass<5;pass++)result=await service.audit(actor,{page:1,...query,snapshot:result.pagination.snapshot});assert.equal(result.search.state,'ready');return result;}
 assert.equal((await complete({query:privateTerm,action:'feedback-update'})).pagination.total,0);
 assert.equal((await complete({resourceId:hiddenResource,action:'audit-read'})).pagination.total,0);
 assert.equal((await complete({query:'FOREIGN_SCOPE_NEEDLE'})).pagination.total,0);
 assert.equal((await complete({query:'OTHER_ACCOUNT_NEEDLE',accountId:account})).pagination.total,0);
 const owned=await complete({resourceId:resource,action:'feedback-update'});assert.equal(owned.pagination.total,74);assert(!JSON.stringify(owned).includes(privateTerm));
 const readLog=(await db.query("SELECT selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operator_id=$2 AND action='audit-read'",[endpoint,operatorId])).rows;
 assert(!JSON.stringify(readLog).includes(privateTerm),'raw search input is never copied to audit');
 const projectionSource={id:randomUUID(),sequence:'1',operator_id:operatorId,operator_role:'administrator',actor_kind:'business-operator',created_at:new Date(clock*1000).toISOString(),result:{count:1}};
 const readProjection=businessAuditMetadata({...projectionSource,action:'audit-read',selection:{page:3,kind:'reads',day:'2026-10-24',hasQuery:true,query:privateTerm}});
 assert.deepEqual(readProjection.selection,{page:3,kind:'reads',day:'2026-10-24',hasQuery:true});
 const roleProjection=businessAuditMetadata({...projectionSource,action:'permission-automation-save',selection:{changedFields:['resourceScope']},result:{version:2}});
 assert.deepEqual(roleProjection.selection,{changedFields:['resourceScope']});

 for(const input of [{page:0},{page:1.2},{page:1,pageSize:25},{page:1,limit:30},{page:1,after:'10'},{page:1,sort:'role'},{page:1,snapshot:'bad'},{page:1,unknown:true}])assert.equal(businessAuditQuerySchema.safeParse(input).success,false);
 const oldExpiry=first.pagination.snapshotExpiresAt;clock=oldExpiry+1;await assert.rejects(service.audit(actor,{page:1,snapshot}),{code:'audit_snapshot_expired',status:409});
 const current=await service.audit(actor,{page:1,action:'restriction-set'}),readRows=service.auditPages.rows.bind(service.auditPages);let revoke=true;
 service.auditPages.rows=async(...args)=>{const value=await readRows(...args);if(revoke){revoke=false;upstreamRole='reader';}return value;};
 await assert.rejects(service.audit(actor,{page:1,action:'restriction-set',snapshot:current.pagination.snapshot}),{code:'operations_permission_denied',status:403});
 upstreamRole='administrator';service.auditPages.rows=readRows;await assert.rejects(service.audit(actor,{page:1,action:'restriction-set',snapshot:current.pagination.snapshot}),{code:'audit_snapshot_expired'});

 // Exercise the real bounded SQL capture, not a mocked count or an invented
 // total. The complete eligible range is too large for this process snapshot.
 await db.query(`INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,selection,result,created_at)
  SELECT md5('audit-pages-capacity-'||n)::uuid,$1,'capacity-fixture','administrator','feedback-update','{}','{}','2026-10-24T02:00:00Z'
  FROM generate_series(1,100001) n`,[endpoint]);
 const narrow=await service.audit(actor,{page:1,action:'feedback-update'});assert.equal(narrow.search.state,'narrow-required');assert.equal(narrow.search.reasonCode,'candidate-limit');assert(narrow.search.candidates>100000);assert.equal(narrow.search.complete,false);
 assert.equal(narrow.pagination.total,null);assert.equal(narrow.pagination.totalPages,null);assert.deepEqual(narrow.items,[]);
 assert.equal((await db.query("SELECT has_table_privilege(current_user,'business_admin_audit_v1','DELETE') AS allowed")).rows[0].allowed,false);
 t.diagnostic(JSON.stringify({snapshotTotal:before,searchTotal:73,searchPages:4,capacityCandidates:narrow.search.candidates,metadataOnly:true,actualDatabaseRole:'galaxy_api',nativeDependencies:'none'}));
});
