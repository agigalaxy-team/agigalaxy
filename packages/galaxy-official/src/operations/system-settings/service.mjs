import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {transaction} from "../../infrastructure/database.mjs";
import {ServiceError} from '../../shared/service-error.mjs';
import {systemSettingsSections,systemSettingsSaveSchema,systemSettingsApplySchema,systemSettingsTestSchema,systemSettingsCredentialSchema,
 systemSettingsHistorySchema,systemSettingsNativeAuthorizationSchema,systemSettingsUuidSchema,systemSettingsOperationSchema,
 systemSettingsConfiguration,assertSystemSettingsEffectConfiguration,parseSystemSettings,credentialMetadata,safeSystemSettingsError} from './schema.mjs';
import {versionView,operationView,emptySystemSettingsConfiguration,systemSettingsNativeOverviewSchema,unavailableNativeOverview} from './read-model.mjs';

const actions=Object.freeze({read:'system.settings.read',save:'system.settings.configure',test:'system.settings.test',apply:'system.settings.apply',credential:'system.settings.credentials.write'});
const auditActions=Object.freeze({save:'system-settings-save',test:'system-settings-test',apply:'system-settings-apply',credential:'system-settings-credential-provision'});
const iso=value=>new Date(value).toISOString();
const fail=(code,status=409)=>{throw new ServiceError(code,status);};
const pending=new Set(['accepted','unknown']);

export class OperationsSystemSettingsService{
 constructor({businessAdmin,native=null,now=businessAdmin.now}={}){
  Object.assign(this,{businessAdmin,native,db:businessAdmin.db,endpoint:businessAdmin.endpoint,now});this.reconciling=new Map();
 }
 envelope(){return{checkedAt:this.now(),readExpiresAt:this.now()+30,metadataOnly:true};}
 human(operator){if(operator?.kind!=='business-operator')fail('system_settings_permission_denied',403);return this.businessAdmin.require(operator);}
 require(operator,action,db=this.db){return this.businessAdmin.authorizeAction(this.human(operator),action,{db});}
 async fresh(operator,action,authorize,db=this.db){
  if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  const current=this.human(await authorize());
  if(current.operatorId!==operator.operatorId||current.endpoint!==this.endpoint)fail('business_admin_denied',403);
  return this.require(current,action,db);
 }
 section(section){if(!systemSettingsSections.includes(section))fail('invalid_system_settings_request',400);return section;}
 lock(db,section){return db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912461))',[this.endpoint+':'+section]);}
 operationLock(db,id){return db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912462))',[this.endpoint+':'+id]);}
 head(db,section){return db.query('SELECT * FROM operations_system_settings_heads_v1 WHERE endpoint=$1 AND section=$2',[this.endpoint,section]).then(result=>result.rows[0]??{revision:0,version_id:null,pending_operation:null});}
 version(db,id,section){return id?db.query('SELECT * FROM operations_system_settings_versions_v1 WHERE endpoint=$1 AND id=$2 AND section=$3',[this.endpoint,id,section]).then(result=>result.rows[0]??null):Promise.resolve(null);}
 row(db,id){return db.query('SELECT * FROM operations_system_settings_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,id]).then(result=>result.rows[0]??null);}
 async nativeOverview(section){
  if(!this.native)return unavailableNativeOverview(false);
  try{
   const value=parseSystemSettings(systemSettingsNativeOverviewSchema,await this.native.call({kind:'settings-overview',section}));
   if(value.observedConfiguration!==null)value.observedConfiguration=systemSettingsConfiguration(section,value.observedConfiguration);
   return value;
  }catch{return unavailableNativeOverview(true);}
 }
 async read(operator,section){
  this.section(section);await this.require(operator,actions.read);
  let head=await this.head(this.db,section);if(head.pending_operation)await this.reconcile(head.pending_operation,operator.operatorId);
  const native=await this.nativeOverview(section);head=await this.head(this.db,section);
  const version=await this.version(this.db,head.version_id,section),actor=await this.require(operator,actions.read),permissions=actor.businessAuthorization.permissions;
  return{section,revision:head.revision,version:versionView(version),
   configuration:version?.configuration??native.observedConfiguration??emptySystemSettingsConfiguration(section),
   configurationBasis:version?'saved-version':native.observedConfiguration?'observed-current':'empty',
   availability:native.availability,current:native.current,credentials:native.credentials,
   pending:head.pending_operation?operationView(await this.row(this.db,head.pending_operation)):null,
   capabilities:{canRead:true,canSave:permissions.includes(actions.save)&&!head.pending_operation,
    canTest:permissions.includes(actions.test)&&native.capabilities.canTest&&!!version,
    canApply:permissions.includes(actions.apply)&&native.capabilities.canApply&&!head.pending_operation,
    canWriteCredential:permissions.includes(actions.credential)&&native.capabilities.canWriteCredential},...this.envelope()};
 }
 async overview(operator){
  await this.require(operator,actions.read);
  const sections=await Promise.all(systemSettingsSections.map(section=>this.read(operator,section)));
  await this.require(operator,actions.read);return{sections:Object.fromEntries(sections.map(row=>[row.section,row])),...this.envelope()};
 }
 async advanced(operator){
  // These controls use the mail configuration/version, never a second source.
  const mail=await this.read(operator,'mail');
  return{section:'advanced',revision:mail.revision,versionId:mail.version?.id??null,
   connections:mail.configuration.connections.map(row=>({id:row.id,name:row.name,connectionTimeoutMs:row.connectionTimeoutMs,
    greetingTimeoutMs:row.greetingTimeoutMs,socketTimeoutMs:row.socketTimeoutMs,maxConnections:row.maxConnections,
    rateLimit:row.rateLimit,rateWindowSeconds:row.rateWindowSeconds,dkimSelector:row.dkimSelector})),
   source:'mail-configuration',limitsScope:'per-worker-process',current:mail.current,
   capabilities:mail.capabilities,...this.envelope()};
 }
 async record(db,actor,row){
  await this.businessAdmin.recordWithin(db,actor,auditActions[row.kind],{operationId:row.operation_id,
   selection:{section:row.section,kind:row.kind,versionId:row.version_id,revision:row.revision},
   result:{state:row.state,versionId:row.version_id,revision:row.revision}});
 }
 assertPrior(row,{operator,section,kind,input}){
  if(row.operator_id!==operator.operatorId||row.section!==section||row.kind!==kind||!isDeepStrictEqual(row.input,input))fail('system_settings_operation_changed');
 }
 async prepare(operator,section,kind,input,{authorize}={}){
  this.section(section);await this.fresh(operator,actions[kind],authorize);
  const safeInput=kind==='credential'?credentialMetadata(input):input;
  return transaction(this.db,async db=>{
   await this.operationLock(db,input.operationId);await this.lock(db,section);
   const actor=await this.fresh(operator,actions[kind],authorize,db),prior=await this.row(db,input.operationId);
   if(prior){this.assertPrior(prior,{operator:actor,section,kind,input:safeInput});return{row:prior,replayed:true};}
   const head=await this.head(db,section),at=iso(this.now()*1000);
   if(head.revision!==input.expectedRevision)fail('system_settings_version_changed');
   if(head.pending_operation&&kind!=='credential')fail('system_settings_native_busy');
   let version=null,configuration=null;
   if(kind==='save'){
    configuration=systemSettingsConfiguration(section,input.configuration);
    version={id:randomUUID(),revision:head.revision+1,configuration,operator_id:actor.operatorId,created_at:at};
    await db.query('INSERT INTO operations_system_settings_versions_v1(id,endpoint,section,revision,configuration,operator_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
     [version.id,this.endpoint,section,version.revision,JSON.stringify(configuration),actor.operatorId,at]);
   }else if(kind!=='credential'){
    version=await this.version(db,input.versionId,section);
    if(!version||head.version_id!==version.id)fail('system_settings_version_changed');
    if(kind==='test'&&input.connectionId&&!version.configuration.connections.some(row=>row.id===input.connectionId))fail('invalid_system_settings_request',400);
    // Partial drafts can be saved. A known incomplete effect is rejected
    // before claiming a command, never stranded as an accepted/unknown apply.
    assertSystemSettingsEffectConfiguration(section,version.configuration,{kind,connectionId:input.connectionId});
   }
   const result={phases:[]},state=kind==='save'?'completed':'accepted';
   const row=(await db.query(`INSERT INTO operations_system_settings_commands_v1(endpoint,operation_id,operator_id,operator_role,section,kind,input,version_id,revision,state,result,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
    [this.endpoint,input.operationId,actor.operatorId,actor.role,section,kind,JSON.stringify(safeInput),version?.id??null,
     version?.revision??head.revision,state,JSON.stringify(result),at])).rows[0];
   if(kind==='save')await db.query(`INSERT INTO operations_system_settings_heads_v1(endpoint,section,revision,version_id,updated_at) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(endpoint,section) DO UPDATE SET revision=EXCLUDED.revision,version_id=EXCLUDED.version_id,updated_at=EXCLUDED.updated_at`,
    [this.endpoint,section,version.revision,version.id,at]);
   if(kind==='apply')await db.query('UPDATE operations_system_settings_heads_v1 SET pending_operation=$3,updated_at=$4 WHERE endpoint=$1 AND section=$2',[this.endpoint,section,row.operation_id,at]);
   await this.fresh(operator,actions[kind],authorize,db);await this.record(db,actor,row);
   return{row,version,replayed:false};
  });
 }
 nativeIntent(row,input=null){
  if(row.kind==='credential')return{kind:'settings-credential-provision',...row.input,operatorId:row.operator_id,credential:input?.credential};
  return this.version(this.db,row.version_id,row.section).then(version=>({kind:row.kind==='test'?'settings-test':'settings-apply',
   operationId:row.operation_id,operatorId:row.operator_id,section:row.section,revision:row.revision,
   versionId:row.version_id,configuration:version.configuration,...(row.input.connectionId?{connectionId:row.input.connectionId}:{})}));
 }
 async acceptNative(row,input){
  const value=parseSystemSettings(systemSettingsOperationSchema,input?.operation??input);
  if(value.operationId!==row.operation_id||value.section!==row.section||value.kind!==row.kind||value.versionId!==row.version_id||value.revision!==row.revision)
   fail('system_settings_native_response_invalid',503);
  if(row.kind==='credential'&&value.state==='completed'&&value.credentialRef!=='system-key:'+row.operation_id)fail('system_settings_native_response_invalid',503);
  return transaction(this.db,async db=>{
   await this.operationLock(db,row.operation_id);await this.lock(db,row.section);
   const current=await this.row(db,row.operation_id);if(!current||!pending.has(current.state))return current;
   const at=iso(this.now()*1000),result={...current.result,phases:value.phases,...(value.credentialRef?{credentialRef:value.credentialRef}:{})};
   const saved=(await db.query('UPDATE operations_system_settings_commands_v1 SET state=$3,result=$4,updated_at=$5 WHERE endpoint=$1 AND operation_id=$2 RETURNING *',
    [this.endpoint,row.operation_id,value.state,JSON.stringify(result),at])).rows[0];
   if(row.kind==='apply'&&['completed','partial','failed'].includes(value.state))await db.query('UPDATE operations_system_settings_heads_v1 SET pending_operation=NULL,updated_at=$4 WHERE endpoint=$1 AND section=$2 AND pending_operation=$3',[this.endpoint,row.section,row.operation_id,at]);
   return saved;
  });
 }
 async unknown(row,error){
  const code=safeSystemSettingsError(error),result={phases:[{target:row.kind==='credential'?'credential':'control',state:'unknown',code,adoptedVersionId:null}]};
  return (await this.db.query("UPDATE operations_system_settings_commands_v1 SET state='unknown',result=result||$3::jsonb,updated_at=$4 WHERE endpoint=$1 AND operation_id=$2 AND state IN ('accepted','unknown') RETURNING *",
   [this.endpoint,row.operation_id,JSON.stringify(result),iso(this.now()*1000)])).rows[0]??await this.row(this.db,row.operation_id);
 }
 async reconcile(id,owner){
  if(this.reconciling.has(id))return this.reconciling.get(id);
  const task=(async()=>{
   const row=await this.row(this.db,id);if(!row||row.operator_id!==owner||!pending.has(row.state)||!this.native)return row;
   try{
    const value=await this.native.call({kind:'settings-operation',operationId:id,operatorId:owner,section:row.section});
    // Absence at the host is not proof that an accepted Node command was never
    // sent. It remains unknown and this GET never reissues the original effect.
    if(value?.state==='not-recorded')return this.unknown(row,{code:'system_settings_operation_unknown'});
    return this.acceptNative(row,value);
   }catch(error){return this.unknown(row,error);}
  })();this.reconciling.set(id,task);try{return await task;}finally{if(this.reconciling.get(id)===task)this.reconciling.delete(id);}
 }
 async command(operator,section,kind,input,options={}){
  const schema=kind==='save'?systemSettingsSaveSchema:kind==='test'?systemSettingsTestSchema:kind==='apply'?systemSettingsApplySchema:systemSettingsCredentialSchema;
  const parsed=parseSystemSettings(schema,input);
  if(kind==='credential'&&parsed.section!==section)fail('invalid_system_settings_request',400);
  if(kind==='save')parsed.configuration=systemSettingsConfiguration(section,parsed.configuration);
  if(kind!=='save'&&!this.native)fail('system_settings_native_not_configured',503);
  const prepared=await this.prepare(operator,section,kind,parsed,options);let row=prepared.row;
  if(kind!=='save'&&!prepared.replayed){
   try{await this.fresh(operator,actions[kind],options.authorize);row=await this.acceptNative(row,await this.native.call(await this.nativeIntent(row,parsed)));}
   catch(error){row=await this.unknown(row,error);}
  }else if(pending.has(row.state))row=await this.reconcile(row.operation_id,operator.operatorId);
  await this.fresh(operator,actions[kind],options.authorize);
  return{operation:operationView(row),...(kind==='save'?{version:versionView(prepared.version??await this.version(this.db,row.version_id,section))}:{}),replayed:prepared.replayed,...this.envelope()};
 }
 save(operator,section,input,options){return this.command(operator,section,'save',input,options);}
 test(operator,section,input,options){return this.command(operator,section,'test',input,options);}
 apply(operator,section,input,options){return this.command(operator,section,'apply',input,options);}
 credential(operator,input,options){return this.command(operator,input?.section,'credential',input,options);}
 async operation(operator,id){
  const operationId=parseSystemSettings(systemSettingsUuidSchema,id);await this.require(operator,actions.read);
  let row=await transaction(this.db,async db=>{await this.operationLock(db,operationId);return this.row(db,operationId);});
  if(row&&row.operator_id!==operator.operatorId)fail('system_settings_permission_denied',403);
  if(row&&pending.has(row.state))row=await this.reconcile(operationId,operator.operatorId);
  await this.require(operator,actions.read);
  return{state:row?'recorded':'not-recorded',operationId,operation:operationView(row),basis:'same-database-observation',...this.envelope()};
 }
 async history(operator,section,input={}){
  this.section(section);const query=parseSystemSettings(systemSettingsHistorySchema,input);await this.require(operator,actions.read);
  const rows=(await this.db.query(`SELECT c.*,p.display_name AS operator_display_name FROM operations_system_settings_commands_v1 c
   LEFT JOIN operations_operator_principals_v1 p ON p.endpoint=c.endpoint AND p.operator_id=c.operator_id
   WHERE c.endpoint=$1 AND c.section=$2 AND ($3::bigint IS NULL OR c.sequence<$3) ORDER BY c.sequence DESC LIMIT $4`,[this.endpoint,section,query.after??null,query.limit+1])).rows;
  await this.require(operator,actions.read);return{items:rows.slice(0,query.limit).map(row=>({...operationView(row),sequence:String(row.sequence),operatorDisplayName:row.operator_display_name??null})),
   nextAfter:rows.length>query.limit?String(rows[query.limit-1].sequence):null,...this.envelope()};
 }
 async authorizeNative(input){
  const value=parseSystemSettings(systemSettingsNativeAuthorizationSchema,input);
  if(!['settings-test','settings-apply','settings-credential-provision'].includes(value.kind))fail('system_settings_permission_denied',403);
  return transaction(this.db,async db=>{
   const row=await this.row(db,value.operationId),kind=value.kind==='settings-test'?'test':value.kind==='settings-apply'?'apply':'credential';
   if(!row||row.kind!==kind||row.section!==value.section||row.operator_id!==value.operatorId||!pending.has(row.state))fail('system_settings_permission_denied',403);
   const actor=await this.require({kind:'business-operator',operatorId:row.operator_id,role:row.operator_role,endpoint:this.endpoint},actions[kind],db);
   const head=await this.head(db,row.section);
   if(kind==='credential'){
    const expected=credentialMetadata(value);delete expected.kind;delete expected.operatorId;
    if(!isDeepStrictEqual(expected,row.input)||head.revision!==row.input.expectedRevision)fail('system_settings_permission_denied',403);
   }else{
    const version=await this.version(db,row.version_id,row.section);
    if(!version||value.versionId!==row.version_id||value.revision!==row.revision||head.revision!==row.revision||head.version_id!==row.version_id
     ||kind==='apply'&&head.pending_operation!==row.operation_id||!isDeepStrictEqual(value.configuration,version.configuration)
     ||(value.connectionId??null)!==(row.input.connectionId??null))fail('system_settings_permission_denied',403);
   }
   return{authorized:true,operationId:value.operationId,operatorId:actor.operatorId,section:row.section,kind:value.kind,endpoint:this.endpoint};
  });
 }
}
