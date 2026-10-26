import {createHash} from 'node:crypto';
import {transaction} from '../../database.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {businessRestrictionView} from '../../business-admin-domain.mjs';
import {RegisteredDirectory} from './registered-directory.mjs';
import {registeredUsersParse as parse,registeredUsersQuerySchema,registeredUserIdSchema,registeredUsersHistorySchema} from './registered-schema.mjs';

export const registeredStamp=value=>value===null||value===undefined?null:new Date(value).toISOString();
const fail=(code,status=403)=>{throw new ServiceError(code,status);};
const columns=`s.id AS registration_id,s.issuer,s.external_subject,e.present,e.email,e.email_verified,e.enabled,e.registered_at,e.identity_display_name,e.observed_at,
 a.id AS account_id,a.uid,a.created_at AS business_created_at,a.verified_at,a.restricted_until,a.restriction_reason,a.restriction_revision,
 p.account_id AS profile_account_id,p.display_name,p.avatar_key,p.bio,p.subject_type,p.revision AS profile_revision,
 r.account_id AS reserved_account_id,r.uid AS reserved_uid,r.display_name AS preset_name,r.avatar_key AS preset_avatar_key,r.bio AS preset_bio,
 r.preset_revision,r.updated_at AS preset_updated_at,r.adopted_at AS preset_adopted_at`;
const join=`FROM operations_registered_subjects_v1 s JOIN operations_registered_entries_v1 e ON e.registration_id=s.id AND e.generation_id=$2
 LEFT JOIN community_accounts a ON a.endpoint=s.endpoint AND a.issuer=s.issuer AND a.external_subject=s.external_subject
 LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id
 LEFT JOIN official_account_registrations_v1 r ON r.endpoint=s.endpoint AND r.issuer=s.issuer AND r.external_subject=s.external_subject WHERE s.endpoint=$1`;
const actionCaps=Object.freeze({canResetPassword:'accounts.password.reset',canDisableLogin:'accounts.login.disable',canRestoreLogin:'accounts.login.restore',canRevokeSessions:'accounts.sessions.revoke',canCorrectProfile:'accounts.profile.correct'});
const resultCodes=new Set(['registered_identity_submission_unknown','registered_identity_write_forbidden','registered_identity_client_unavailable','registered_identity_not_found',
 'registered_identity_changed','registered_identity_write_failed','registered_identity_management_not_configured','registered_identity_target_changed','registered_command_unavailable',
 'registered_website_sessions_unavailable','registered_website_session_fence_unconfirmed','operations_permission_denied','business_admin_denied','operations_authorization_unavailable']);
export const registeredTargetVersion=(row,identity)=>createHash('sha256').update(JSON.stringify([row.registration_id,row.issuer,row.external_subject,
 identity?{enabled:identity.enabled,email:identity.email,emailVerified:identity.emailVerified,registeredAt:identity.registeredAt,serviceAccount:identity.serviceAccount}:null,
 row.account_id??null,row.profile_account_id??null,row.profile_revision??null,row.display_name??null,row.reserved_account_id??null,row.reserved_uid??null,row.preset_revision??null])).digest('hex');

export class RegisteredUsersReadModel{
 constructor({businessAdmin,directory=null,accountPortal=null,db=businessAdmin?.db,endpoint=businessAdmin?.endpoint,now=businessAdmin?.now??(()=>Math.floor(Date.now()/1000))}){
  if(!businessAdmin||!db||typeof endpoint!=='string')throw Error('Registered users require the current business authorizer.');
  Object.assign(this,{businessAdmin,directory,accountPortal,db,endpoint,now});this.index=new RegisteredDirectory({db,endpoint,directory,now});
 }
 stamp(){const checkedAt=this.now();return {checkedAt,readExpiresAt:checkedAt+30,metadataOnly:true};}
 async actor(operator,{db=this.db,action='accounts.registered.read'}={}){
  if(operator?.kind!=='business-operator')fail('business_admin_denied');return this.businessAdmin.authorizeAction(operator,action,{db});
 }
 async read(operator,operation){return transaction(this.db,async db=>{const actor=await this.actor(operator,{db});const result=await operation(db,actor);await this.actor(actor,{db});return {...result,...this.stamp()};},{isolation:'repeatable read'});}
 sync(){return this.index.sync();}
 permissions(actor){return {canReadIdentity:actor.businessAuthorization.permissions.includes('accounts.identity.read'),canReadProfile:actor.businessAuthorization.permissions.includes('accounts.read')};}
 item(row,{identity=null,readIdentity=true,stage=null}={}){
  const native=identity??{issuer:row.issuer,externalSubject:row.external_subject,email:row.email,emailVerified:row.email_verified,enabled:row.enabled,registeredAt:registeredStamp(row.registered_at),displayName:row.identity_display_name};
  const presence=row.issuer!==this.directory?.issuer?'outside-configured-issuer':identity?'present':row.present?'present':'not-found';
  return {registrationId:row.registration_id,
   identity:{source:'keycloak-website',issuer:readIdentity?row.issuer:null,subject:readIdentity?row.external_subject:null,email:readIdentity?native.email??null:null,
    emailVerified:native.emailVerified??null,enabled:native.enabled??null,registeredAt:native.registeredAt??null,displayName:native.displayName??null,
    presence,readState:readIdentity?'available':'not-authorized'},
   business:row.account_id?{accountId:row.account_id,uid:row.uid??null,displayName:row.display_name??null,avatarKey:row.avatar_key??null,subjectType:row.subject_type??null,profileRevision:row.profile_revision??0,
    businessCreatedAt:registeredStamp(row.business_created_at),verifiedAt:registeredStamp(row.verified_at),restriction:businessRestrictionView(row,this.now())}:null,
   registrationProfile:!row.account_id&&row.reserved_account_id?{state:row.preset_revision>0?'preset':'reserved',reservedAccountId:row.reserved_account_id,uid:row.reserved_uid,displayName:row.preset_revision>0?row.preset_name??'':'',avatarKey:row.preset_avatar_key??null,revision:row.preset_revision,updatedAt:registeredStamp(row.preset_updated_at)}:null,
   stage:stage??{state:'unknown',basis:'not-read'},observedAt:registeredStamp(row.observed_at)};
 }
 list(operator,input={}){
  const x=parse(registeredUsersQuerySchema,input);
  return this.read(operator,async(db,actor)=>{
   const permissions=this.permissions(actor);if(x.query?.includes('@')&&!permissions.canReadIdentity)fail('operations_permission_denied');
   const source=await this.index.source(db),pagination={page:x.page,pageSize:x.pageSize,total:null,matchingTotal:null,totalPages:null};
   if(!source.generationId)return {items:[],pagination,source,permissions};
   const values=[this.endpoint,source.generationId],where=[];const arg=value=>{values.push(value);return '$'+values.length;};
   const population=x.source==='registered'?' AND e.present':x.source==='business-only'?' AND NOT e.present AND a.id IS NOT NULL':' AND (e.present OR a.id IS NOT NULL)';
   if(x.query){const value=arg(x.query),exactEmail=permissions.canReadIdentity&&x.query.includes('@');
    where.push(exactEmail?`lower(e.email)=lower(${value})`:`(coalesce(a.uid,r.uid) ILIKE '%'||${value}||'%' OR coalesce(p.display_name,r.display_name) ILIKE '%'||${value}||'%' OR e.identity_display_name ILIKE '%'||${value}||'%'${permissions.canReadIdentity?` OR e.email ILIKE '%'||${value}||'%'`:''}
     OR EXISTS(SELECT 1 FROM community_account_links cl WHERE cl.account_id=a.id AND cl.subject_id=${value}))`);
   }
   if(x.subjectType)where.push(x.subjectType==='unknown'?'p.subject_type IS NULL':`p.subject_type=${arg(x.subjectType)}`);
   if(x.business)where.push(x.business==='formed'?'a.id IS NOT NULL':'a.id IS NULL');
   if(x.login)where.push(`e.enabled=${arg(x.login==='enabled')}`);
   if(x.emailVerified)where.push(`e.email_verified=${arg(x.emailVerified==='yes')}`);
   if(x.registeredFrom)where.push(`e.registered_at>=${arg(x.registeredFrom)}::timestamptz`);
   if(x.registeredTo)where.push(`e.registered_at<=${arg(x.registeredTo)}::timestamptz`);
   if(x.participation){const active=`(a.restricted_until IS NOT NULL AND a.restricted_until>${arg(registeredStamp(this.now()*1000))}::timestamptz)`;where.push('a.id IS NOT NULL AND '+(x.participation==='restricted'?active:'NOT '+active));}
   const base='SELECT '+columns+' '+join+population,filtered=where.length?' AND '+where.join(' AND '):'';
   const total=(await db.query('SELECT count(*)::text AS n '+join+population,[this.endpoint,source.generationId])).rows[0].n;
   const matching=(await db.query('SELECT count(*)::text AS n '+join+population+filtered,values)).rows[0].n;
   const limit=arg(x.pageSize),offset=arg((x.page-1)*x.pageSize),order=x.sort==='registered-asc'?'ASC':'DESC';
   const rows=(await db.query(base+filtered+` ORDER BY e.registered_at ${order} NULLS LAST,s.id ASC LIMIT ${limit} OFFSET ${offset}`,values)).rows;
   if(!Number.isSafeInteger(Number(total))||!Number.isSafeInteger(Number(matching)))fail('registered_directory_count_unavailable',503);
   return {items:rows.map(row=>this.item(row,{readIdentity:permissions.canReadIdentity})),pagination:{...pagination,total:Number(total),matchingTotal:Number(matching),totalPages:Math.ceil(Number(matching)/x.pageSize)},source,permissions};
  });
 }
 async targetWithin(db,id){
  parse(registeredUserIdSchema,id);
  const row=(await db.query(`SELECT ${columns} FROM operations_registered_subjects_v1 s
   LEFT JOIN operations_registered_directory_v1 d ON d.endpoint=s.endpoint
   LEFT JOIN operations_registered_entries_v1 e ON e.registration_id=s.id AND e.generation_id=d.generation_id
   LEFT JOIN community_accounts a ON a.endpoint=s.endpoint AND a.issuer=s.issuer AND a.external_subject=s.external_subject
   LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id
 LEFT JOIN official_account_registrations_v1 r ON r.endpoint=s.endpoint AND r.issuer=s.issuer AND r.external_subject=s.external_subject WHERE s.endpoint=$1 AND s.id=$2`,[this.endpoint,id])).rows[0];
  if(!row)fail('registered_user_not_found',404);return row;
 }
 async native(row){
  if(!this.directory)return {identity:null,state:'not-configured'};
  if(row.issuer!==this.directory.issuer)return {identity:null,state:'outside-configured-issuer'};
  try{const identity=await this.directory.get({issuer:row.issuer,externalSubject:row.external_subject});
   if(identity&&(identity.issuer!==row.issuer||identity.externalSubject!==row.external_subject))return {identity:null,state:'unavailable'};
   return {identity,state:identity?'available':'not-found'};
  }catch{return {identity:null,state:'unavailable'};}
 }
 async historyWithin(db,id,input={}){
  const x=parse(registeredUsersHistorySchema,input);
  const rows=(await db.query(`SELECT c.sequence,c.operation_id,c.operator_id,c.kind,c.state,c.result,c.input,c.created_at,c.updated_at,o.display_name AS operator_display_name FROM operations_registered_commands_v1 c
   LEFT JOIN operations_operator_principals_v1 o ON o.endpoint=c.endpoint AND o.operator_id=c.operator_id
   WHERE c.endpoint=$1 AND c.registration_id=$2 AND ($3::bigint IS NULL OR c.sequence<$3) ORDER BY c.sequence DESC LIMIT $4`,[this.endpoint,id,x.after??null,x.limit+1])).rows;
  return {items:rows.slice(0,x.limit).map(row=>({sequence:String(row.sequence),operationId:row.operation_id,operatorId:row.operator_id,kind:row.kind,state:row.state,
   operatorDisplayName:typeof row.operator_display_name==='string'&&row.operator_display_name.length<=240?row.operator_display_name:null,
   reason:typeof row.input?.reason==='string'&&row.input.reason.length<=1000?row.input.reason:null,
   basis:['profile-correct','profile-preset'].includes(row.kind)&&typeof row.input?.basis==='string'&&row.input.basis.length<=1000?row.input.basis:null,
   result:this.safeResult(row.result),createdAt:registeredStamp(row.created_at),updatedAt:registeredStamp(row.updated_at)})),nextAfter:rows.length>x.limit?String(rows[x.limit-1].sequence):null};
 }
 safeResult(value){
  const effects={};for(const key of ['identity','ssoSessions','websiteSessions','profile']){
   const row=value?.effects?.[key];if(!row||!['confirmed','submitted','failed','unknown','not-required','not-configured'].includes(row.state))continue;
   const code=resultCodes.has(row.code)?row.code:null;
   effects[key]={state:row.state,code,...(Number.isSafeInteger(row.revokedSessions)&&row.revokedSessions>=0?{revokedSessions:row.revokedSessions}:{}),...(Number.isSafeInteger(row.revision)&&row.revision>=0?{revision:row.revision}:{})};
  }const change=value?.correction,correction=change?.field==='displayName'&&[change.before,change.after].every(v=>v===null||typeof v==='string'&&v.length<=120)?{field:'displayName',before:change.before,after:change.after}:null;
  const changedFields=Array.isArray(value?.changedFields)?['displayName','avatarKey','bio'].filter(key=>value.changedFields.includes(key)):null;
  const raw=value?.preset,preset=raw&&registeredUserIdSchema.safeParse(raw.reservedAccountId).success&&typeof raw.uid==='string'&&/^G[A-Z0-9]{10}[0-9]$/.test(raw.uid)&&Number.isSafeInteger(raw.revision)&&raw.revision>0?{reservedAccountId:raw.reservedAccountId,uid:raw.uid,revision:raw.revision}:null;
  return {effects,passwordChanged:value?.passwordChanged===false?false:null,participationChanged:false,...(correction?{correction}:{}),...(changedFields?{changedFields}:{}),...(preset?{preset}:{})};
 }
 async detail(operator,id){
  const initial=await this.actor(operator),row=await this.targetWithin(this.db,id),current=await this.native(row),identity=current.identity;
  let permissions=this.permissions(initial);
  let evidence={state:'unavailable',hasCredentials:null,hasFederatedIdentities:null},stage={state:'unknown',basis:'insufficient-native-evidence'};
  if(identity&&permissions.canReadIdentity)try{const facts=await this.directory.registrationEvidence({issuer:row.issuer,externalSubject:row.external_subject});
   evidence={state:'available',...facts};const pending=identity.enabled&&identity.email&&identity.local&&!identity.federated&&!identity.serviceAccount&&identity.requiredActions.includes('UPDATE_PASSWORD')&&!facts.hasCredentials&&!facts.hasFederatedIdentities;
   const completed=facts.hasCredentials||facts.hasFederatedIdentities||identity.federated;
   stage={state:pending?'completion-required':completed?'registered':'unknown',basis:pending||completed?'current-native-credential-and-federation-metadata':'insufficient-native-evidence'};
  }catch{/* A missing credential-metadata privilege is not an unfinished signup. */}
  const management=identity&&this.directory?await this.directory.management({issuer:row.issuer,externalSubject:row.external_subject}):{state:this.directory?'unavailable':'not-configured'};
  const sessions={sso:{state:'unavailable',activeCount:null,scope:'keycloak-user-sso'},website:{state:'unavailable',activeCount:null,scope:'website-portal'}};
  if(identity&&permissions.canReadIdentity){
   try{sessions.sso=await this.directory.sessionSummary({issuer:row.issuer,externalSubject:row.external_subject});}catch{/* No session IDs or upstream errors escape. */}
   if(typeof this.accountPortal?.sessionSummary==='function')try{const found=await this.accountPortal.sessionSummary({issuer:row.issuer,externalSubject:row.external_subject});
    if(Number.isSafeInteger(found?.activeCount)&&found.activeCount>=0)sessions.website={state:'available',activeCount:found.activeCount,scope:'website-portal'};
   }catch{/* An unavailable portal is not zero active sessions. */}
  }
  // Native I/O does not pin a PG transaction or a shared grant lock. Recheck
  // current read authority and mask identity facts again after every await.
  const actor=await this.actor(initial);permissions=this.permissions(actor);
  if(!permissions.canReadIdentity){evidence={state:'unavailable',hasCredentials:null,hasFederatedIdentities:null};stage={state:'unknown',basis:'not-authorized'};
   for(const key of ['sso','website'])sessions[key]={...sessions[key],state:'unavailable',activeCount:null};}
  const caps=Object.fromEntries(Object.entries(actionCaps).map(([key,code])=>[key,actor.businessAuthorization.permissions.includes(code)]));
  caps.canResetPassword&&=permissions.canReadIdentity&&!!identity?.enabled&&!!identity?.email&&identity.emailVerified===true&&management.state==='available';
  caps.canDisableLogin&&=!!identity?.enabled&&management.state==='available';caps.canRestoreLogin&&=identity?.enabled===false&&management.state==='available';
  caps.canRevokeSessions&&=!!identity&&management.state==='available'&&typeof this.accountPortal?.revokeSessions==='function';
  caps.canCorrectProfile&&=!!row.profile_account_id;
  caps.canPresetProfile=actor.businessAuthorization.permissions.includes('accounts.profile.correct')&&permissions.canReadProfile&&!!identity&&!row.account_id;
  const item=this.item({...row,present:current.state==='available',email:null,email_verified:null,enabled:null,registered_at:null,identity_display_name:null},{identity,readIdentity:permissions.canReadIdentity,stage});
  item.identity.presence=current.state==='available'?'present':current.state==='not-found'?'not-found':current.state;
  const history=await this.history(operator,id);
  // The history read itself revalidates the same current registration reader.
  const final=await this.actor(actor),finalPermissions=this.permissions(final);if(permissions.canReadIdentity&&!finalPermissions.canReadIdentity||permissions.canReadProfile&&!finalPermissions.canReadProfile)fail('operations_permission_denied');
  return {item,businessRef:row.account_id?{accountId:row.account_id,href:'/admin/operations/users?account='+row.account_id}:null,
   targetVersion:registeredTargetVersion(row,identity),versionBasis:'observed-current-source',permissions,capabilities:caps,
   websiteProfile:!permissions.canReadProfile?{state:'not-authorized',avatarKey:null,bio:null}:row.profile_account_id?{state:'available',source:'business-profile',avatarKey:row.avatar_key??null,bio:row.bio??''}:!row.account_id?{state:'available',source:'registration-preset',avatarKey:row.preset_avatar_key??null,bio:row.preset_bio??''}:{state:'not-formed',avatarKey:null,bio:null},
   security:{identityManagement:management.state,registrationEvidence:evidence,sessions},history:{items:history.items,nextAfter:history.nextAfter},...this.stamp()};
 }
 history(operator,id,input={}){return this.read(operator,async(db)=>{await this.targetWithin(db,id);return this.historyWithin(db,id,input);});}
 operation(operator,id){parse(registeredUserIdSchema,id);return this.read(operator,async(db,actor)=>{
  const row=(await db.query('SELECT * FROM operations_registered_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,id])).rows[0];
  if(!row)return {state:'not-recorded',operationId:id,registrationId:null,kind:null,result:null,recordedAt:null,replayed:false};
  if(row.operator_id!==actor.operatorId)fail('registered_operation_not_found',404);
  await this.targetWithin(db,row.registration_id);return this.receipt(row,true);
 });}
 receipt(row,replayed=false){return {state:row.state,operationId:row.operation_id,registrationId:row.registration_id,kind:row.kind,result:this.safeResult(row.result),recordedAt:registeredStamp(row.created_at),replayed};}
}
