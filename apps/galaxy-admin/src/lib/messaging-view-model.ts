import type {MessageCommandEffects,MessageOperationKind,MessageOriginalReceipt,MessageAudience,MessageDraft,MessagePlan,MessageRecipient,MessageRecurrence,MessageSchedule,MessagingConfig,MessagingLocation} from "../components/messaging/messaging-types";
import type {AccountPickerKnownAccount} from '../components/AccountPicker';

export const messageChannels={announcement:'公告',inapp:'站内信',email:'系统邮件'} as const;
export const messagePurposes={maintenance:'维护通知','service-update':'服务更新','community-update':'社区通知'} as const;
export const messageSubjectTypes={person:'个人',agent:'Agent',organization:'组织账户'} as const;
export const messagePlanStates={draft:'草稿',active:'已启用',paused:'已暂停',stopped:'已停止',expired:'已到期'} as const;
export const messageRunStates={running:'执行中',paused:'已暂停',blocked:'等待处理',completed:'本次执行结束',cancelled:'已停止',expired:'已到期'} as const;
export const messageRecipientStates={pending:'等待发送',submitting:'正在提交',submitted:'已提交邮件',delivered:'已投递站内信',skipped:'已跳过',failed:'发送失败',unknown:'结果未确认',blocked:'等待处理'} as const;
export const messageHistoryKinds={create:'建立计划',save:'保存新版本',activate:'启用计划',pause:'暂停后续',resume:'恢复计划',stop:'停止后续',withdraw:'停止并撤回'} as const;
export function messageHistoryOperator(item:{operatorDisplayName?:string|null;actorKind?:string}){return typeof item.operatorDisplayName==='string'&&item.operatorDisplayName.trim()?item.operatorDisplayName.trim():item.actorKind==='operations-ai-service'?'AI 工作账户':'管理账户';}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sequence=(value:string)=>/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n?value:'';
const trail=(value:string)=>value.length<=8192?value.split(',').filter(item=>item==='start'||sequence(item)).slice(-60):[];
const pick=<T extends string>(value:string,allowed:readonly T[],fallback:T):T=>allowed.includes(value as T)?value as T:fallback;
export function messagingLocation(input:Record<string,string>):MessagingLocation{
 const run=uuid.test(input.run??'')?input.run:'',id=uuid.test(input.id??'')?input.id:'';
 return {id,run,creating:input.new==='1'&&!id&&!run,state:pick(input.state??'',['','draft','active','paused','stopped'] as const,''),channel:pick(input.channel??'',['announcement','inapp','email'] as const,'inapp'),view:pick(input.view??'',['runs','recipients','history'] as const,run?'recipients':'runs'),after:sequence(input.after??''),trail:trail(input.trail??''),runAfter:sequence(input.runAfter??''),runTrail:trail(input.runTrail??''),historyAfter:sequence(input.historyAfter??''),historyTrail:trail(input.historyTrail??''),recipientAfter:sequence(input.recipientAfter??''),recipientTrail:trail(input.recipientTrail??''),recipientChannel:pick(input.recipientChannel??'',['','inapp','email'] as const,''),recipientState:pick(input.recipientState??'',['','pending','submitting','submitted','delivered','skipped','failed','unknown','blocked'] as const,'')};
}
export function messagingHref(location:MessagingLocation,patch:Partial<MessagingLocation>={}){
 const value={...location,...patch},q=new URLSearchParams();
 if(value.id)q.set('id',value.id);if(value.run)q.set('run',value.run);if(value.creating)q.set('new','1');
 for(const key of ['state','channel','view','after','runAfter','historyAfter','recipientAfter','recipientChannel','recipientState'] as const)if(value[key])q.set(key,value[key]);
 for(const key of ['trail','runTrail','historyTrail','recipientTrail'] as const)if(value[key].length)q.set(key,value[key].join(','));
 return '/admin/operations/messaging'+(q.size?'?'+q:'');
}
export const messagingSearchKeys=['id','run','new','state','channel','view','after','trail','runAfter','runTrail','historyAfter','historyTrail','recipientAfter','recipientTrail','recipientChannel','recipientState'] as const;
export function messagePlansPath(location:MessagingLocation){return '/v1/operations/messaging/plans?'+new URLSearchParams({limit:'25',...(location.state?{state:location.state}:{}),...(location.after?{after:location.after}:{})});}
export function messageRunsPath(id:string,after:string){return '/v1/operations/messaging/runs?'+new URLSearchParams({limit:'25',planId:id,...(after?{after}:{})});}
export function messageRecipientsPath(id:string,location:MessagingLocation){return '/v1/operations/messaging/runs/'+id+'/recipients?'+new URLSearchParams({limit:'25',...(location.recipientAfter?{after:location.recipientAfter}:{}),...(location.recipientChannel?{channel:location.recipientChannel}:{}),...(location.recipientState?{state:location.recipientState}:{})});}
export function messageAudienceLabel(audience:MessageAudience){
 if(audience.kind==='all-accounts')return '当前业务服务的全部账户';
 if(audience.kind==='attributes')return audience.subjectTypes.map(type=>messageSubjectTypes[type]).join('、')+' · 按账户类型';
 return '指定 '+audience.accountIds.length+' 个账户';
}
export function messageAudienceAccounts(value:unknown,readExpiresAt:number,now=Math.floor(Date.now()/1000)):Record<string,AccountPickerKnownAccount>{
 if(!value||typeof value!=='object'||!('state' in value)||value.state!=='available'||!('items' in value)||!Array.isArray(value.items)||!Number.isFinite(readExpiresAt)||readExpiresAt<=now)return {};
 const result:Record<string,AccountPickerKnownAccount>={};
 for(const row of value.items){if(!row||typeof row!=='object'||typeof row.accountId!=='string'||!uuid.test(row.accountId)||!['available','unavailable'].includes(row.state))continue;const uid=typeof row.uid==='string'&&/^[a-z0-9]{6,16}$/i.test(row.uid)?row.uid:null,displayName=typeof row.displayName==='string'&&row.displayName.trim()?row.displayName.trim():null;result[row.accountId]={accountId:row.accountId,uid:row.state==='available'?uid:null,displayName:row.state==='available'?displayName:null,state:row.state,readExpiresAt};}
 return result;
}
export function messageAudienceAccountLabel(value:AccountPickerKnownAccount|undefined,now=Math.floor(Date.now()/1000)){
 if(!value||value.readExpiresAt<=now)return '名称暂无法取得';return value.state==='unavailable'?'账户当前不可用':value.displayName||value.uid||'名称暂无法取得';
}
export function messageScheduleLabel(schedule:MessageSchedule){
 if(schedule.kind==='immediate')return '启用后执行一次';
 if(schedule.kind==='once')return '单次定时';
 const recurrence=readMessageRecurrence(schedule.cron);
 const day=['周日','周一','周二','周三','周四','周五','周六'][Number(recurrence.weekday)];
 return recurrence.pattern==='saved'?schedule.cron+' · '+schedule.timezone:recurrence.pattern==='weekly'?'每'+day+' '+recurrence.time+' · '+schedule.timezone:'每天 '+recurrence.time+' · '+schedule.timezone;
}
export function messageRecipientLabel(item:Pick<MessageRecipient,'state'|'deferred'>){return item.state==='pending'&&item.deferred?'等待发送名额':messageRecipientStates[item.state];}
export function messageAttemptLabel(item:MessageRecipient['attempts'][number]){const labels:Record<string,string>={submitted:'邮件已提交',delivered:'站内信已投递',submitting:'正在提交',failed:'提交失败',unknown:'结果未确认'};return item.networkAttempt?labels[item.state]??'处理记录':'本地延后，未尝试网络提交';}
export function messageErrorLabel(code:string|null){
 const labels:Record<string,string>={smtp_not_configured:'邮件发送未配置',smtp_disabled:'邮件发送未启用',smtp_rate_limited:'等待发送名额',smtp_concurrency_limited:'等待并发名额',smtp_submission_unknown:'邮件提交结果未确认',operations_messaging_submission_unconfirmed:'邮件提交结果未确认',operations_messaging_recipient_disabled:'账户已停用，已跳过',operations_messaging_recipient_ineligible:'账户当前不符合条件',operations_messaging_directory_unavailable:'账户状态暂时无法核对',business_admin_denied:'原批准人员当前没有发送权限',operations_permission_denied:'当前没有这项权限',operations_messaging_provider_not_configured:'邮件发送未配置',operations_messaging_not_active:'计划当前未启用'};
 return code?labels[code]??'处理暂未完成（'+code+'）':'';
}
export function messageLocalDate(value:string){const date=new Date(value);return Number.isFinite(date.getTime())?new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16):'';}
export function readMessageRecurrence(cron:string):MessageRecurrence{
 const parts=cron.trim().split(/\s+/),time=parts.length===5&&/^\d{1,2}$/.test(parts[0])&&/^\d{1,2}$/.test(parts[1])&&Number(parts[0])<60&&Number(parts[1])<24?parts[1].padStart(2,'0')+':'+parts[0].padStart(2,'0'):'';
 if(time&&parts[2]==='*'&&parts[3]==='*'&&parts[4]==='*')return {pattern:'daily',time,weekday:'1'};
 if(time&&parts[2]==='*'&&parts[3]==='*'&&/^[0-6]$/.test(parts[4]))return {pattern:'weekly',time,weekday:parts[4]};
 return {pattern:'saved',time:'',weekday:'1'};
}
export function createMessageDraft(plan:MessagePlan|null=null):MessageDraft{
 const config:MessagingConfig=plan?structuredClone(plan.config):{channels:['inapp'],content:{purpose:'service-update',title:'',body:'',href:null,expiresAt:''},audience:{kind:'accounts',accountIds:[]},senderKey:'notice',schedule:{kind:'immediate'}};
 return {baseVersion:plan?.version??0,baseRevision:plan?.revision??0,config,audienceChosen:!!plan,expiresLocal:messageLocalDate(config.content.expiresAt),onceLocal:config.schedule.kind==='once'?messageLocalDate(config.schedule.at):'',recurrence:config.schedule.kind==='recurring'?readMessageRecurrence(config.schedule.cron):{pattern:'daily',time:'',weekday:'1'},dirty:false};
}
export const messageMergeFields={title:'标题',body:'正文',purpose:'消息用途',href:'相关页面',channels:'发送渠道',audience:'收件范围',sender:'邮件发件身份',schedule:'发送安排与有效截止',automation:'自动发布范围'} as const;
export type MessageMergeKey=keyof typeof messageMergeFields;
export type MessageMergeChoices=Partial<Record<MessageMergeKey,'current'|'mine'>>;
export type MessageMergeConflict={key:MessageMergeKey;label:string;current:MessageDraft;mine:MessageDraft};
const mergeKeys=Object.keys(messageMergeFields) as MessageMergeKey[];
function messageField(draft:MessageDraft,key:MessageMergeKey):unknown{
 switch(key){
  case 'title':case 'body':case 'purpose':return draft.config.content[key];
  case 'href':return draft.config.content.href||null;
  case 'channels':return [...draft.config.channels].sort();
  case 'audience':{const audience=draft.config.audience;return {chosen:draft.audienceChosen,...(audience.kind==='accounts'?{kind:audience.kind,accountIds:[...audience.accountIds].sort()}:audience.kind==='attributes'?{kind:audience.kind,subjectTypes:[...audience.subjectTypes].sort()}:{kind:audience.kind})};}
  case 'sender':return draft.config.senderKey;
  case 'automation':return draft.config.automation??{kind:'human-required',factsConfirmed:false};
  case 'schedule':{const schedule=draft.config.schedule;return {expires:messageDateSignature(draft.expiresLocal,draft.config.content.expiresAt),kind:schedule.kind,...(schedule.kind==='once'?{at:messageDateSignature(draft.onceLocal,schedule.at)}:schedule.kind==='recurring'?{timezone:schedule.timezone,recurrence:draft.recurrence.pattern==='saved'?{pattern:'saved',cron:schedule.cron}:{pattern:draft.recurrence.pattern,time:draft.recurrence.time,...(draft.recurrence.pattern==='weekly'?{weekday:draft.recurrence.weekday}:{})}}:{})};}
 }
}
const sameMessageField=(a:MessageDraft,b:MessageDraft,key:MessageMergeKey)=>JSON.stringify(messageField(a,key))===JSON.stringify(messageField(b,key));
function copyMessageField(target:MessageDraft,source:MessageDraft,key:MessageMergeKey){
 switch(key){
  case 'title':target.config.content.title=source.config.content.title;break;
  case 'body':target.config.content.body=source.config.content.body;break;
  case 'purpose':target.config.content.purpose=source.config.content.purpose;break;
  case 'href':target.config.content.href=source.config.content.href;break;
  case 'channels':target.config.channels=[...source.config.channels];break;
  case 'audience':target.config.audience=structuredClone(source.config.audience);target.audienceChosen=source.audienceChosen;break;
  case 'sender':target.config.senderKey=source.config.senderKey;break;
  case 'automation':target.config.automation=structuredClone(source.config.automation??{kind:'human-required',factsConfirmed:false});break;
  case 'schedule':target.config.schedule=structuredClone(source.config.schedule);target.config.content.expiresAt=source.config.content.expiresAt;target.expiresLocal=source.expiresLocal;target.onceLocal=source.onceLocal;target.recurrence={...source.recurrence};break;
 }
}
function completeMessageSource(draft:MessageDraft){
 const config=draft?.config,content=config?.content,audience=config?.audience,schedule=config?.schedule;
 if(!config||!content||typeof content.title!=='string'||typeof content.body!=='string'||!Object.hasOwn(messagePurposes,content.purpose)||!(content.href===null||typeof content.href==='string')||typeof content.expiresAt!=='string'||!Number.isFinite(Date.parse(content.expiresAt))||!Array.isArray(config.channels)||!config.channels.every(channel=>Object.hasOwn(messageChannels,channel))||!['account','notice','community','updates','team'].includes(config.senderKey))return false;
 if(!audience||!(['all-accounts','accounts','attributes'] as const).includes(audience.kind))return false;
 if(audience.kind==='accounts'&&(!Array.isArray(audience.accountIds)||!audience.accountIds.every(id=>typeof id==='string'&&uuid.test(id))))return false;
 if(audience.kind==='attributes'&&(!Array.isArray(audience.subjectTypes)||!audience.subjectTypes.every(type=>Object.hasOwn(messageSubjectTypes,type))))return false;
 if(!schedule||!(['immediate','once','recurring'] as const).includes(schedule.kind)||schedule.kind==='once'&&(typeof schedule.at!=='string'||!Number.isFinite(Date.parse(schedule.at)))||schedule.kind==='recurring'&&(typeof schedule.cron!=='string'||typeof schedule.timezone!=='string'))return false;
 return typeof draft.expiresLocal==='string'&&!!draft.expiresLocal&&typeof draft.onceLocal==='string'&&!!draft.recurrence&&Number.isSafeInteger(draft.baseVersion)&&draft.baseVersion>0&&Number.isSafeInteger(draft.baseRevision)&&draft.baseRevision>0;
}
export function messageMergeChangedKeys(before:MessageDraft,after:MessageDraft){return mergeKeys.filter(key=>!sameMessageField(before,after,key));}
export function messageMerge(base:MessageDraft,mine:MessageDraft,current:MessageDraft,choices:MessageMergeChoices={}){
 const conflicts:MessageMergeConflict[]=[];let unresolved=0;
 if(!completeMessageSource(base)||!completeMessageSource(current)||current.baseVersion<base.baseVersion||current.baseVersion===base.baseVersion&&current.baseRevision<base.baseRevision)return {draft:null,conflicts,unresolved:1};
 const merged=structuredClone(current);
 for(const key of mergeKeys){
  let source=current;
  if(sameMessageField(mine,base,key))source=current;
  else if(sameMessageField(current,base,key)||sameMessageField(mine,current,key))source=mine;
  else{conflicts.push({key,label:messageMergeFields[key],mine,current});if(!choices[key])unresolved++;source=choices[key]==='mine'?mine:current;}
  copyMessageField(merged,source,key);
 }
 merged.baseVersion=current.baseVersion;merged.baseRevision=current.baseRevision;merged.dirty=messageMergeChangedKeys(merged,current).length>0;
 return {draft:merged,conflicts,unresolved};
}
export function messageMergeValue(draft:MessageDraft,key:MessageMergeKey,identityNames:Readonly<Record<string,string>>={}):string{
 switch(key){
  case 'title':case 'body':return draft.config.content[key]||'未填写';
  case 'purpose':return messagePurposes[draft.config.content.purpose];
  case 'href':return draft.config.content.href||'未设置相关页面';
  case 'channels':return draft.config.channels.map(channel=>messageChannels[channel]).join('、')||'尚未选择渠道';
  case 'audience':return draft.audienceChosen?messageAudienceLabel(draft.config.audience):'尚未选择收件范围';
  case 'sender':return identityNames[draft.config.senderKey]||'官方发件身份';
  case 'automation':return draft.config.automation?.kind==='ordinary'?'普通通知，事实与收件范围已核实':'由人工决定发布';
  case 'schedule':{const schedule=draft.config.schedule,expiry=draft.expiresLocal.replace('T',' ');if(schedule.kind==='immediate')return '启用后执行一次；有效至 '+expiry;if(schedule.kind==='once')return '指定时间 '+draft.onceLocal.replace('T',' ')+'；有效至 '+expiry;const recurrence=draft.recurrence,day=['周日','周一','周二','周三','周四','周五','周六'][Number(recurrence.weekday)];return (recurrence.pattern==='saved'?'沿用当前自定义周期':recurrence.pattern==='weekly'?'每'+day+' '+recurrence.time:'每天 '+recurrence.time)+' · '+schedule.timezone+'；有效至 '+expiry;}
 }
}
const localIso=(value:string)=>{const date=new Date(value);return value&&Number.isFinite(date.getTime())?date.toISOString():'';};
const messagePreservedDate=(local:string,original:string)=>original&&Number.isFinite(Date.parse(original))&&local===messageLocalDate(original)?original:localIso(local);
function messageDateSignature(local:string,original:string){const value=messagePreservedDate(local,original);return value?new Date(value).toISOString():local;}
export function buildMessageConfig(draft:MessageDraft):{config:MessagingConfig|null;error:string}{
 const config=structuredClone(draft.config),title=config.content.title.trim(),body=config.content.body.trim(),expiresAt=messagePreservedDate(draft.expiresLocal,config.content.expiresAt);
 if(!title||!body||!expiresAt)return {config:null,error:'请填写标题、正文和有效截止时间。'};
 if(title.length>160||body.length>8000)return {config:null,error:'标题或正文超过当前长度上限。'};
 if(!config.channels.length)return {config:null,error:'请选择至少一个发送渠道。'};
 const direct=config.channels.some(channel=>channel!=='announcement');
 if(direct&&(!draft.audienceChosen||config.audience.kind==='accounts'&&!config.audience.accountIds.length||config.audience.kind==='attributes'&&!config.audience.subjectTypes.length))return {config:null,error:'请选择收件范围。'};
 const href=config.content.href?.trim()||null;
 if(href&&(!href.startsWith('/')||href.startsWith('//')||/[\s\\\p{Cc}]/u.test(href)||/^\/(?:api|v1|v2|admin)(?:\/|$)/.test(href)))return {config:null,error:'相关页面请使用官网内的有效路径。'};
 let schedule:MessageSchedule=config.schedule;
 if(schedule.kind==='once'){const at=messagePreservedDate(draft.onceLocal,schedule.at);if(!at)return {config:null,error:'请选择本次执行时间。'};schedule={kind:'once',at};}
 if(schedule.kind==='recurring'){
  try{new Intl.DateTimeFormat('en',{timeZone:schedule.timezone});}catch{return {config:null,error:'请使用有效时区。'};}
  if(draft.recurrence.pattern!=='saved'){
   if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.recurrence.time))return {config:null,error:'请选择周期执行时间。'};
   if(draft.recurrence.pattern==='weekly'&&!/^[0-6]$/.test(draft.recurrence.weekday))return {config:null,error:'请选择每周执行的日期。'};
   const [hour,minute]=draft.recurrence.time.split(':').map(Number);
   schedule={kind:'recurring',timezone:schedule.timezone,cron:minute+' '+hour+' * * '+(draft.recurrence.pattern==='weekly'?draft.recurrence.weekday:'*')};
  }
 }
 return {config:{channels:[...new Set(config.channels)],content:{purpose:config.content.purpose,title,body,href,expiresAt},audience:direct?config.audience:{kind:'all-accounts'},senderKey:config.senderKey,schedule,automation:config.automation??{kind:'human-required',factsConfirmed:false}},error:''};
}


type MessageRecoveryIntent=Readonly<{path:string;body:Record<string,unknown>}>;
const receiptObject=(value:unknown):Record<string,unknown>|null=>!!value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const positiveReceiptNumber=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
function originalMessageIntent(intent:MessageRecoveryIntent){
 const operationId=intent.body.operationId;
 if(typeof operationId!=='string'||!uuid.test(operationId))throw Error('Invalid original message operation');
 if(intent.path==='/v1/operations/messaging/plans')return {operationId,kind:'create' as const,target:null};
 const plan=intent.path.match(/^\/v1\/operations\/messaging\/plans\/([^/]+)\/(save|activate|pause|resume|stop|withdraw)$/);
 if(plan&&uuid.test(plan[1])&&positiveReceiptNumber(intent.body.expectedVersion)&&positiveReceiptNumber(intent.body.expectedRevision))return {operationId,kind:plan[2] as Exclude<MessageOperationKind,'create'|'retry'>,target:plan[1]};
 const run=intent.path.match(/^\/v1\/operations\/messaging\/runs\/([^/]+)\/retry$/);
 if(run&&uuid.test(run[1])&&positiveReceiptNumber(intent.body.expectedRevision))return {operationId,kind:'retry' as const,target:run[1]};
 throw Error('Invalid original message operation');
}
export function messageOperationReceiptPath(intent:MessageRecoveryIntent){return '/v1/operations/messaging/operations/'+originalMessageIntent(intent).operationId;}
/** The owner GET proves only the original finite outcome, never the current
 * plan/configuration. Missing or mismatched receipts cannot authorize replay. */
export function messageOperationReceipt(intent:MessageRecoveryIntent,value:unknown,now=Math.floor(Date.now()/1000)):MessageOriginalReceipt{
 const original=originalMessageIntent(intent),row=receiptObject(value),result=receiptObject(row?.result);
 if(!row||row.state!=='recorded'||row.operationId!==original.operationId||row.kind!==original.kind||row.metadataOnly!==true||typeof row.checkedAt!=='number'||!Number.isFinite(row.checkedAt)||row.checkedAt<0||row.checkedAt>now+5||typeof row.readExpiresAt!=='number'||!Number.isFinite(row.readExpiresAt)||row.readExpiresAt<=now||row.readExpiresAt<row.checkedAt||row.readExpiresAt-row.checkedAt>31||!result||typeof result.planId!=='string'||!uuid.test(result.planId)||!positiveReceiptNumber(result.version)||!positiveReceiptNumber(result.revision))throw Error('Original message result unavailable');
 const lease={operationId:original.operationId,checkedAt:row.checkedAt,readExpiresAt:row.readExpiresAt,metadataOnly:true as const};
 if(original.kind==='retry'){
  if(result.runId!==original.target||result.revision!==Number(intent.body.expectedRevision)+1||result.state!=='running')throw Error('Different original message run');
  return {...lease,kind:'retry',result:{planId:result.planId,runId:original.target!,version:result.version,revision:result.revision,state:'running'}};
 }
 if(original.kind==='create'){
  if(result.version!==1||result.revision!==1||result.state!=='draft')throw Error('Different original message creation');
 }else if(result.planId!==original.target||result.version!==Number(intent.body.expectedVersion)+(original.kind==='save'?1:0)||result.revision!==Number(intent.body.expectedRevision)+1)throw Error('Different original message plan');
 const state=original.kind==='create'||original.kind==='save'?'draft':original.kind==='activate'||original.kind==='resume'?'active':original.kind==='pause'?'paused':'stopped';
 if(result.state!==state)throw Error('Different original message state');
 let effects:MessageCommandEffects|undefined;
 if(result.effects!==undefined){
  const x=receiptObject(result.effects);
  if(original.kind==='create'||original.kind==='save'||!x||x.futureExecutionStopped!==['pause','stop','withdraw'].includes(original.kind)||x.alreadySubmittedEmailRetracted!==false||x.existingPublicationsWithdrawn!==(original.kind==='withdraw'))throw Error('Different original message effects');
  effects={futureExecutionStopped:['pause','stop','withdraw'].includes(original.kind),alreadySubmittedEmailRetracted:false,existingPublicationsWithdrawn:original.kind==='withdraw'};
 }
 return {...lease,kind:original.kind,result:{planId:result.planId,version:result.version,revision:result.revision,state,...(effects?{effects}:{})}};
}
