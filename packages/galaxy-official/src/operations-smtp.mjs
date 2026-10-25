import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {resolveTxt as systemResolveTxt} from 'node:dns/promises';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {smtpParse,smtpSaveSchema,smtpConnectionTestSchema,smtpDeliveryTestSchema,smtpPageSchema,emptySmtpConfiguration,smtpSenderKeys} from './shared/operations-smtp-schema.mjs';
import {createSmtpCredentialResolver} from './infrastructure/operations-smtp-credentials.mjs';
import {createOperationsSmtpTransport} from './operations-smtp-transport.mjs';
import {OFFICIAL_MAIL_IDENTITIES} from '../../galaxy-mail/src/identities.mjs';
import {smtpCommandResult} from './operations/command-receipts.mjs';

const at=value=>value?new Date(value).toISOString():null;
const complete=x=>Object.entries(x).every(([key,value])=>['dkimSelector','enabled'].includes(key)||value!==null);
const stamp=service=>new Date(service.now()*1000).toISOString();
const availableCodes=new Set(['smtp_credential_binding_mismatch','smtp_configuration_changed','operations_permission_denied','business_admin_denied','identity_directory_unavailable','operations_messaging_not_active','operations_messaging_recipient_ineligible','operations_messaging_execution_interrupted']);
const errorCode=error=>availableCodes.has(error?.code)?error.code:'smtp_authorization_changed';

export class OperationsSmtpService{
 constructor({db,endpoint,businessAdmin,directory=null,credentialResolver=createSmtpCredentialResolver(),transport=createOperationsSmtpTransport(),resolveTxt=systemResolveTxt,now=()=>Math.floor(Date.now()/1000)}){
  Object.assign(this,{db,endpoint,businessAdmin,directory,credentialResolver,transport,resolveTxt,now});
  this.active=0;this.rateWindow={version:null,start:0,count:0};
 }
 async current(db=this.db){
  const row=(await db.query('SELECT * FROM operations_smtp_settings_v1 WHERE endpoint=$1',[this.endpoint])).rows[0];
  return row?{version:row.version,configuration:row.configuration,updatedAt:at(row.updated_at),updatedBy:row.updated_by}:{version:0,configuration:emptySmtpConfiguration(),updatedAt:null,updatedBy:null};
 }
 async actor(operator,action,{authorize=null,db=this.db,request=false}={}){
  if(request){
   if(typeof authorize!=='function')throw new ServiceError('operations_authorization_unavailable',503);
   const fresh=await authorize();
   if(fresh?.operatorId!==operator?.operatorId||fresh.endpoint!==this.endpoint)throw new ServiceError('business_admin_denied',403);
   operator=fresh;
  }
  return this.businessAdmin.authorizeAction(operator,action,{db});
 }
 async status(current=null){
  current??=await this.current();let credentialAvailable=false;
  const x=current.configuration;
  if(complete(x))try{credentialAvailable=!!this.credentialResolver.resolve({ref:x.credentialRef,host:x.host,port:x.port,tls:x.tls});}catch{}
  return {state:current.version&&complete(x)&&credentialAvailable?'configured':'not-configured',enabled:x.enabled,configVersion:current.version?String(current.version):null,receipts:'not-connected',credentialAvailable};
 }
 async get(operator){
  const actor=await this.actor(operator,'smtp.read'),current=await this.current();
  return {...current,status:await this.status(current),credentials:this.credentialResolver.list(),
   identities:Object.entries(OFFICIAL_MAIL_IDENTITIES).map(([key,value])=>({key,...value,receiving:value.address==='team@agigalaxy.org'?'team-only':'send-only'})),
   capabilities:{...Object.fromEntries(['configure','test.connection','test.delivery'].map(key=>[key,actor.businessAuthorization.permissions.includes('smtp.'+key)])),canChooseRecipient:actor.businessAuthorization.permissions.includes('accounts.read')},
   limitsScope:'per-worker-process',checkedAt:this.now()};
 }
 commandResult(operator,operationId){
  return smtpCommandResult({db:this.db,endpoint:this.endpoint,operator,authorize:actor=>this.actor(actor,'smtp.read'),now:this.now},operationId);
 }
 async save(operator,input,{authorize}={}){
  const data=smtpParse(smtpSaveSchema,input);
  await this.actor(operator,'smtp.configure',{authorize,request:true});
  return transaction(this.db,async db=>{
   const actor=await this.actor(operator,'smtp.configure',{db});
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912422))',[this.endpoint]);
   const prior=(await db.query('SELECT * FROM operations_smtp_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,data.operationId])).rows[0];
   if(prior){if(prior.operator_id!==actor.operatorId||!isDeepStrictEqual(prior.input,data))throw new ServiceError('operations_command_changed',409);return {...prior.result,replayed:true};}
   const old=await this.current(db),config=data.configuration;
   if(old.version!==data.expectedVersion)throw new ServiceError('smtp_configuration_changed',409);
   if(config.credentialRef){
    const credentials=this.credentialResolver.resolve({ref:config.credentialRef,host:config.host,port:config.port,tls:config.tls});
    if(!credentials)throw new ServiceError('smtp_credential_unavailable',409);
   }
   if(config.enabled&&!complete(config))throw new ServiceError('smtp_configuration_incomplete',409);
   const changed=Object.keys(config).filter(key=>!isDeepStrictEqual(old.configuration[key],config[key])),version=old.version+1,time=stamp(this);
   await db.query(`INSERT INTO operations_smtp_settings_v1(endpoint,version,configuration,updated_by,updated_at) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(endpoint) DO UPDATE SET version=EXCLUDED.version,configuration=EXCLUDED.configuration,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`,[this.endpoint,version,JSON.stringify(config),actor.operatorId,time]);
   await db.query('INSERT INTO operations_smtp_events_v1(id,endpoint,operator_id,version,changed_fields,created_at) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),this.endpoint,actor.operatorId,version,JSON.stringify(changed),time]);
   await this.businessAdmin.recordWithin(db,actor,'smtp-config-save',{operationId:data.operationId,selection:{expectedVersion:data.expectedVersion,changedFields:changed},result:{version,enabled:config.enabled}});
   const result={version,configuration:config,updatedAt:time,updatedBy:actor.operatorId};
   await db.query('INSERT INTO operations_smtp_commands_v1(endpoint,operation_id,operator_id,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6)',[this.endpoint,data.operationId,actor.operatorId,JSON.stringify(data),JSON.stringify(result),time]);
   return {...result,replayed:false};
  });
 }
 async recipient(accountId){
  if(!this.directory)return null;
  const row=(await this.db.query('SELECT issuer,external_subject FROM community_accounts WHERE endpoint=$1 AND id=$2',[this.endpoint,accountId])).rows[0];
  if(!row)return null;
  let identity;try{identity=await this.directory.get({issuer:row.issuer,externalSubject:row.external_subject});}catch{throw new ServiceError('identity_directory_unavailable',503);}
  if(!identity||identity.issuer!==row.issuer||identity.externalSubject!==row.external_subject||identity.enabled!==true||identity.emailVerified!==true
   ||typeof identity.email!=='string'||identity.email.length>320||!/^[^\s@<>\r\n]+@[^\s@<>\r\n]+$/.test(identity.email))return null;
  return identity.email;
 }
 async withPermit(current,operation){
  const config=current.configuration;
  if(this.active>=config.maxConnections)return {submission:'failed',code:'smtp_concurrency_limited',retryable:true,notSubmitted:true,retryAt:new Date((this.now()+30)*1000).toISOString()};
  const window=this.rateWindow;
  if(window.version!==current.version||this.now()-window.start>=config.rateWindowSeconds){window.version=current.version;window.start=this.now();window.count=0;}
  if(window.count>=config.rateLimit)return {submission:'failed',code:'smtp_rate_limited',retryable:true,notSubmitted:true,retryAt:new Date((window.start+config.rateWindowSeconds)*1000).toISOString()};
  this.active++;window.count++;
  try{return await operation();}finally{this.active--;}
 }
 async submit({accountId,messageId,senderKey,subject,title,paragraphs,note='',language='zh-CN',authorize,test=false}){
  const current=await this.current(),x=current.configuration,configVersion=current.version?String(current.version):null;
  if(typeof authorize!=='function')return {submission:'failed',code:'smtp_authorization_unavailable',retryable:false,configVersion};
  if(!current.version||!complete(x)||!x.enabled&&!test)return {submission:'not-configured',code:'smtp_not_configured',retryable:false,configVersion};
  if(!smtpSenderKeys.includes(senderKey))return {submission:'failed',code:'smtp_sender_invalid',retryable:false,configVersion};
  let credentials,to;
  try{
   await authorize();
   credentials=this.credentialResolver.resolve({ref:x.credentialRef,host:x.host,port:x.port,tls:x.tls,purpose:senderKey});
   if(!credentials)return {submission:'not-configured',code:'smtp_credential_unavailable',retryable:false,configVersion};
   to=await this.recipient(accountId);
   if(!to)return {submission:'ineligible',code:'smtp_recipient_ineligible',retryable:false,configVersion};
  }catch(error){return {submission:'failed',code:errorCode(error),retryable:error?.code!=='smtp_credential_binding_mismatch',configVersion};}
  const fresh=async()=>{
   await authorize();
   const latest=await this.current();
   if(latest.version!==current.version||!test&&!latest.configuration.enabled)throw new ServiceError('smtp_configuration_changed',409);
   if(await this.recipient(accountId)!==to)throw new ServiceError('operations_messaging_recipient_ineligible',409);
  };
  const result=await this.withPermit(current,()=>this.transport.submit(x,{credentials,authorize:fresh,to,senderKey,subject,title,paragraphs,note,language,messageId}));
  return {...result,configVersion};
 }
 testView(row){
  const stale=row.state==='testing'&&this.now()*1000-Date.parse(row.started_at)>900000;
  return {id:row.id,sequence:String(row.sequence),kind:row.kind,configurationVersion:row.configuration_version,accountId:row.account_id,senderKey:row.sender_key,
   state:stale?'unknown':row.state,code:stale?'smtp_submission_unknown':row.code,startedAt:at(row.started_at),finishedAt:at(row.finished_at),
   delivery:'unknown',receiptSource:'not-connected'};
 }
 async test(operator,input,{kind,authorize}={}){
  const data=smtpParse(kind==='delivery'?smtpDeliveryTestSchema:smtpConnectionTestSchema,input),action='smtp.test.'+kind;
  await this.actor(operator,action,{authorize,request:true});
  const claim=await transaction(this.db,async db=>{
   const actor=await this.actor(operator,action,{db});
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912423))',[this.endpoint+':'+data.operationId]);
   const prior=(await db.query('SELECT * FROM operations_smtp_tests_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,data.operationId])).rows[0];
   if(prior){if(prior.operator_id!==actor.operatorId||prior.kind!==kind||!isDeepStrictEqual(prior.input,data))throw new ServiceError('operations_command_changed',409);return {prior};}
   const config=await this.current(db);if(config.version!==data.expectedVersion)throw new ServiceError('smtp_configuration_changed',409);
   const row=(await db.query(`INSERT INTO operations_smtp_tests_v1(id,endpoint,operator_id,kind,configuration_version,account_id,sender_key,input,state,started_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'testing',$9) RETURNING *`,[data.operationId,this.endpoint,actor.operatorId,kind,config.version,data.accountId??null,data.senderKey??null,JSON.stringify(data),stamp(this)])).rows[0];
   return {row,config,actor};
  });
  if(claim.prior)return {test:this.testView(claim.prior),replayed:true};
  const fresh=async()=>{await this.actor(operator,action,{authorize,request:true});if((await this.current()).version!==data.expectedVersion)throw new ServiceError('smtp_configuration_changed',409);};
  let result;
  if(kind==='delivery')result=await this.submit({accountId:data.accountId,messageId:'<smtp-test-'+data.operationId+'@agigalaxy.org>',senderKey:data.senderKey,subject:'银河 SMTP 投递测试',title:'发信服务投递测试',paragraphs:['这是一封由获准管理操作发起的发信服务测试邮件。'],authorize:fresh,test:true});
  else{
   const x=claim.config.configuration;
   try{
    const credentials=complete(x)?this.credentialResolver.resolve({ref:x.credentialRef,host:x.host,port:x.port,tls:x.tls}):null;
    result=credentials?await this.withPermit(claim.config,()=>this.transport.verify(x,{credentials,authorize:fresh})):{submission:'not-configured',code:'smtp_not_configured',retryable:false};
   }catch(error){result={submission:'failed',code:errorCode(error),retryable:false};}
  }
  // The durable claim precedes SMTP. A process crash leaves testing/unknown,
  // and replaying this operation never resends a message.
  const row=await transaction(this.db,async db=>{
   const saved=(await db.query('UPDATE operations_smtp_tests_v1 SET state=$3,code=$4,finished_at=$5 WHERE endpoint=$1 AND id=$2 RETURNING *',[this.endpoint,data.operationId,result.submission,result.code,stamp(this)])).rows[0];
   await this.businessAdmin.recordWithin(db,claim.actor,kind==='delivery'?'smtp-delivery-test':'smtp-connection-test',{operationId:data.operationId,accountId:data.accountId??null,
    selection:{testId:data.operationId,expectedVersion:data.expectedVersion},result:{state:saved.state,code:saved.code,version:data.expectedVersion}});
   return saved;
  });
  return {test:this.testView(row),replayed:false};
 }
 async tests(operator,input={}){
  await this.actor(operator,'smtp.read');const page=smtpParse(smtpPageSchema,input);
  const rows=(await this.db.query('SELECT * FROM operations_smtp_tests_v1 WHERE endpoint=$1 AND ($2::bigint IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT $3',[this.endpoint,page.after??null,page.limit+1])).rows;
  return {items:rows.slice(0,page.limit).map(row=>this.testView(row)),nextAfter:rows.length>page.limit?String(rows[page.limit-1].sequence):null,checkedAt:this.now()};
 }
 async history(operator,input={}){
  await this.actor(operator,'smtp.read');const page=smtpParse(smtpPageSchema,input);
  const rows=(await this.db.query('SELECT id,sequence,operator_id,version,changed_fields,created_at FROM operations_smtp_events_v1 WHERE endpoint=$1 AND ($2::bigint IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT $3',[this.endpoint,page.after??null,page.limit+1])).rows;
  return {items:rows.slice(0,page.limit).map(row=>({id:row.id,sequence:String(row.sequence),operatorId:row.operator_id,version:row.version,changedFields:row.changed_fields,createdAt:at(row.created_at)})),nextAfter:rows.length>page.limit?String(rows[page.limit-1].sequence):null,checkedAt:this.now()};
 }
 async queue(operator,input={}){
  await this.actor(operator,'smtp.read');const page=smtpParse(smtpPageSchema,input);
  const rows=(await this.db.query(`SELECT r.id,r.sequence,r.account_id,a.uid,r.run_id,u.plan_id,r.state,r.attempt_count,r.error_code,r.submitted_at,r.completed_at,r.updated_at
   FROM operations_messaging_recipients_v1 r JOIN operations_messaging_runs_v1 u ON u.id=r.run_id LEFT JOIN community_accounts a ON a.id=r.account_id
   WHERE u.endpoint=$1 AND r.channel='email' AND ($2::bigint IS NULL OR r.sequence<$2) ORDER BY r.sequence DESC LIMIT $3`,[this.endpoint,page.after??null,page.limit+1])).rows;
  const counts=(await this.db.query(`SELECT r.state,count(*)::integer AS count FROM operations_messaging_recipients_v1 r JOIN operations_messaging_runs_v1 u ON u.id=r.run_id WHERE u.endpoint=$1 AND r.channel='email' GROUP BY r.state`,[this.endpoint])).rows;
  return {items:rows.slice(0,page.limit).map(row=>({id:row.id,sequence:String(row.sequence),accountId:row.account_id,uid:row.uid??null,runId:row.run_id,planId:row.plan_id,state:row.state,attemptCount:row.attempt_count,code:row.error_code,submittedAt:at(row.submitted_at),completedAt:at(row.completed_at),updatedAt:at(row.updated_at)})),
   nextAfter:rows.length>page.limit?String(rows[page.limit-1].sequence):null,counts:Object.fromEntries(counts.map(x=>[x.state,x.count])),scope:'configured-business-database',checkedAt:this.now()};
 }
 async bounces(operator){await this.actor(operator,'smtp.read');return {state:'not-connected',items:[],count:null,source:null,checkedAt:this.now()};}
 async domains(operator){
  const actor=await this.actor(operator,'smtp.read'),config=await this.current();
  const read=async(name,prefix)=>{
   try{const records=(await this.resolveTxt(name)).map(parts=>parts.join('')).filter(value=>value.startsWith(prefix)).slice(0,10).map(value=>value.slice(0,2048));return {state:records.length?'record-found':'not-found',records};}
   catch(error){return {state:['ENODATA','ENOTFOUND'].includes(error?.code)?'not-found':'unavailable',records:[]};}
  };
  const domain='agigalaxy.org',selector=config.configuration.dkimSelector;
  const result={domain,spf:await read(domain,'v=spf1'),dmarc:await read('_dmarc.'+domain,'v=DMARC1'),dkim:selector?{selector,...await read(selector+'._domainkey.'+domain,'v=DKIM1')}:{selector:null,state:'selector-not-configured',records:[]},alignment:'unknown',checkedAt:this.now()};
  await this.businessAdmin.recordWithin(this.db,actor,'smtp-dns-check',{result:{state:'checked',version:config.version}});return result;
 }
}
