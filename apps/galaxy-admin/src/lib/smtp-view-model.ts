import type {SmtpOriginalReceipt,SmtpTestState,SmtpConfiguration,SmtpCredential} from "../components/smtp/smtp-types";

export const smtpTabs=[{id:'configuration',label:'服务配置'},{id:'identities',label:'身份与发信地址'},{id:'queue',label:'发送队列'},{id:'bounces',label:'退信记录'},{id:'domains',label:'域名与验证'}] as const;
export type SmtpTab=typeof smtpTabs[number]['id'];
export type SmtpLocation={tab:SmtpTab;queueAfter:string;queueTrail:string[];testsAfter:string;testsTrail:string[];historyAfter:string;historyTrail:string[]};
export type SmtpDraft={enabled:boolean;host:string;port:string;tls:''|'implicit'|'starttls';credentialRef:string;connectionTimeoutMs:string;greetingTimeoutMs:string;socketTimeoutMs:string;maxConnections:string;rateLimit:string;rateWindowSeconds:string;dkimSelector:string};
const scalar=(value:unknown)=>typeof value==='string'?value:'';
const cursor=(value:unknown)=>{const input=scalar(value);return /^[1-9][0-9]{0,18}$/.test(input)&&BigInt(input)<=9223372036854775807n?input:'';};
const trail=(value:unknown)=>scalar(value).split(',').filter(item=>item==='start'||!!cursor(item)).slice(-30);
export function smtpLocation(raw:Record<string,unknown>):SmtpLocation{
 const tab=scalar(raw.tab);return {tab:smtpTabs.some(item=>item.id===tab)?tab as SmtpTab:'configuration',queueAfter:cursor(raw.queueAfter),queueTrail:trail(raw.queueTrail),testsAfter:cursor(raw.testsAfter),testsTrail:trail(raw.testsTrail),historyAfter:cursor(raw.historyAfter),historyTrail:trail(raw.historyTrail)};
}
export function smtpHref(location:SmtpLocation,patch:Partial<SmtpLocation>={}){
 const next={...location,...patch},query=new URLSearchParams();if(next.tab!=='configuration')query.set('tab',next.tab);
 for(const key of ['queueAfter','testsAfter','historyAfter'] as const)if(next[key])query.set(key,next[key]);
 for(const key of ['queueTrail','testsTrail','historyTrail'] as const)if(next[key].length)query.set(key,next[key].join(','));
 return '/admin/operations/smtp'+(query.size?'?'+query:'');
}
export function smtpPageQuery(after:string){return new URLSearchParams({limit:'25',...(cursor(after)?{after}: {})}).toString();}
export function smtpPageChange(location:SmtpLocation,kind:'queue'|'tests'|'history',nextAfter?:string):Partial<SmtpLocation>{
 const afterKey=`${kind}After` as const,trailKey=`${kind}Trail` as const;
 if(nextAfter){const next=cursor(nextAfter);return next?{[afterKey]:next,[trailKey]:[...location[trailKey],location[afterKey]||'start'].slice(-30)}:{};}
 const previous=[...location[trailKey]],value=previous.pop();return {[afterKey]:value==='start'?'':cursor(value),[trailKey]:previous};
}
export function smtpDraft(configuration:SmtpConfiguration):SmtpDraft{
 return Object.fromEntries(Object.entries(configuration).map(([key,value])=>[key,key==='enabled'?value:value===null?'':String(value)])) as SmtpDraft;
}
const numberFields={port:[1,65535,'端口'],connectionTimeoutMs:[100,120000,'连接超时'],greetingTimeoutMs:[100,120000,'握手超时'],socketTimeoutMs:[100,300000,'通信超时'],maxConnections:[1,32,'并发连接'],rateLimit:[1,100000,'每个窗口最多提交'],rateWindowSeconds:[1,86400,'限速窗口']} as const;
export function smtpConfiguration(draft:SmtpDraft):{value:SmtpConfiguration|null;error:string}{
 const numbers:Record<string,number|null>={};
 for(const [key,[minimum,maximum,label]]of Object.entries(numberFields)){
  const text=draft[key as keyof typeof numberFields].trim(),value=text===''?null:Number(text);
  if(value!==null&&(!/^\d+$/.test(text)||!Number.isSafeInteger(value)||value<minimum||value>maximum))return {value:null,error:`${label}应为${minimum}至${maximum}之间的整数。`};
  numbers[key]=value;
 }
 const host=draft.host.trim().toLowerCase(),ref=draft.credentialRef.trim(),selector=draft.dkimSelector.trim();
 if(host&&(!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)||host.includes('..')||host.length>253))return {value:null,error:'请填写有效SMTP主机名。'};
 if(ref&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(ref))return {value:null,error:'请选择有效的凭据引用。'};
 if(selector&&!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(selector))return {value:null,error:'请填写有效的DKIM选择器。'};
 const value={enabled:draft.enabled,host:host||null,port:numbers.port,tls:draft.tls||null,credentialRef:ref||null,connectionTimeoutMs:numbers.connectionTimeoutMs,greetingTimeoutMs:numbers.greetingTimeoutMs,socketTimeoutMs:numbers.socketTimeoutMs,maxConnections:numbers.maxConnections,rateLimit:numbers.rateLimit,rateWindowSeconds:numbers.rateWindowSeconds,dkimSelector:selector||null} as SmtpConfiguration;
 if(value.enabled&&Object.entries(value).some(([key,input])=>key!=='dkimSelector'&&input===null))return {value:null,error:'启用前请补齐主机、凭据及发送参数。'};
 return {value,error:''};
}
export function selectSmtpCredential(draft:SmtpDraft,ref:string,credentials:SmtpCredential[]):SmtpDraft{
 const match=credentials.find(item=>item.ref===ref&&item.available);return match?{...draft,credentialRef:ref,host:match.host,port:String(match.port),tls:match.tls}:{...draft,credentialRef:''};
}
export function smtpConfigurationChanged(draft:SmtpDraft,current:SmtpConfiguration){const parsed=smtpConfiguration(draft);return !parsed.value||Object.entries(parsed.value).some(([key,value])=>current[key as keyof SmtpConfiguration]!==value);}
const connectionKeys=['host','port','tls','credentialRef'] as const;
const mergeFields=['enabled','connectionTimeoutMs','greetingTimeoutMs','socketTimeoutMs','maxConnections','rateLimit','rateWindowSeconds','dkimSelector'] as const;
export type SmtpMergeKey='connection'|typeof mergeFields[number];
export type SmtpMergeChoices=Partial<Record<SmtpMergeKey,'mine'|'current'>>;
type SmtpConnection=Pick<SmtpDraft,typeof connectionKeys[number]>;
export type SmtpMergeConflict={key:SmtpMergeKey;label:string;mine:string|boolean|SmtpConnection;current:string|boolean|SmtpConnection};
export function smtpMerge(base:SmtpDraft,mine:SmtpDraft,current:SmtpDraft,choices:SmtpMergeChoices,credentials:readonly SmtpCredential[]){
 const refs=new Set(credentials.map(item=>item.ref)),known=(value:SmtpDraft)=>typeof value.credentialRef==='string'&&(value.credentialRef===''||refs.has(value.credentialRef))&&connectionKeys.every(key=>typeof value[key]==='string');
 // Credential references are safe server identifiers, never masked secret values.
 // Missing connection metadata cannot be interpreted as an instruction to clear it.
 if(!known(base)||!known(mine)||!known(current))return {draft:null,conflicts:[] as SmtpMergeConflict[],unresolved:0};
 const conflicts:SmtpMergeConflict[]=[],draft={...current};
 const normal=(key:keyof SmtpDraft,value:string|boolean)=>typeof value==='boolean'?value:key==='host'?value.trim().toLowerCase():key in numberFields&&/^\d+$/.test(value.trim())&&Number.isSafeInteger(Number(value))?String(Number(value)):value.trim();
 const connection=(value:SmtpDraft)=>Object.fromEntries(connectionKeys.map(key=>[key,value[key]])) as SmtpConnection;
 const sameConnection=(left:SmtpDraft,right:SmtpDraft)=>connectionKeys.every(key=>normal(key,left[key])===normal(key,right[key]));
 if(sameConnection(mine,base))Object.assign(draft,connection(current));
 else if(sameConnection(current,base)||sameConnection(mine,current))Object.assign(draft,connection(mine));
 else{conflicts.push({key:'connection',label:'发信连接',mine:connection(mine),current:connection(current)});Object.assign(draft,connection(choices.connection==='mine'?mine:current));}
 for(const key of mergeFields){const before=normal(key,base[key]),local=normal(key,mine[key]),remote=normal(key,current[key]);let value=current[key];
  if(local===before)value=current[key];else if(remote===before||local===remote)value=mine[key];else{conflicts.push({key,label:smtpFieldLabels[key],mine:mine[key],current:current[key]});value=choices[key]==='mine'?mine[key]:current[key];}
  Object.assign(draft,{[key]:value});
 }
 return{draft,conflicts,unresolved:conflicts.filter(item=>!choices[item.key]).length};
}
export function smtpMergeValue(value:SmtpMergeConflict['mine'],credentials:readonly SmtpCredential[]){
 if(typeof value==='boolean')return value?'启用':'停用';if(typeof value==='string')return value||'未设置';
 const credential=value.credentialRef?credentials.find(item=>item.ref===value.credentialRef)?.label:'未选择凭据';
 return [value.host||'未设置主机',value.port?'端口 '+value.port:'未设置端口',value.tls==='implicit'?'隐式 TLS':value.tls==='starttls'?'STARTTLS':'未设置连接安全',credential||'凭据信息暂未取得'].join(' · ');
}
export const smtpFieldLabels:Record<string,string>={enabled:'日常发信',host:'SMTP主机',port:'端口',tls:'连接安全',credentialRef:'凭据引用',connectionTimeoutMs:'连接超时',greetingTimeoutMs:'握手超时',socketTimeoutMs:'通信超时',maxConnections:'并发连接',rateLimit:'窗口提交上限',rateWindowSeconds:'限速窗口',dkimSelector:'DKIM选择器'};
export const smtpStateLabels:Record<string,string>={testing:'正在测试',connected:'连接及认证通过',submitted:'已提交SMTP',pending:'待提交',submitting:'提交中',delivered:'已投递',skipped:'已跳过',failed:'未成功',unknown:'结果未确认',blocked:'等待处理','not-configured':'尚未配置',ineligible:'收件账户不可用'};
export const smtpErrors:Record<string,string>={smtp_configuration_changed:'配置已有更新，你的修改已保留。',smtp_credential_binding_mismatch:'凭据与当前主机、端口或连接安全不匹配，请选择批准的引用。',smtp_credential_unavailable:'当前没有可用的发信凭据。',smtp_configuration_incomplete:'请补齐发信参数。',invalid_smtp_request:'请检查所填参数。',smtp_not_configured:'发信服务尚未配置。',smtp_rate_limited:'已达本进程限速，等待下一窗口。',smtp_concurrency_limited:'连接正在使用，稍后可继续。',smtp_submission_unknown:'邮件提交结果未确认。',smtp_recipient_ineligible:'当前无法向这个账户投递测试。',smtp_connection_failed:'无法连接发信服务。',smtp_timeout:'发信服务响应超时。',smtp_authentication_failed:'SMTP认证未通过。',smtp_tls_failed:'安全连接未通过。',smtp_permanent_rejection:'SMTP服务拒绝了此次提交。',smtp_temporary_rejection:'SMTP服务暂时未接受提交。'};
export function smtpState(state:string){return smtpStateLabels[state]??'未记录';}
export function smtpCode(code:string|null){return code?smtpErrors[code]??'需要核对当前发信记录。':'';}
export function smtpTime(value:string|null){const date=value?new Date(value):null;return date&&Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未记录';}


type SmtpRecoveryIntent=Readonly<{path:string;body:Record<string,unknown>}>;
const smtpReceiptId=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const smtpReceiptObject=(value:unknown):Record<string,unknown>|null=>!!value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
function originalSmtpIntent(intent:SmtpRecoveryIntent){
 const operationId=intent.body.operationId,version=intent.body.expectedVersion;
 if(typeof operationId!=='string'||!smtpReceiptId.test(operationId)||typeof version!=='number'||!Number.isSafeInteger(version)||version<0||version>2147483646)throw Error('Invalid original SMTP operation');
 if(intent.path==='/v1/operations/smtp/settings')return {operationId,version,kind:'settings' as const};
 if(version>0&&intent.path==='/v1/operations/smtp/tests/connection')return {operationId,version,kind:'test.connection' as const};
 if(version>0&&intent.path==='/v1/operations/smtp/tests/delivery')return {operationId,version,kind:'test.delivery' as const};
 throw Error('Invalid original SMTP operation');
}
export function smtpOperationReceiptPath(intent:SmtpRecoveryIntent){return '/v1/operations/smtp/operations/'+originalSmtpIntent(intent).operationId;}
const smtpTestResultStates=['connected','submitted','not-configured','ineligible','failed','unknown'] as const;
function originalSmtpTest(value:unknown,operationId:string,kind:'connection'|'delivery',version:number){
 const test=smtpReceiptObject(value);
 if(!test||test.id!==operationId||test.kind!==kind||test.configurationVersion!==version||!smtpTestResultStates.includes(test.state as typeof smtpTestResultStates[number])||!(test.code===null||typeof test.code==='string'&&/^[a-z][a-z0-9_]{0,119}$/.test(test.code)))throw Error('Original SMTP test result unavailable');
 return {state:test.state as Exclude<SmtpTestState,'testing'>,code:test.code as string|null};
}
/** This owner GET proves an original finite outcome. It cannot supply saved
 * configuration or reconstruct delivery targets, timestamps or full test rows. */
export function smtpOperationReceipt(intent:SmtpRecoveryIntent,value:unknown,now=Math.floor(Date.now()/1000)):SmtpOriginalReceipt{
 const original=originalSmtpIntent(intent),row=smtpReceiptObject(value),result=smtpReceiptObject(row?.result);
 if(!row||row.state!=='recorded'||row.operationId!==original.operationId||row.kind!==original.kind||row.metadataOnly!==true||typeof row.checkedAt!=='number'||!Number.isFinite(row.checkedAt)||row.checkedAt<0||row.checkedAt>now+5||typeof row.readExpiresAt!=='number'||!Number.isFinite(row.readExpiresAt)||row.readExpiresAt<=now||row.readExpiresAt<row.checkedAt||row.readExpiresAt-row.checkedAt>31||!result)throw Error('Original SMTP result unavailable');
 const lease={operationId:original.operationId,checkedAt:row.checkedAt,readExpiresAt:row.readExpiresAt,metadataOnly:true as const};
 if(original.kind==='settings'){
  if(result.version!==original.version+1)throw Error('Different original SMTP save');
  return {...lease,kind:'settings',result:{version:original.version+1}};
 }
 if(result.version!==original.version||result.testId!==original.operationId)throw Error('Different original SMTP test');
 const test=originalSmtpTest({id:result.testId,kind:original.kind==='test.connection'?'connection':'delivery',configurationVersion:result.version,state:result.state,code:result.code},original.operationId,original.kind==='test.connection'?'connection':'delivery',original.version);
 return {...lease,kind:original.kind,result:{version:original.version,testId:original.operationId,...test}};
}
export function validateSmtpTestOutcome(value:unknown,intent:SmtpRecoveryIntent){
 const original=originalSmtpIntent(intent),row=smtpReceiptObject(value);
 if(original.kind==='settings'||!row)throw Error('Different original SMTP test');
 if(row.source==='original-receipt'){if(smtpOperationReceipt(intent,{...smtpReceiptObject(row.receipt),state:'recorded'}).kind==='settings')throw Error('Different original SMTP test');return;}
 originalSmtpTest(row.test,original.operationId,original.kind==='test.connection'?'connection':'delivery',original.version);
}
