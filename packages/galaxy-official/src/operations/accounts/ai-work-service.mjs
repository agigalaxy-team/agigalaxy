import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {transaction} from '../../database.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {isOperationsPermission} from '../../operations-permission-catalog.mjs';
import {AiWorkAccountsReadModel,aiWorkAccountView} from './ai-work-read-model.mjs';
import {aiWorkActions,aiWorkCommandSchema,aiWorkAssignmentSchema,aiWorkDomainSchema,aiWorkParse} from './ai-work-schema.mjs';

const fail=(code,status=409)=>{throw new ServiceError(code,status);};
const same=(left,right)=>left?.kind==='business-operator'&&right?.kind==='business-operator'&&left.endpoint===right.endpoint&&left.operatorId===right.operatorId;
const selectionFor=input=>input.kind==='profile-save'?{expectedVersion:input.expectedVersion,name:input.name,description:input.description}:
 input.kind==='state-save'?{expectedVersion:input.expectedVersion,enabled:input.enabled}:{id:input.id??null,expectedVersion:input.expectedVersion,roleId:input.roleId,enabled:input.enabled};

/** Only current humans maintain these five work identities. This service
 * neither initializes their roles nor issues automatic action credentials. */
export class OperationsAiWorkAccountsService extends AiWorkAccountsReadModel{
 async current(operator,action,{db=this.db,authorize}={}){
  if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  const fresh=await authorize();if(!same(operator,fresh))fail('business_admin_denied',403);await this.actor(fresh,{db});return this.actor(fresh,{db,action});
 }
 async existingWithin(db,actor,domain,input,kind){
  const row=(await db.query('SELECT * FROM operations_ai_work_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,input.operationId])).rows[0];
  if(!row)return null;
  if(row.operator_id!==actor.operatorId||row.domain!==domain||row.kind!==kind||!isDeepStrictEqual(row.selection,selectionFor(input))||(row.reason??'')!==(input.reason??''))fail('operations_ai_work_operation_conflict');
  return{...this.receipt(row,true),...this.stamp()};
 }
 async recordWithin(db,actor,domain,input,kind,result){
  const row=(await db.query(`INSERT INTO operations_ai_work_commands_v1(endpoint,operation_id,ai_account_id,domain,operator_id,kind,selection,result,reason,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[this.endpoint,input.operationId,result.account.id,domain,actor.operatorId,kind,JSON.stringify(selectionFor(input)),JSON.stringify(result),input.reason??'',new Date(this.now()*1000)])).rows[0];
  await this.businessAdmin.recordWithin(db,actor,'ai-work-'+kind,{operationId:input.operationId,selection:{id:result.account.id,domain},result:{kind,version:result.account.version,enabled:result.account.enabled,...(result.assignment?{assignmentId:result.assignment.id,assignmentVersion:result.assignment.version,assignmentEnabled:result.assignment.enabled}:{})}});
  return{...this.receipt(row),...this.stamp()};
 }
 async command(operator,domain,body,{authorize}={}){
  aiWorkParse(aiWorkDomainSchema,domain);const input=aiWorkParse(aiWorkCommandSchema,body),action=input.kind==='profile-save'?aiWorkActions.profile:aiWorkActions.state;
  await this.current(operator,action,{authorize});
  return transaction(this.db,async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912410))',[this.endpoint]);
   const actor=await this.current(operator,action,{db,authorize}),old=await this.existingWithin(db,actor,domain,input,input.kind);if(old)return old;
   const row=await this.accountWithin(db,domain,{lock:true});if(row.version!==input.expectedVersion)fail('operations_ai_work_version_changed');
   const next=input.kind==='profile-save'?(await db.query(`UPDATE operations_ai_work_accounts_v1 SET name=$3,description=$4,version=version+1,updated_at=$5 WHERE endpoint=$1 AND id=$2 RETURNING *`,[this.endpoint,row.id,input.name,input.description,new Date(this.now()*1000)])).rows[0]:
    (await db.query(`UPDATE operations_ai_work_accounts_v1 SET enabled=$3,version=version+1,authorization_version=authorization_version+1,updated_at=$4 WHERE endpoint=$1 AND id=$2 RETURNING *`,[this.endpoint,row.id,input.enabled,new Date(this.now()*1000)])).rows[0];
   await this.current(operator,action,{db,authorize});return this.recordWithin(db,actor,domain,input,input.kind,{account:aiWorkAccountView(next)});
  });
 }
 async assignment(operator,domain,body,{authorize}={}){
  aiWorkParse(aiWorkDomainSchema,domain);const input=aiWorkParse(aiWorkAssignmentSchema,body);await this.current(operator,aiWorkActions.roles,{authorize});
  return transaction(this.db,async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912410))',[this.endpoint]);
   const actor=await this.current(operator,aiWorkActions.roles,{db,authorize}),saved=await this.existingWithin(db,actor,domain,input,'assignment-save');if(saved)return saved;
   const account=await this.accountWithin(db,domain,{lock:true}),old=(await db.query('SELECT id,role_id,enabled,version FROM operations_ai_work_assignments_v1 WHERE endpoint=$1 AND ai_account_id=$2 AND role_id=$3',[this.endpoint,account.id,input.roleId])).rows[0];
   if(input.id?old?.id!==input.id||old.version!==input.expectedVersion:old||input.expectedVersion!==0||!input.enabled)fail('operations_ai_work_assignment_changed');
   const role=(await db.query('SELECT id,enabled,permissions FROM operations_business_roles_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,input.roleId])).rows[0];
   if(!role)fail('operations_role_not_found',404);
   if(input.enabled&&(!role.enabled||role.permissions.some(code=>!isOperationsPermission(code)||!actor.businessAuthorization.permissions.includes(code))))fail('operations_ai_work_role_denied',403);
   const at=new Date(this.now()*1000);
   if(old)await db.query('UPDATE operations_ai_work_assignments_v1 SET enabled=$3,version=version+1,updated_at=$4 WHERE endpoint=$1 AND id=$2',[this.endpoint,old.id,input.enabled,at]);
   else await db.query('INSERT INTO operations_ai_work_assignments_v1(id,endpoint,ai_account_id,role_id,enabled,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,1,$6,$6)',[randomUUID(),this.endpoint,account.id,input.roleId,input.enabled,at]);
   const next=(await db.query('UPDATE operations_ai_work_accounts_v1 SET version=version+1,authorization_version=authorization_version+1,updated_at=$3 WHERE endpoint=$1 AND id=$2 RETURNING *',[this.endpoint,account.id,at])).rows[0],assignment=(await this.assignmentsWithin(db,account.id)).find(value=>value.roleId===input.roleId);
   if(!assignment)fail('operations_ai_work_receipt_unavailable',503);
   await this.current(operator,aiWorkActions.roles,{db,authorize});return this.recordWithin(db,actor,domain,input,'assignment-save',{account:aiWorkAccountView(next),assignment});
  });
 }
}
