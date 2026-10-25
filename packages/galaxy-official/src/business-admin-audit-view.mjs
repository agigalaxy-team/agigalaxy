import {z} from 'zod';
import {baseBusinessAuditAttribution,businessAuditAttributionSchema} from './business-admin-audit-attribution.mjs';

const uuid=z.uuid(),subject=z.string().regex(/^GUID[0-9A-Z]{28}$/),integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 bool=z.boolean(),time=z.iso.datetime({offset:true}),sequence=z.string().regex(/^[1-9][0-9]{0,18}$/),
 enumeration=(...values)=>z.union(values.map(value=>z.literal(value))),nullable=schema=>schema.nullable(),array=schema=>z.array(schema).max(1000),
 subjectType=enumeration('person','organization','agent','unknown'),category=enumeration('problem','suggestion','technology','arts','learning','life','galaxy','unclassified'),
 module=enumeration('account','community','chat','work','discovery','other'),kind=enumeration('post','reply','post-version','forum-post','forum-reply','forum-section','project','method','projects','methods','chat','forum','hide','restore','scan','cleanup','note','resolve','appeal','supplement','withdraw'),
 state=enumeration('pending','processing','closed','active','archived','published','withdrawn','received','reviewing','appealed','resolved','draft','queued','delivering','delivered','expired','failed','scheduled','created','retry','cancelled','canceled','completed','not-collected','available','unavailable'),
 queue=enumeration('information-watch','search-recovery','content-publication','account-notice','retention-cleanup','messaging-run','messaging-delivery'),
 policyKey=enumeration('resource-budget','community-quota','forum-quota','business-controls'),targetKey=enumeration('private-conversation-archives','data-exports','information-watches'),
 resolution=enumeration('accepted','dismissed','needs-review'),
 code=enumeration('business_admin_denied','identity_directory_unavailable','operations_authorization_unavailable','operations_notice_delivery_failed','retention_cleanup_failed');
const object=(shape)=>z.object(shape).partial().strip();
const restriction=object({scope:enumeration('community-participation'),active:bool,until:nullable(time),revision:integer});
const visibility=object({version:integer,hidden:bool,until:nullable(time),operationId:nullable(uuid)});
const fileState=enumeration('prepared','uploading','scan-pending','scanning','available','blocked','erased','expired','revoked');
const fileVersionTuple=z.tuple([fileState,integer,nullable(time),nullable(uuid),bool,nullable(time),nullable(time),nullable(time),integer]);
const version=z.union([integer,z.string().max(512).refine(value=>{try{return fileVersionTuple.safeParse(JSON.parse(value)).success;}catch{return false;}})]);
const receipt={operationId:uuid,recordedAt:time,replayed:bool};
const reading={count:nullable(integer)};
const selectionId={id:uuid,resourceId:uuid};
const page={after:nullable(z.union([uuid,subject,sequence])),limit:integer};
const change={operationId:uuid,expectedRevision:integer,expectedVersion:integer,expectedVisibilityVersion:integer};
const visibilityCommand=object({...change,kind:enumeration('hide','restore'),until:integer});
const shapes=new Map();
function register(actions,selection,result){for(const action of actions.split(' '))shapes.set(action,{selection,result});}
register('users-query',{...page,queryKind:enumeration('email','uid-or-username','all'),subjectType:nullable(subjectType),restriction:nullable(enumeration('normal','restricted')),
 view:enumeration('directory-summary'),days:enumeration(7,28)},{...reading,accountIds:array(uuid)});
register('user-read',{view:enumeration('usage-summary','type-history','association-metadata'),days:enumeration(7,28),after:nullable(z.union([subject,sequence]))},
 {...reading,view:enumeration('business-account-metadata'),subjectIds:array(subject),publicActivityState:enumeration('available','unavailable')});
register('audit-read',{...page,resourceId:nullable(uuid),page:z.number().int().positive().max(1000000),kind:enumeration('all','business','reads'),
 day:nullable(z.iso.date().refine(value=>!value.startsWith('0000-'))),hasQuery:bool},reading);
register('restriction-set restriction-release',{...change,until:time},{...receipt,accountId:uuid,before:restriction,restriction});
register('type-change',{...change,subjectType,preserveHistory:bool},{...receipt,accountId:uuid,previousType:nullable(subjectType),subjectType,revision:integer,
 basisKind:enumeration('account-owner-statement','operator-recorded-statement'),permissionsChanged:bool});
// Registered-account commands expose no identity or correction prose.
for(const registeredKind of ['password-reset','login-disable','login-restore','sessions-revoke','profile-correct','profile-preset'])register('registered-user-'+registeredKind,
 {registrationId:uuid,kind:z.literal(registeredKind)},
 {kind:z.literal(registeredKind),state:enumeration('accepted','submitted','completed','partial','failed','unknown'),profileRevision:nullable(integer)});
// Management identity writes never expose login/profile prose or credentials.
const managementAccountPhase=z.object({kind:enumeration('native-account','native-admission','local-principal','business-assignments','native-sessions','portal-sessions','email-verification'),
 state:enumeration('accepted','confirmed','submitted','failed','unknown')}).strip();
for(const managementKind of ['create','profile-update','login-disable','login-restore','password-reset','sessions-revoke','delete','admission-change','email-change'])register('management-account-'+managementKind,
 {targetOperatorId:managementKind==='create'?nullable(z.string().regex(/^[0-9a-f]{64}$/)):z.string().regex(/^[0-9a-f]{64}$/),kind:z.literal(managementKind)},
 {kind:z.literal(managementKind),state:enumeration('accepted','completed','partial','failed','unknown'),phases:z.array(managementAccountPhase).max(7),revision:nullable(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))});
// Stable AI-account administration exposes closed metadata, never profile prose.
for(const aiWorkKind of ['profile-save','state-save','assignment-save'])register('ai-work-'+aiWorkKind,
 {id:uuid,domain:enumeration('overview','governance','messaging','discovery','maintenance')},
 {kind:z.literal(aiWorkKind),version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),enabled:bool,
  ...(aiWorkKind==='assignment-save'?{assignmentId:uuid,assignmentVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),assignmentEnabled:bool}:{})});
register('ai-delegation-save ai-role-create ai-role-update ai-role-assignment-save',
 {delegationId:uuid,delegationVersion:integer,sourceAiAccountId:uuid,roleId:nullable(uuid),aiAccountId:nullable(uuid)},
 {enabled:bool,version:integer,permissionCount:integer,targetCount:integer});
register('autonomy-config autonomy-enable autonomy-control autonomy-run autonomy-settings autonomy-strategy-task autonomy-decision',
 {id:nullable(uuid)}, {kind:enumeration('config','enable','control','run','settings','strategy-task','decision'),revision:nullable(integer)});
register('system-settings-save system-settings-test system-settings-apply system-settings-credential-provision',
 {section:enumeration('general','mail','service-connections'),kind:enumeration('save','test','apply','credential'),versionId:nullable(uuid),revision:integer},
 {state:enumeration('accepted','completed','partial','failed','unknown'),versionId:nullable(uuid),revision:integer});
register('chat-reports-query',{...page,roomId:nullable(uuid),state:nullable(state)}, {...reading,reportIds:array(uuid)});
register('chat-report-read',{reportId:uuid},{materials:integer,canModerate:bool});
register('chat-report-event',{reportId:uuid,roomId:uuid,messageId:uuid,sourceRevision:integer,
 kind:enumeration('review','pause','resume','resolve','message-hide','message-restore','message-keep')},
 {version:integer,state,revision:integer,hidden:bool,replayed:bool});
register('chat-report-attachment',{reportId:uuid,attachmentId:uuid},{bytes:integer});
register('job-cancel job-retry',{queue,jobId:uuid,generation:integer},{state,previousState:state,changed:bool});
register('search-retry',{jobId:uuid,generation:integer},{state,changed:bool});
register('operations-summary-read',{},reading);
register('community-posts-query',{...page},reading);
register('community-post-read',selectionId,reading);
register('community-sections-query',{...page,state:nullable(state),category:nullable(category)},reading);
register('community-section-read community-report-read',selectionId,reading);
register('community-section-classify',{...selectionId,...change,category},{...receipt,sectionId:uuid,version:integer,category,actorKind:enumeration('business-operator','operations-ai-service'),operatorId:z.string().min(1).max(1024)});
register('community-section-visibility',{...selectionId,...change,kind:enumeration('hide','restore'),until:integer},
 {...receipt,target:object({kind,id:uuid}),sourceVersion:integer,visibility,sourcePermissionChanged:bool});
register('community-reports-query',{...page,state:nullable(state)},reading);
register('community-report-resolve',{...selectionId,...change,resolution,restrictionAction:enumeration('keep','release','hide'),hideUntil:integer},
 {...receipt,reportId:uuid,version:integer,state,resolution,restrictionAction:enumeration('keep','release','hide'),restrictionEventId:nullable(uuid),effectUntil:nullable(time),actorKind:enumeration('business-operator','operations-ai-service'),operatorId:z.string().min(1).max(1024)});
register('resources-query',{...page,kind,state:nullable(state)},reading);
register('resource-read',{...selectionId,kind},reading);
register('resource-visibility',{...selectionId,kind,operationId:uuid,command:visibilityCommand},
 {...receipt,target:object({kind,id:uuid}),sourceVersion:integer,visibility,sourcePermissionChanged:bool});
register('files-query',{...page,after:nullable(z.string().regex(/^(chat|forum):[0-9a-f-]{36}$/)),kind:nullable(enumeration('chat','forum')),state:nullable(fileState),processing:nullable(enumeration('scan','cleanup')),issue:nullable(enumeration('any','scan','cleanup')),view:enumeration('summary','list')},reading);
register('file-read',{...selectionId,kind},reading);
register('file-access-read',{view:enumeration('operation'),id:uuid},reading);
register('file-access-stop file-access-restore',{kind:enumeration('chat','forum'),id:uuid,action:enumeration('stop','restore'),revision:integer,until:nullable(integer)},
 {...receipt,kind:enumeration('chat','forum'),id:uuid,action:enumeration('stop','restore'),revision:integer,stopped:bool,until:nullable(time)});
register('file-cleanup-read',{...page,view:enumeration('candidates','plans','plan','operation'),kind:enumeration('chat','forum'),id:uuid},reading);
register('file-cleanup-create',{operationId:uuid},{planId:uuid,kind:enumeration('create'),state:enumeration('awaiting-approval')});
register('file-cleanup-approve file-cleanup-cancel',{id:uuid,operationId:uuid,command:object({operationId:uuid,expectedRevision:integer})},
 {planId:uuid,kind:enumeration('approve','cancel'),state:enumeration('queued','cancelled')});
register('file-retry',{...selectionId,kind,operationId:uuid,command:object({operationId:uuid,kind:enumeration('scan','cleanup'),expectedVersion:version})},
 {...receipt,state,processingComplete:bool,file:object({id:uuid,kind,state,version,size:integer,ownerAccountId:nullable(uuid),originSubjectId:nullable(subject),
  createdAt:time,uploadedAt:nullable(time),expiresAt:nullable(time),scanAttempts:integer,cleanupPending:bool,retriesRemaining:integer,contentAvailable:bool})});
register('rule-save',{key:policyKey,expectedVersion:integer},{version:integer});
register('recommendations.configure',{kind:enumeration('policy','theme'),version:integer},{version:integer});
for(const action of ['search-quality.configure','search-quality.publish','search-quality.restore'])register(action,{version:integer},{version:integer});
for(const action of ['models.configure','models.apply'])register(action,{version:nullable(integer),kind:enumeration('draft','apply','credential-provision'),modelRecordId:nullable(uuid)},{version:nullable(integer),count:nullable(integer)});
for(const action of ['strategies.configure','strategies.publish','strategies.control','strategies.run','strategies.ordinary.configure','strategies.ordinary.publish'])register(action,{versionId:nullable(uuid),strategyId:nullable(uuid),runId:nullable(uuid),revision:integer},{version:integer,revision:integer,count:integer});
for(const action of ['maintenance-query','maintenance-logs-query','maintenance-backup-create','maintenance-backup-verify','maintenance-restore-plan','maintenance-restore-approve','maintenance-restore-execute','maintenance-restore-cancel'])register(action,{planId:nullable(uuid),revision:nullable(integer),kind:nullable(enumeration('overview','logs','backups','point','backup-create','backup-verify','restore-plan','restore-approve','restore-execute','restore-cancel'))},{state:nullable(enumeration('blocked','awaiting-approval','approved','preparing','restoring','validating','ready-to-open','opening','completed','failed','cancelled')),count:nullable(integer)});
const messagingState=enumeration('draft','active','paused','stopped','running','blocked','completed','cancelled','expired','queued','delivering','delivered','withdrawn','submitted','failed','unknown','skipped','pending','submitting','not-configured','ineligible');
const messagingSelection={planId:uuid,runId:uuid,recipientId:uuid,planVersion:integer,revision:integer,channel:enumeration('announcement','inapp','email'),
 kind:enumeration('create','save','activate','pause','resume','stop','withdraw','retry','run','inapp-delivery','email-submission')};
const messagingCounts=object(Object.fromEntries(['pending','submitting','submitted','delivered','skipped','failed','unknown','blocked','announcement','inapp','email'].map(key=>[key,integer])));
register('notice-create notice-save notice-publish notice-withdraw',{noticeId:uuid,expectedVersion:integer,audience:enumeration('all-accounts','accounts'),...messagingSelection},
 {state:messagingState,version:integer,revision:integer,audienceCount:integer,counts:messagingCounts});
register('notice-delivery',{noticeId:uuid,execution:enumeration('worker'),...messagingSelection},{state:messagingState,version:integer,revision:integer,audienceCount:integer,deliveredCount:integer,code,
 counts:messagingCounts,submission:enumeration('submitted','not-configured','ineligible','failed','unknown'),retryable:bool,
 errorCode:enumeration('smtp_not_configured','smtp_credential_unavailable','smtp_recipient_ineligible','smtp_submission_unknown','operations_permission_denied','business_admin_denied','operations_messaging_not_active','operations_messaging_recipient_ineligible')});
register('retention-request retention-complete retention-failed',{runId:uuid,target:targetKey,execution:enumeration('worker')},
 {state,maximumRowsPerRun:integer,maximumRootsPerRun:nullable(integer),code,
 counts:object({expired:integer,removed:integer,deleted:integer,removedVersions:integer,removedHeads:integer,removedOperations:integer,removedArchives:integer,removedChunks:integer})});
register('feedback-query',{...page,hasQuery:bool,module:nullable(module),days:z.union([enumeration(7,28),z.literal('all')]),category:nullable(category),state:nullable(state)},reading);
register('feedback-read',{...selectionId,historyAfter:nullable(sequence),attachmentId:uuid},reading);
register('feedback-update',{...selectionId,...change,category:nullable(category),module,state}, {...receipt,feedbackId:uuid,revision:integer});
const contentKind=enumeration('post','reply'),contentCursor=z.string().regex(/^(post|reply):[0-9a-f-]{36}$/i),
 batchTarget=object({kind:contentKind,id:uuid,expectedVersion:integer,expectedRevision:integer}),
 batchResult=object({kind:contentKind,id:uuid,status:enumeration('applied','rejected'),
  code:nullable(enumeration('not_found','operations_source_changed','operations_visibility_changed','operations_source_unavailable','operations_hide_expiry')),visibility});
register('community-content-query',{after:contentCursor,limit:integer,hasQuery:bool,kind:contentKind,topic:category,
 visibility:enumeration('visible','hidden','unavailable'),pinned:bool,featured:bool,days:z.union([enumeration(7,28),z.literal('all')])},reading);
register('community-content-read',{...selectionId,kind:contentKind,attachmentId:uuid},reading);
register('community-content-visibility',{...selectionId,...change,targetKind:contentKind,kind:enumeration('hide','restore'),until:integer},
 {...receipt,kind:contentKind,id:uuid,visibility});
register('community-content-curation',{...selectionId,...change,kind:contentKind,topic:nullable(category),pinned:bool,featured:bool,tagIds:array(uuid)},
 {...receipt,kind:contentKind,id:uuid,revision:integer,sourceVersion:integer});
register('community-content-batch-preview',{kind:enumeration('hide','restore'),count:integer},reading);
register('community-content-batch-visibility',{operationId:uuid,kind:enumeration('hide','restore'),until:integer,items:array(batchTarget)},
 {...receipt,items:array(batchResult),counts:object({applied:integer,rejected:integer})});
register('community-tags-query',{},reading);
register('community-tag-create community-tag-update',{...selectionId,operationId:uuid,expectedVersion:nullable(integer),enabled:nullable(bool)},
 {...receipt,tag:object({id:uuid,version:integer,enabled:bool,createdAt:time,updatedAt:time})});
register('permission-role-save permission-automation-save',
 {resourceId:uuid,expectedVersion:integer,changedFields:array(enumeration('name','description','enabled','permissions','operatorId','roleId','executorKind','mode','resourceIds','resourceScope','aiAccountId'))},
 {version:integer,enabled:bool,permissionCount:integer});
register('permission-assignment-save',
 {resourceId:uuid,expectedVersion:integer,changedFields:array(enumeration('operatorId','roleId','enabled')),targetOperatorId:z.string().regex(/^[0-9a-f]{64}$/),roleId:uuid},
 {version:integer,enabled:bool,permissionCount:integer});
const smtpCode=enumeration('smtp_not_configured','smtp_credential_unavailable','smtp_credential_binding_mismatch','smtp_configuration_changed','smtp_authorization_unavailable','smtp_authorization_changed',
 'smtp_recipient_ineligible','smtp_message_invalid','smtp_sender_invalid','smtp_temporary_rejection','smtp_permanent_rejection','smtp_submission_unknown','smtp_authentication_failed','smtp_tls_failed',
 'smtp_connection_failed','smtp_timeout','smtp_dns_failed','smtp_protocol_failed','smtp_transport_failed','smtp_recipient_rejected','smtp_concurrency_limited','smtp_rate_limited',
 'operations_permission_denied','business_admin_denied','identity_directory_unavailable','operations_messaging_not_active','operations_messaging_recipient_ineligible');
register('smtp-query',page,reading);
register('smtp-config-save',{expectedVersion:integer,changedFields:array(enumeration('enabled','host','port','tls','credentialRef','connectionTimeoutMs','greetingTimeoutMs','socketTimeoutMs','maxConnections','rateLimit','rateWindowSeconds','dkimSelector'))},{version:integer,enabled:bool});
register('smtp-connection-test smtp-delivery-test',{testId:uuid,expectedVersion:integer},{state:enumeration('testing','connected','submitted','not-configured','ineligible','failed','unknown'),code:nullable(smtpCode),version:integer});
register('smtp-dns-check',{}, {state:enumeration('checked'),version:integer});

// The search service uses this same closed projection catalog. Historical
// unrecognized action strings cannot become a new keyword or facet channel.
export const businessAuditActionCodes=Object.freeze([...shapes.keys()]);

function project(value,shape){
 if(!value||typeof value!=='object'||Array.isArray(value))return {};
 const result={};for(const[key,schema]of Object.entries(shape)){if(!Object.hasOwn(value,key))continue;
  const parsed=schema.safeParse(value[key]);if(parsed.success)result[key]=parsed.data;
 }return result;
}
// A closed read model, not a mutation of historical audit or stable-command
// input. Unknown actions/fields never gain a prose channel via metadataOnly.
export function businessAuditMetadata(row){
 const shape=shapes.get(row.action);
 const executor=row.actor_kind==='operations-executor'&&uuid.safeParse(row.execution_id).success&&uuid.safeParse(row.grant_id).success;
 const ai=row.actor_kind==='operations-ai-service',human=row.actor_kind==='business-operator',actorKind=ai?'operations-ai-service':executor?'operations-executor':human?'business-operator':'unknown',
  parsed=businessAuditAttributionSchema.safeParse(row.audit_attribution),attribution=parsed.success?parsed.data:baseBusinessAuditAttribution(row),
  operatorDisplayName=human&&typeof row.operator_display_name==='string'?row.operator_display_name.trim()||null:null;
 return {id:row.id,sequence:String(row.sequence),operatorId:row.operator_id,operatorDisplayName,operatorRole:human?row.operator_role:null,action:row.action,
  actorKind,executionId:executor?row.execution_id:null,grantId:(executor||ai)&&uuid.safeParse(row.grant_id).success?row.grant_id:null,attribution,
  accountId:row.account_id,operationId:row.operation_id,httpRequestId:row.http_request_id,
  selection:shape?project(row.selection,shape.selection):{},result:shape?project(row.result,shape.result):{},
  createdAt:new Date(row.created_at).toISOString()};
}
