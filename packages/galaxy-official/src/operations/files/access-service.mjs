import {randomUUID} from 'node:crypto';
import {transaction} from "../../infrastructure/database.mjs";
import {operationsParse as parse,operationsFail as fail,operationsStamp as stamp,operationsIso as iso} from "../public-content/content-visibility.mjs";
import {operationsFileAccessChangeSchema,operationsFileAccessOperationSchema} from '../../shared/operations-file-access-schema.mjs';
import {OperationsFilesReadModel} from './read-model.mjs';
import {fileProcessingVersion} from './processing.mjs';
import {fileAccessWithin,fileAccessRestorationWithin} from './access-gate.mjs';

const meta=now=>({checkedAt:now,readExpiresAt:now+30,metadataOnly:true});
const receipt=row=>({kind:row.kind,id:row.file_id,action:row.action,revision:row.revision,stopped:row.action==='stop',
 until:row.stopped_until?Math.floor(new Date(row.stopped_until).getTime()/1000):null,operationId:row.operation_id,recordedAt:iso(row.created_at)});

export class OperationsFileAccessService extends OperationsFilesReadModel{
 human(operator){const actor=this.require(operator,true);if(actor.kind!=='business-operator'&&!this.businessAdmin.executorAuthority?.acceptsDuty(actor))fail('operations_permission_denied',403);return actor;}
 async fresh(actor,action,authorize,db=this.db){
  if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  const current=this.human(await authorize({db}));if(current.operatorId!==actor.operatorId||current.endpoint!==this.endpoint)fail('business_admin_denied',403);
  return this.businessAdmin.authorizeAction(current,action,{db});
 }
 async change(operator,kind,id,input,{authorize=null}={}){
  const actor=this.human(operator),x=parse(operationsFileAccessChangeSchema,input);parse(operationsFileAccessOperationSchema,id);this.service(kind,{required:false});
  const permission='files.access.'+(x.action==='stop'?'stop':'restore');await this.fresh(actor,permission,authorize);
  const result=await transaction(this.db,async db=>{
   const current=await this.fresh(actor,permission,authorize,db);await this.principalWithin(db,current);
   if(current.kind==='operations-ai-service')await this.businessAdmin.authorizeOperation(current,'file-access-'+x.action,{id,kind,operationId:x.operationId,command:x},{db});
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912391))',[this.endpoint+':operations:'+x.operationId]);
   const old=(await db.query('SELECT * FROM operations_file_access_events_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,x.operationId])).rows[0];
   if(old){
    if(old.operator_id!==current.operatorId||old.kind!==kind||old.file_id!==id||old.action!==x.action||old.expected_version!==x.expectedVersion
     ||old.expected_revision!==x.expectedRevision||old.reason!==x.reason||(old.stopped_until?Math.floor(new Date(old.stopped_until).getTime()/1000):null)!==(x.until??null))fail('business_admin_operation_conflict');
    await this.fresh(actor,permission,authorize,db);return{...receipt(old),replayed:true};
   }
   if((await db.query('SELECT 1 FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,x.operationId])).rows.length)fail('business_admin_operation_conflict');
   // Share the actual file row lock with both attachment implementations.
   const row=await this.scopedRowWithin(db,kind,id,{write:true}),access=await fileAccessWithin(db,{endpoint:this.endpoint,kind,id,now:this.now()});
   if(fileProcessingVersion(row)!==x.expectedVersion)fail('operations_file_changed');
   if(access.revision!==x.expectedRevision)fail('operations_file_access_changed');
   if(x.action==='stop'){
    if(x.until<=this.now())fail('operations_file_access_until',400);
    if(row.purged_at||row.revoked_at||row.purge_pending||Date.parse(row.expires_at??row.prepare_expires_at)<=this.now()*1000||await this.service(kind,{required:false})?.authorPending(db,row))fail('operations_file_access_unavailable');
    if(access.stopped)fail('operations_file_access_changed');
   }else{
    if(!access.stopped)fail('operations_file_access_changed');
    if(await fileAccessRestorationWithin(db,{kind,row,service:this.service(kind,{required:false}),now:this.now()}))fail('operations_file_access_restore_unavailable');
   }
   const revision=access.revision+1,until=x.action==='stop'?stamp(x.until):null,at=stamp(this.now());
   await this.fresh(actor,permission,authorize,db);
   await db.query(`INSERT INTO operations_file_access_events_v1(id,endpoint,kind,file_id,revision,operation_id,operator_id,action,stopped_until,reason,expected_version,expected_revision,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[randomUUID(),this.endpoint,kind,id,revision,x.operationId,current.operatorId,x.action,until,x.reason,x.expectedVersion,x.expectedRevision,at]);
   await db.query(`INSERT INTO operations_file_access_heads_v1(endpoint,kind,file_id,revision,stopped_until,operation_id,operator_id,reason,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(endpoint,kind,file_id) DO UPDATE SET revision=EXCLUDED.revision,stopped_until=EXCLUDED.stopped_until,
    operation_id=EXCLUDED.operation_id,operator_id=EXCLUDED.operator_id,reason=EXCLUDED.reason,updated_at=EXCLUDED.updated_at`,[this.endpoint,kind,id,revision,until,x.operationId,current.operatorId,x.reason,at]);
   const result={kind,id,action:x.action,revision,stopped:x.action==='stop',until:x.until??null,operationId:x.operationId,recordedAt:at};
   await this.businessAdmin.recordWithin(db,current,'file-access-'+x.action,{operationId:x.operationId,selection:{kind,id,resourceId:id,action:x.action,revision,until:x.until??null},result:{...result,until}});
   await this.fresh(actor,permission,authorize,db);
   if(x.action==='stop'&&x.until<=this.now())fail('operations_file_access_until',400);
   if(x.action==='restore'&&await fileAccessRestorationWithin(db,{kind,row,service:this.service(kind,{required:false}),now:this.now()}))fail('operations_file_access_restore_unavailable');
   return{...result,replayed:false};
  });
  await this.fresh(actor,permission,authorize);return{...result,file:await this.get(actor,kind,id),...meta(this.now())};
 }
 operation(operator,operationId){parse(operationsFileAccessOperationSchema,operationId);return this.run(operator,false,'file-access-read',{id:operationId,view:'operation'},async(db,actor)=>{
  const row=(await db.query('SELECT * FROM operations_file_access_events_v1 WHERE endpoint=$1 AND operation_id=$2 AND operator_id=$3',[this.endpoint,operationId,actor.operatorId])).rows[0];
  return{state:row?'recorded':'not-recorded',operationId,...(row?receipt(row):{}),...meta(this.now())};
 });}
}
