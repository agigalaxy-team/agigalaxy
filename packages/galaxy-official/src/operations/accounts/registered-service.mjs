import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {transaction} from '../../database.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {reserveOfficialAccountWithin} from '../../official-account-registration.mjs';
import {RegisteredUsersReadModel,registeredTargetVersion,registeredStamp} from './registered-read-model.mjs';
import {registeredUsersParse as parse,registeredUserIdSchema,registeredUserCommandSchema,registeredCommandActions} from './registered-schema.mjs';

const fail=(code,status=403)=>{throw new ServiceError(code,status);};
const effect=(state,code=null,extra={})=>({state,code,...extra});
const controlledError=error=>['operations_permission_denied','business_admin_denied','operations_authorization_unavailable','registered_identity_not_found','registered_identity_management_not_configured','registered_identity_target_changed'].includes(error?.code)?error.code:'registered_command_unavailable';

// PG original-intent reservation precedes external effects. A repeated POST or
// receipt read returns that reservation/result; it never repeats action-email.
export class OperationsRegisteredUsersService extends RegisteredUsersReadModel{
 async current(original,action,authorize,db=this.db){
  if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  const fresh=await authorize();if(fresh?.kind!=='business-operator'||fresh.operatorId!==original.operatorId||fresh.endpoint!==this.endpoint)fail('business_admin_denied');
  await this.actor(fresh,{db});return this.actor(fresh,{db,action});
 }
 async auditWithin(db,actor,id,kind,result,accountId){
  await this.businessAdmin.recordWithin(db,actor,'registered-user-'+kind,{accountId,operationId:id,selection:{registrationId:result.registrationId,kind},
   result:{state:result.state,kind,profileRevision:result.result?.effects?.profile?.revision??null}});
 }
 async command(operator,id,input,{authorize}={}){
  parse(registeredUserIdSchema,id);const x=parse(registeredUserCommandSchema,input),action=registeredCommandActions[x.kind];
  const original=await this.actor(operator);await this.current(original,action,authorize);
  // Only a current native read may supply the target-state precondition.
  const target=await this.targetWithin(this.db,id),current=await this.native(target);
  if(x.kind!=='profile-correct'&&!current.identity)fail(current.state==='not-found'?'registered_identity_not_found':'registered_identity_unavailable',current.state==='not-found'?404:503);
  const claim=await transaction(this.db,async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912452))',[JSON.stringify([this.endpoint,x.operationId])]);
   const actor=await this.current(original,action,authorize,db);
   if(x.kind==='password-reset')await this.actor(actor,{db,action:'accounts.identity.read'});
   const editsProfile=x.kind==='profile-preset'||x.kind==='profile-correct'&&(Object.hasOwn(x,'avatarKey')||Object.hasOwn(x,'bio'));
   if(editsProfile)await this.actor(actor,{db,action:'accounts.read'});
   const old=(await db.query('SELECT * FROM operations_registered_commands_v1 WHERE operation_id=$1',[x.operationId])).rows[0];
   if(old){if(old.endpoint!==this.endpoint||old.operator_id!==actor.operatorId||old.registration_id!==id||!isDeepStrictEqual(old.input,x))fail('registered_operation_conflict',409);return {old};}
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912453))',[JSON.stringify([this.endpoint,id])]);
   const active=(await db.query("SELECT 1 FROM operations_registered_commands_v1 WHERE endpoint=$1 AND registration_id=$2 AND state IN ('accepted','unknown') LIMIT 1",[this.endpoint,id])).rows[0];
   if(active)fail('registered_operation_pending',409);
   const row=await this.targetWithin(db,id);
   if(registeredTargetVersion(row,current.identity)!==x.expectedVersion)fail('registered_user_changed',409);
   if(x.kind==='profile-preset'){
    if(row.account_id)fail('registered_business_profile_already_formed',409);
    const reserved=await reserveOfficialAccountWithin(db,{endpoint:this.endpoint,issuer:row.issuer,externalSubject:row.external_subject,now:this.now()});
    const live=await this.targetWithin(db,id);
    if(live.account_id)fail('registered_business_profile_already_formed',409);
    const preset=(await db.query('SELECT * FROM official_account_registrations_v1 WHERE account_id=$1 FOR UPDATE',[reserved.account_id])).rows[0];
    if(preset.adopted_at||preset.preset_revision!==x.expectedPresetRevision)fail('registered_user_changed',409);
    const displayName=x.displayName??preset.display_name??reserved.uid,avatarKey=Object.hasOwn(x,'avatarKey')?x.avatarKey:preset.avatar_key??null,bio=Object.hasOwn(x,'bio')?x.bio:preset.bio??'';
    const changedFields=[...(displayName!==(preset.display_name??reserved.uid)?['displayName']:[]),...((preset.avatar_key??null)!==avatarKey?['avatarKey']:[]),...((preset.bio??'')!==bio?['bio']:[])];
    const at=registeredStamp(this.now()*1000),changed=(await db.query(`UPDATE official_account_registrations_v1
     SET display_name=$2,avatar_key=$3,bio=$4,preset_revision=preset_revision+1,preset_updated_by=$5,updated_at=$6
     WHERE account_id=$1 RETURNING preset_revision`,[reserved.account_id,displayName,avatarKey,bio,actor.operatorId,at])).rows[0];
    const result={effects:{profile:effect('confirmed',null,{revision:changed.preset_revision})},passwordChanged:null,participationChanged:false,changedFields,
     preset:{reservedAccountId:reserved.account_id,uid:reserved.uid,revision:changed.preset_revision}};
    const saved=(await db.query(`INSERT INTO operations_registered_commands_v1(operation_id,endpoint,operator_id,registration_id,kind,state,input,result,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,'completed',$6,$7,$8,$8) RETURNING *`,[x.operationId,this.endpoint,actor.operatorId,id,x.kind,JSON.stringify(x),JSON.stringify(result),at])).rows[0];
    const final=await this.current(original,action,authorize,db);await this.actor(final,{db,action:'accounts.read'});
    await this.auditWithin(db,actor,x.operationId,x.kind,this.receipt(saved),null);return {old:saved};
   }
   if(x.kind==='profile-correct'){
    if(!row.profile_account_id)fail('registered_business_profile_missing',409);
    const profile=(await db.query('SELECT revision,display_name,avatar_key,bio FROM official_account_profiles_v1 WHERE account_id=$1 FOR UPDATE',[row.account_id])).rows[0];
    if(!profile||profile.revision!==x.expectedProfileRevision||profile.revision!==row.profile_revision)fail('registered_user_changed',409);
    const avatarKey=Object.hasOwn(x,'avatarKey')?x.avatarKey:profile.avatar_key??null,bio=Object.hasOwn(x,'bio')?x.bio:profile.bio??'';
    const changedFields=[...(profile.display_name!==x.displayName?['displayName']:[]),...((profile.avatar_key??null)!==avatarKey?['avatarKey']:[]),...((profile.bio??'')!==bio?['bio']:[])];
    const changed=(await db.query('UPDATE official_account_profiles_v1 SET display_name=$2,revision=revision+1,updated_at=$3,avatar_key=$4,bio=$5 WHERE account_id=$1 RETURNING revision',[row.account_id,x.displayName,registeredStamp(this.now()*1000),avatarKey,bio])).rows[0];
    const result={effects:{profile:effect('confirmed',null,{revision:changed.revision})},passwordChanged:null,participationChanged:false,changedFields,...(changedFields.includes('displayName')?{correction:{field:'displayName',before:profile.display_name??null,after:x.displayName}}:{})};
    const saved=(await db.query(`INSERT INTO operations_registered_commands_v1(operation_id,endpoint,operator_id,registration_id,kind,state,input,result,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,'completed',$6,$7,$8,$8) RETURNING *`,[x.operationId,this.endpoint,actor.operatorId,id,x.kind,JSON.stringify(x),JSON.stringify(result),registeredStamp(this.now()*1000)])).rows[0];
    const final=await this.current(original,action,authorize,db);if(editsProfile)await this.actor(final,{db,action:'accounts.read'});await this.auditWithin(db,actor,x.operationId,x.kind,this.receipt(saved),row.account_id);return {old:saved};
   }
   if(!this.directory?.managementConfigured)fail('registered_identity_management_not_configured',503);
   if(x.kind==='password-reset'&&(!current.identity.enabled||!current.identity.email||!current.identity.emailVerified))fail('registered_reset_link_ineligible',409);
   if(x.kind==='login-disable'&&!current.identity.enabled||x.kind==='login-restore'&&current.identity.enabled)fail('registered_user_changed',409);
   const at=registeredStamp(this.now()*1000),saved=(await db.query(`INSERT INTO operations_registered_commands_v1(operation_id,endpoint,operator_id,registration_id,kind,state,input,result,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'accepted',$6,$7,$8,$8) RETURNING *`,[x.operationId,this.endpoint,actor.operatorId,id,x.kind,JSON.stringify(x),JSON.stringify({effects:{},passwordChanged:x.kind==='password-reset'?false:null,participationChanged:false}),at])).rows[0];
   await this.auditWithin(db,actor,x.operationId,x.kind,this.receipt(saved),row.account_id);return {saved,row};
  });
  if(claim.old)return {...this.receipt(claim.old,true),...this.stamp()};
  const principal={issuer:claim.row.issuer,externalSubject:claim.row.external_subject},effects={};let expectedNative=current.identity;
  const sameNative=(a,b)=>['issuer','externalSubject','email','emailVerified','enabled','registeredAt','serviceAccount'].every(key=>a?.[key]===b?.[key]);
  const gate=async()=>{
   await this.current(original,action,authorize);const native=await this.native(claim.row);if(!native.identity)fail('registered_identity_not_found',409);
   if(!sameNative(native.identity,expectedNative))fail('registered_identity_target_changed',409);
   await this.current(original,action,authorize);
  };
  const invoke=async(key,run)=>{try{effects[key]=await run();}catch(error){effects[key]=effect('failed',controlledError(error));}return effects[key];};
  if(x.kind==='password-reset')await invoke('identity',()=>this.directory.resetLink(principal,{authorize:gate}));
  if(x.kind==='login-disable'||x.kind==='login-restore'){
   await invoke('identity',()=>this.directory.setEnabled(principal,x.kind==='login-restore',{authorize:gate}));
   if(effects.identity.state==='confirmed')expectedNative={...expectedNative,enabled:x.kind==='login-restore'};
  }
  // Acknowledged disable also revokes existing SSO and website sessions. Restore
  // never restores sessions, a participation restriction or a reset credential.
  if(x.kind==='sessions-revoke'||x.kind==='login-disable'&&effects.identity?.state==='confirmed'){
   await invoke('ssoSessions',()=>this.directory.logout(principal,{authorize:gate}));
   await invoke('websiteSessions',async()=>{
    await gate();if(typeof this.accountPortal?.revokeSessions!=='function')return effect('not-configured','registered_website_sessions_unavailable');
    const result=await this.accountPortal.revokeSessions({accountId:claim.row.account_id??null,...principal});
    if(!Number.isSafeInteger(result?.revokedSessions)||result.revokedSessions<0||result.inflightBlocked!==true)return effect('unknown','registered_website_session_fence_unconfirmed');
    return effect('confirmed',null,{revokedSessions:result.revokedSessions});
   });
  }
  const states=Object.values(effects).map(value=>value.state),state=states.includes('unknown')?'unknown':states.every(value=>value==='confirmed')?'completed':states.every(value=>value==='submitted')?'submitted':states.some(value=>['confirmed','submitted'].includes(value))?'partial':'failed';
  const result=this.safeResult({effects,passwordChanged:x.kind==='password-reset'?false:null,participationChanged:false});
  const saved=(await this.db.query('UPDATE operations_registered_commands_v1 SET state=$3,result=$4,updated_at=$5 WHERE endpoint=$1 AND operation_id=$2 RETURNING *',
   [this.endpoint,x.operationId,state,JSON.stringify(result),registeredStamp(this.now()*1000)])).rows[0];
  // A failed post-effect read authorization cannot erase a submitted effect or
  // disclose results to a newly unauthorised browser. GET remains read-only.
  await this.actor(original);return {...this.receipt(saved),...this.stamp()};
 }
}
