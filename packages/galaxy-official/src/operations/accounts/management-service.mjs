import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {transaction} from '../../database.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {ManagementAccountsReadModel} from './management-read-model.mjs';
import {managementParse as parse,managementCreateSchema,managementCommandSchema,managementAssignmentSchema,managementCommandActions,
 managementId,managementDisplay,managementStamp,managementTargetVersion,managementIntent,managementSafeCode} from './management-schema.mjs';

const fail=(code,status=403)=>{throw new ServiceError(code,status);};
const phase=(kind,state,code=null,extra={})=>({kind,state,code,...extra});
const uuid=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const sameNative=(a,b)=>isDeepStrictEqual(a,b);
const childId=(id,role)=>{const bytes=createHash('sha256').update(id+'\0'+role).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
 const h=bytes.toString('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);};
const stateOf=phases=>phases.some(x=>x.state==='unknown')?'unknown':phases.some(x=>x.state==='accepted')?'accepted':phases.every(x=>['confirmed','submitted'].includes(x.state))?'completed':
 phases.some(x=>['confirmed','submitted'].includes(x.state))?'partial':'failed';

// A committed reservation precedes native I/O. Replaying an original ID returns
// that reservation/result, never another temporary-password or email request.
export class OperationsManagementAccountsService extends ManagementAccountsReadModel{
 async current(original,action,authorize,db=this.db){
  if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  const fresh=await authorize();if(fresh?.kind!=='business-operator'||fresh.operatorId!==original.operatorId||fresh.endpoint!==this.endpoint)fail('business_admin_denied');
  await this.actor(fresh,{db});return this.actor(fresh,{db,action});
 }
 guard(actor,user,kind){
  if(!this.rootPrincipal)fail('operations_authorization_unavailable',503);
  const root=this.rootTarget(user),self=actor.operatorId===managementId(user.issuer,user.externalSubject);
  if(root&&(!self||!this.rootActor(actor)||['login-disable','login-restore','delete','admission-change','assignment'].includes(kind)))fail('management_root_protected');
  if(kind==='admission-change'&&!this.rootActor(actor))fail('management_root_only');
  if(self&&['login-disable','delete'].includes(kind))fail('management_self_protected');
 }
 async principalWithin(db,user,actor,{note=''}={}){
  const id=managementId(user.issuer,user.externalSubject),at=managementStamp(this.now()*1000);
  const old=(await db.query('SELECT endpoint,issuer,external_subject FROM operations_operator_principals_v1 WHERE operator_id=$1',[id])).rows[0];
  if(old&&(old.endpoint!==this.endpoint||old.issuer!==user.issuer||old.external_subject!==user.externalSubject))fail('management_identity_target_changed',409);
  await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(operator_id) DO UPDATE SET display_name=EXCLUDED.display_name,updated_at=EXCLUDED.updated_at`,[id,this.endpoint,user.issuer,user.externalSubject,managementDisplay(user),at]);
  await db.query(`INSERT INTO operations_management_accounts_v1(operator_id,endpoint,issuer,external_subject,version,note,created_by,created_at,updated_at)
   VALUES($1,$2,$3,$4,1,$5,$6,$7,$7) ON CONFLICT(operator_id) DO NOTHING`,[id,this.endpoint,user.issuer,user.externalSubject,note,actor.operatorId,at]);
  return (await db.query('SELECT * FROM operations_management_accounts_v1 WHERE endpoint=$1 AND operator_id=$2',[this.endpoint,id])).rows[0];
 }
 async auditWithin(db,actor,row){
  await this.businessAdmin.recordWithin(db,actor,'management-account-'+row.kind,{operationId:row.operation_id,
   selection:{targetOperatorId:row.target_operator_id,kind:row.kind},result:{kind:row.kind,state:row.state,revision:row.result?.revision??null,
    phases:this.safeResult(row.result).phases.map(({kind,state})=>({kind,state}))}});
 }
 async reserve(original,kind,input,{targetId=null,user=null,action,authorize}={}){
  return transaction(this.db,async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912462))',[JSON.stringify([this.endpoint,input.operationId])]);
   const actor=await this.current(original,action,authorize,db),intent=managementIntent(input),old=(await db.query('SELECT * FROM operations_management_commands_v1 WHERE operation_id=$1',[input.operationId])).rows[0];
   if(old){if(old.endpoint!==this.endpoint||old.operator_id!==actor.operatorId||old.target_operator_id!==targetId&&kind!=='create'||old.kind!==kind||!isDeepStrictEqual(old.input,intent))fail('management_operation_conflict',409);return {old};}
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912463))',[JSON.stringify([this.endpoint,targetId??input.username.toLowerCase()])]);
   const pending=(await db.query(`SELECT 1 FROM operations_management_commands_v1 WHERE endpoint=$1 AND state IN ('accepted','unknown')
    AND ${targetId?'target_operator_id=$2':"kind='create' AND lower(input->>'username')=$2"} LIMIT 1`,[this.endpoint,targetId??input.username.toLowerCase()])).rows[0];
   if(pending)fail('management_operation_pending',409);
   let meta=null;
   if(kind==='create'){
    if(!this.rootPrincipal||!this.directory?.managementConfigured)fail('management_writer_not_configured',503);
    for(const roleId of input.roleIds){const role=(await db.query('SELECT enabled,permissions FROM operations_business_roles_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,roleId])).rows[0];
     if(!role?.enabled)fail('operations_permissions_target_changed',409);if(!this.has(actor,'permissions.assignments.write')||role.permissions.some(code=>!this.has(actor,code)))fail('operations_permission_denied');}
   }else{
    const row=await this.targetWithin(db,targetId);if(row.deleted_at||!user)fail('management_identity_not_found',404);
    this.guard(actor,user,kind);if(managementTargetVersion(user,row)!==input.expectedVersion)fail('management_identity_target_changed',409);
    if(!this.directory?.managementConfigured)fail('management_writer_not_configured',503);
    if(kind==='email-change'&&!this.directory?.emailChangeConfigured)fail('management_email_verification_not_configured',503);
    if(kind==='login-disable'&&(!user.enabled||row.login_blocked)||kind==='login-restore'&&user.enabled&&!row.login_blocked)fail('management_identity_target_changed',409);
    if(kind==='admission-change'&&(input.action==='promote'?user.admission==='administrator':user.admission!=='administrator'))fail('management_identity_target_changed',409);
    meta=await this.principalWithin(db,user,actor);
   }
   const at=managementStamp(this.now()*1000),row=(await db.query(`INSERT INTO operations_management_commands_v1(operation_id,endpoint,operator_id,target_operator_id,kind,state,input,result,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'accepted',$6,$7,$8,$8) RETURNING *`,[input.operationId,this.endpoint,actor.operatorId,targetId,kind,JSON.stringify(intent),JSON.stringify({phases:[],revision:meta?.version??null}),at])).rows[0];
   // The command row is the durable acceptance record. The append-only common
   // audit permits one row per original operation and is written with finish.
   return {row,actor,meta};
  });
 }
 async update(row,phases,{targetId=row.target_operator_id,revision=row.result?.revision??null,binding=null,finish=false}={}){
  const result={phases,revision,...(binding?{binding}:row.result?.binding?{binding:row.result.binding}:{})};
  return (await this.db.query(`UPDATE operations_management_commands_v1 SET target_operator_id=$3,state=$4,result=$5,updated_at=$6 WHERE endpoint=$1 AND operation_id=$2 RETURNING *`,
   [this.endpoint,row.operation_id,targetId,finish?stateOf(phases):'accepted',JSON.stringify(result),managementStamp(this.now()*1000)])).rows[0];
 }
 async invoke(row,phases,kind,run){
  phases.push(phase(kind,'accepted'));row=await this.update(row,phases);
  let result;try{result=await run();if(!['confirmed','submitted','failed','unknown'].includes(result?.state))result=phase(kind,'unknown','management_identity_response_invalid');}
  catch(error){result=phase(kind,'failed',managementSafeCode(error));}
  phases[phases.length-1]=phase(kind,result.state,result.code??null,{...(Number.isSafeInteger(result.revokedSessions)&&result.revokedSessions>=0?{revokedSessions:result.revokedSessions}:{}),...(result.inflightBlocked===true?{inflightBlocked:true}:{})});
  row=await this.update(row,phases,{revision:result.revision??row.result?.revision??null});return {row,result};
 }
 async local(row,user,actor,{note,loginBlocked,deleted=false}={},validate=null){
  return transaction(this.db,async db=>{if(validate)actor=await validate(db);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912463))',[JSON.stringify([this.endpoint,managementId(user.issuer,user.externalSubject)])]);
   await this.principalWithin(db,user,actor);return (await db.query(`UPDATE operations_management_accounts_v1 SET version=version+1,note=COALESCE($3,note),login_blocked=COALESCE($4,login_blocked),
    deleted_at=CASE WHEN $5 THEN $6::timestamptz ELSE deleted_at END,updated_at=$6 WHERE endpoint=$1 AND operator_id=$2 RETURNING *`,
   [this.endpoint,managementId(user.issuer,user.externalSubject),note??null,loginBlocked??null,deleted,managementStamp(this.now()*1000)])).rows[0];});
 }
 async invalidate(principal){if(typeof this.managementSessions?.invalidate==='function')await this.managementSessions.invalidate(principal);}
 async finish(row,phases,actor){return transaction(this.db,async db=>{
  const saved=(await db.query('UPDATE operations_management_commands_v1 SET state=$3,result=$4,updated_at=$5 WHERE endpoint=$1 AND operation_id=$2 RETURNING *',
   [this.endpoint,row.operation_id,stateOf(phases),JSON.stringify({...row.result,phases}),managementStamp(this.now()*1000)])).rows[0];
  await this.auditWithin(db,actor,saved);return saved;
 });}
 async portal(principal){
  if(typeof this.managementSessions?.revoke!=='function')fail('management_sessions_unavailable',503);
  const result=await this.managementSessions.revoke(principal);
  if(!Number.isSafeInteger(result?.revokedSessions)||result.revokedSessions<0||result.inflightBlocked!==true)return {state:'unknown',code:'management_sessions_unavailable'};
  return {state:'confirmed',code:null,revokedSessions:result.revokedSessions,inflightBlocked:true};
 }
 async create(operator,input,{authorize}={}){
  const x=parse(managementCreateSchema,input),original=await this.actor(operator),claim=await this.reserve(original,'create',x,{action:'management.accounts.create',authorize});
  if(claim.old)return {...this.receipt(claim.old,true),...this.stamp()};
  let row=claim.row;const phases=[],gate=()=>this.current(original,'management.accounts.create',authorize);
  let found=await this.invoke(row,phases,'native-account',()=>this.directory.create(x,{authorize:gate}));row=found.row;
  if(found.result.state!=='confirmed')return {...this.receipt(await this.finish(row,phases,claim.actor)),...this.stamp()};
  const principal={issuer:found.result.issuer,externalSubject:found.result.externalSubject},targetId=managementId(principal.issuer,principal.externalSubject);
  if(this.rootTarget(principal)){phases[0]=phase('native-account','unknown','management_root_protected');return {...this.receipt(await this.finish(row,phases,claim.actor)),...this.stamp()};}
  // Keep the acknowledged immutable target even if the following native read
  // or local transaction fails; the same username is never adopted as proof.
  row=await this.update(row,phases,{targetId,binding:principal});let user;
  try{user=await this.directory.get(principal);if(!user||!user.enabled||!user.requiredActions.includes('UPDATE_PASSWORD'))fail('management_identity_response_invalid',503);}
  catch(error){phases[0]=phase('native-account','unknown',managementSafeCode(error));return {...this.receipt(await this.finish(row,phases,claim.actor)),...this.stamp()};}
  found=await this.invoke(row,phases,'local-principal',async()=>{const actor=await gate(),meta=await transaction(this.db,db=>this.principalWithin(db,user,actor,{note:x.note}));return {state:'confirmed',revision:meta.version};});row=found.row;
  if(found.result.state==='confirmed')row=await this.update(row,phases,{revision:found.result.revision});
  if(found.result.state==='confirmed'){
   found=await this.invoke(row,phases,'native-admission',async()=>{const result=await this.directory.admission(principal,'reader',{authorize:gate});if(result.state!=='confirmed')return result;
    await this.invalidate({...principal,operatorId:targetId});const current=await this.directory.get(principal);return current?.admission==='reader'?{state:'confirmed'}:{state:'unknown',code:'management_identity_response_invalid'};});row=found.row;
  }
  if(phases.every(p=>p.state==='confirmed')&&x.roleIds.length){
   found=await this.invoke(row,phases,'business-assignments',async()=>{
    for(const roleId of x.roleIds){const actor=await gate();await this.assignment(actor,targetId,{operationId:childId(x.operationId,roleId),expectedVersion:0,roleId,enabled:true},{authorize});}
    return {state:'confirmed'};});row=found.row;
  }
  await this.invalidate({...principal,operatorId:targetId});row=await this.finish(row,phases,claim.actor);
  await this.actor(original);return {...this.receipt(row),...this.stamp()};
 }
 async command(operator,id,input,{authorize}={}){
  const x=parse(managementCommandSchema,input),action=managementCommandActions[x.kind],original=await this.actor(operator);
  // Receipt replay is resolved before a current target read, allowing a prior
  // successful delete to retain its original result without recreating a user.
  await this.current(original,action,authorize);const prior=(await this.db.query('SELECT * FROM operations_management_commands_v1 WHERE operation_id=$1',[x.operationId])).rows[0];
  if(prior){if(prior.endpoint!==this.endpoint||prior.operator_id!==original.operatorId||prior.target_operator_id!==id||prior.kind!==x.kind||!isDeepStrictEqual(prior.input,managementIntent(x)))fail('management_operation_conflict',409);
   return {...this.receipt(prior,true),...this.stamp()};}
  const target=await this.targetWithin(this.db,id),current=await this.native(target);if(!current.identity)fail(current.state==='not-found'?'management_identity_not_found':'management_identity_unavailable',current.state==='not-found'?404:503);
  let expected=current.identity;const claim=await this.reserve(original,x.kind,x,{targetId:id,user:expected,action,authorize});if(claim.old)return {...this.receipt(claim.old,true),...this.stamp()};
  let row=claim.row;const phases=[],principal={operatorId:id,issuer:expected.issuer,externalSubject:expected.externalSubject};
  const authority=async()=>{const actor=await this.current(original,action,authorize);this.guard(actor,expected,x.kind);return actor;};
  const gate=async()=>{await authority();const live=await this.directory.get(principal);if(!live||!sameNative(live,expected))fail('management_identity_target_changed',409);
   const local=await this.targetWithin(this.db,id);if(local.deleted_at)fail('management_identity_target_changed',409);return authority();};
  const perform=async(kind,run)=>{const done=await this.invoke(row,phases,kind,run);row=done.row;return done.result;};
  const saveLocal=async(fields)=>{const actor=await authority(),meta=await this.local(row,expected,actor,fields,db=>this.current(original,action,authorize,db));await this.invalidate(principal);return {state:'confirmed',revision:meta.version};};
  const revoke=async({missing=false}={})=>{
   if(!missing)await perform('native-sessions',()=>this.directory.logout(principal,{authorize:gate}));
   await perform('portal-sessions',async()=>{await authority();return this.portal(principal);});
  };
  if(x.kind==='profile-update'){
   let result={state:'confirmed'};
   if(Object.hasOwn(x,'firstName')||Object.hasOwn(x,'lastName'))result=await perform('native-account',()=>this.directory.profile(principal,x,{authorize:gate}));
   if(result.state==='confirmed'){
    const live=await this.directory.get(principal),wanted={...expected,...(Object.hasOwn(x,'firstName')?{firstName:x.firstName}:{}),...(Object.hasOwn(x,'lastName')?{lastName:x.lastName}:{})};
    if(!sameNative(live,wanted)){phases.push(phase('native-account','unknown','management_identity_target_changed'));}
    else{expected=live;await perform('local-principal',()=>saveLocal({note:x.note}));}
   }
  }else if(x.kind==='login-disable'||x.kind==='delete'){
   await perform('local-principal',()=>saveLocal({loginBlocked:true}));
   if(phases.every(p=>p.state==='confirmed')){
    const result=await perform('native-account',()=>x.kind==='delete'?this.directory.remove(principal,{authorize:gate}):this.directory.setEnabled(principal,false,{authorize:gate}));
    if(result.state==='confirmed'){
     const live=await this.directory.get(principal);
     if(x.kind==='delete'&&live===null){await perform('local-principal',()=>saveLocal({deleted:true,loginBlocked:true}));await revoke({missing:true});}
     else if(x.kind==='login-disable'&&live&&sameNative(live,{...expected,enabled:false})){expected=live;await revoke();}
     else phases.push(phase('native-account','unknown','management_identity_target_changed'));
    }
   }
  }else if(x.kind==='login-restore'){
   const result=expected.enabled?{state:'confirmed'}:await perform('native-account',()=>this.directory.setEnabled(principal,true,{authorize:gate}));
   if(result.state==='confirmed'){
    const live=await this.directory.get(principal);if(live&&sameNative(live,{...expected,enabled:true})){expected=live;await perform('local-principal',()=>saveLocal({loginBlocked:false}));}
    else phases.push(phase('native-account','unknown','management_identity_target_changed'));
   }
  }else if(x.kind==='password-reset'){
   const result=await perform('native-account',()=>this.directory.resetPassword(principal,x.temporaryPassword,{authorize:gate}));
   if(result.state==='confirmed'){
    const live=await this.directory.get(principal);if(!live||!live.requiredActions.includes('UPDATE_PASSWORD'))phases.push(phase('native-account','unknown','management_identity_response_invalid'));
    else{expected=live;await perform('local-principal',()=>saveLocal({}));await revoke();}
   }
  }else if(x.kind==='sessions-revoke')await revoke();
  else if(x.kind==='admission-change'){
   const desired=x.action==='promote'?'administrator':'reader',result=await perform('native-admission',()=>this.directory.admission(principal,desired,{authorize:gate}));
   if(result.state==='confirmed'){
    const live=await this.directory.get(principal);await this.invalidate(principal);if(live?.admission!==desired)phases.push(phase('native-admission','unknown','management_identity_response_invalid'));
    else{expected=live;await perform('local-principal',()=>saveLocal({}));await revoke();}
   }
  }else if(x.kind==='email-change'){
   await perform('email-verification',()=>this.directory.requestEmailChange(principal,x.newEmail,{operationId:x.operationId,authorize:gate}));
  }
  row=await this.finish(row,phases,claim.actor);
  // A self-revocation may end the HTTP session after effects. The owner-only
  // original result remains durable; failure to reauthenticate cannot erase it.
  await this.actor(original);return {...this.receipt(row),...this.stamp()};
 }
 async assignment(operator,id,input,{authorize}={}){
  const x=parse(managementAssignmentSchema,input),original=await this.actor(operator);await this.current(original,'permissions.assignments.write',authorize);
  const source=await this.targetWithin(this.db,id),native=await this.native(source);if(!native.identity)fail('management_identity_unavailable',503);
  const check=async(db=this.db,actor=original)=>{const meta=await this.targetWithin(db,id),user=await this.directory.get({issuer:source.issuer,externalSubject:source.external_subject});
   if(!user?.enabled||user.admission==='none'||meta.login_blocked||meta.deleted_at)fail('management_identity_target_changed',409);this.guard(actor,user,'assignment');return user;};
  const user=await check();await transaction(this.db,db=>this.principalWithin(db,user,original));
  const result=await this.businessAdmin.permissions.saveAssignment(original,{...x,operatorId:id},{authorizeTarget:async(db,actor)=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912463))',[JSON.stringify([this.endpoint,id])]);await check(db,actor);
  },authorize:async()=>{const fresh=await authorize();if(fresh?.operatorId!==original.operatorId||fresh.endpoint!==this.endpoint)fail('business_admin_denied');return fresh;}});
  await this.invalidate({operatorId:id,issuer:user.issuer,externalSubject:user.externalSubject});return result;
 }
 assignmentOperation(operator,id,operationId){if(!uuid(operationId))fail('invalid_management_accounts_request',400);return this.read(operator,async(db,actor)=>{
  await this.targetWithin(db,id);const row=(await db.query("SELECT id,operator_id,kind,input,result FROM operations_permission_events_v1 WHERE endpoint=$1 AND id=$2 AND kind='assignment-save'",[this.endpoint,operationId])).rows[0];
  if(!row)return {state:'not-recorded',operationId,kind:null,selection:null,result:null};
  if(row.operator_id!==actor.operatorId||row.input?.operatorId!==id)fail('management_operation_not_found',404);
  const x=parse(managementAssignmentSchema,((v)=>({operationId:v.operationId,...(v.id?{id:v.id}:{}),expectedVersion:v.expectedVersion,roleId:v.roleId,enabled:v.enabled}))(row.input)),a=row.result?.assignment;
  if(!a||!uuid(a.id)||a.operatorId!==id||a.roleId!==x.roleId||typeof a.enabled!=='boolean'||!Number.isSafeInteger(a.version)||a.version<1
   ||![a.createdAt,a.updatedAt,row.result?.recordedAt].every(v=>typeof v==='string'&&Number.isFinite(Date.parse(v))))fail('management_command_unavailable',503);
  return {state:'recorded',operationId,operatorId:row.operator_id,kind:'assignment-save',selection:{id:x.id??null,expectedVersion:x.expectedVersion,operatorId:id,roleId:x.roleId,enabled:x.enabled},
   result:{assignment:{id:a.id,operatorId:id,roleId:a.roleId,enabled:a.enabled,version:a.version,createdAt:a.createdAt,updatedAt:a.updatedAt},operationId,recordedAt:row.result.recordedAt,replayed:true}};
 });}
}
