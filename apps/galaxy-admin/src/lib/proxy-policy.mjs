import {aiWorkReadPath,aiWorkWritePath,aiWorkQueryAllowed} from "./ai-work-accounts/ai-work-proxy-policy.mjs";
import {systemSettingsReadPath,systemSettingsWritePath,systemSettingsQueryAllowed} from "./system-settings/system-settings-proxy-policy.mjs";
import {autonomyReadPath,autonomyWritePath,autonomyQueryAllowed} from "./autonomy/autonomy-proxy-policy.mjs";
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const userReadPath=new RegExp('^/v1/operations/users(?:/summary|/'+uuid+'(?:/(?:summary|audit|links|type-history|operations/'+uuid+'))?)?$','i');
const userOperationReadPath=new RegExp('^/v1/operations/users/'+uuid+'/operations/'+uuid+'$','i');
const productChatOperationReadPath=new RegExp('^/v1/operations/(?:(?:notices|retention)/operations/'+uuid+'|chat-reports/'+uuid+'/operations/'+uuid+')$','i');
const governanceOperationReadPath=new RegExp('^/v1/operations/(?:community/(?:(?:reports|sections)/'+uuid+'|content(?:/(?:post|reply)/'+uuid+')?|tags)|resources/(?:projects|methods)/'+uuid+')/operations/'+uuid+'$','i');
const registeredUsersRoot='/v1/operations/registered-users';
const registeredUsersReadPath=new RegExp('^'+registeredUsersRoot+'(?:/'+uuid+'(?:/history)?|/operations/'+uuid+')?$','i');
const registeredUsersWritePath=new RegExp('^'+registeredUsersRoot+'/'+uuid+'/commands$','i');
const managementAccountsRoot='/v1/operations/management-accounts';
const managementAccountId='[a-f0-9]{64}';
const managementAccountsReadPath=new RegExp('^'+managementAccountsRoot+'(?:/'+managementAccountId+'(?:/history|/assignments/operations/'+uuid+')?|/operations/'+uuid+')?$','i');
const managementAccountsWritePath=new RegExp('^'+managementAccountsRoot+'(?:/'+managementAccountId+'/(?:commands|assignments))?$','i');
function managementAccountsQueryAllowed(pathname,search){
  if(!managementAccountsReadPath.test(pathname)&&!managementAccountsWritePath.test(pathname))return true;
  const keys=pathname===managementAccountsRoot?['page','pageSize','query','enabled','roleId','aiDomain','sort']
    :pathname.endsWith('/history')?['after','limit']:[];
  const params=new URLSearchParams(search);
  return search.length<=4096&&[...params.keys()].every(key=>keys.includes(key)&&params.getAll(key).length===1);
}
function registeredUsersQueryAllowed(pathname,search){
  if(!registeredUsersReadPath.test(pathname)&&!registeredUsersWritePath.test(pathname))return true;
  const keys=pathname===registeredUsersRoot
    ?['page','pageSize','query','source','subjectType','login','emailVerified','registeredFrom','registeredTo','sort','participation','business']
    :pathname.endsWith('/history')?['after','limit']:[];
  const params=new URLSearchParams(search);
  return search.length<=4096&&[...params.keys()].every(key=>keys.includes(key)&&params.getAll(key).length===1);
}
const auditReadPath=new RegExp('^/v1/operations/(?:audit|users/'+uuid+'/audit)$','i');
const chatReportReadPath=new RegExp('^/v1/operations/chat-reports(?:/'+uuid+')?$','i');
const fileReadPath=new RegExp('^/v1/operations/files(?:/summary|/(?:chat|forum)/'+uuid+')?$','i');
const fileRetryPath=new RegExp('^/v1/operations/files/(?:chat|forum)/'+uuid+'/retry$','i');
const fileAccessReadPath=new RegExp('^/v1/operations/files/access/operations/'+uuid+'$','i');
const fileAccessWritePath=new RegExp('^/v1/operations/files/(?:chat|forum)/'+uuid+'/access$','i');
const fileCleanupReadPath=new RegExp('^/v1/operations/files/cleanup/(?:candidates|plans(?:/'+uuid+')?|operations/'+uuid+')$','i');
const fileCleanupWritePath=new RegExp('^/v1/operations/files/cleanup/plans(?:/'+uuid+'/(?:approve|cancel))?$','i');
function fileCleanupQueryAllowed(pathname,search){
 if(!fileCleanupReadPath.test(pathname)&&!fileCleanupWritePath.test(pathname))return true;
 const allowed=pathname.endsWith('/candidates')?['kind','after','limit']:pathname.endsWith('/plans')?['after','limit']:[],params=new URLSearchParams(search);
 return search.length<=4096&&[...params.keys()].every(key=>allowed.includes(key)&&params.getAll(key).length===1);
}
const permissionsReadPath=new RegExp('^/v1/operations/permissions/(?:catalog(?:/lease)?|roles(?:/'+uuid+')?|personnel|automation|history|operations/'+uuid+'|ai-delegation(?:/operations/'+uuid+')?)$','i');
const permissionsWritePath=/^\/v1\/operations\/permissions\/(?:roles|assignments|automation|ai-delegation)$/;
const messagingReadPath=new RegExp('^/v1/operations/messaging/(?:plans(?:/'+uuid+'(?:/history)?)?|runs(?:/'+uuid+'(?:/recipients)?)?|operations/'+uuid+')$','i');
const messagingWritePath=new RegExp('^/v1/operations/messaging/(?:plans(?:/'+uuid+'/(?:save|activate|pause|resume|stop|withdraw))?|runs/'+uuid+'/retry)$','i');
const smtpReadPath=new RegExp('^/v1/operations/smtp(?:/(?:identities|queue|bounces|domains|tests|history|operations/'+uuid+'))?$','i');
const smtpWritePath=/^\/v1\/operations\/smtp\/(?:settings|tests\/(?:connection|delivery))$/;
const agentOsConversationRoot='conversations/(?:overview|governance|messaging|discovery|maintenance)';
const agentOsReadPath=new RegExp('^/v1/operations/agentos/(?:status|options|operations/'+uuid+'|executions(?:/'+uuid+')?|runs(?:/[A-Za-z0-9_-]{1,128})?|'+agentOsConversationRoot+'(?:/(?:qualification|history|context|cards|management-capabilities|operations/'+uuid+'(?:/events)?|cards/'+uuid+'))?)$','i');
const agentOsWritePath=new RegExp('^/v1/operations/agentos/(?:executions(?:/'+uuid+'/(?:events|runs|review|continue))?|'+agentOsConversationRoot+'/(?:runs|cards/'+uuid+'/(?:confirm|dismiss)|operations/'+uuid+'/cancel))$','i');
const agentOsConversationEventsPath=new RegExp('^/v1/operations/agentos/'+agentOsConversationRoot+'/operations/'+uuid+'/events$','i');
export const isAgentOsConversationEventsPath=pathname=>agentOsConversationEventsPath.test(pathname);
const discoveryAnalyticsPath='/v1/operations/discovery/analytics';
const recommendationReadPath=new RegExp('^/v1/operations/recommendation/(?:overview|history|operations/'+uuid+')$','i');
const recommendationWritePath=/^\/v1\/operations\/recommendation\/(?:policy|themes)$/;
const searchQualityReadPath=new RegExp('^/v1/operations/search-quality/(?:overview|history|operations/'+uuid+')$','i');
const searchQualityWritePath=/^\/v1\/operations\/search-quality\/(?:draft|apply|restore)$/;
const ruleSettingsKey='(?:resource-budget|community-quota|forum-quota|business-controls)';
const strategiesReadPath=new RegExp('^/v1/operations/strategies/(?:overview|options|versions|records|(?:runs|operations)/'+uuid+')$','i');
const strategiesWritePath=new RegExp('^/v1/operations/strategies/(?:draft|publish|rehearsal|control|runs(?:/'+uuid+'/continue)?)$','i');
function strategiesQueryAllowed(pathname,search){
 if(!strategiesReadPath.test(pathname)&&!strategiesWritePath.test(pathname))return true;
 if(strategiesWritePath.test(pathname))return !search;
 const params=new URLSearchParams(search),keys=pathname.endsWith('/versions')?['after','limit']:pathname.endsWith('/records')?['after','limit','strategyId']:[];
 return search.length<=2048&&[...params.keys()].every(key=>keys.includes(key)&&params.getAll(key).length===1);
}
const ruleSettingsReadPath=new RegExp('^/v1/operations/rules/(?:overview|'+ruleSettingsKey+'/(?:detail|versions)|operations/'+uuid+')$','i');
const ruleSettingsWritePath=new RegExp('^/v1/operations/rules/'+ruleSettingsKey+'/(?:draft|publish|restore|sample)$','i');
function ruleSettingsQueryAllowed(pathname,search){
 if(!ruleSettingsReadPath.test(pathname)&&!ruleSettingsWritePath.test(pathname))return true;
 if(ruleSettingsWritePath.test(pathname))return !search;
 const params=new URLSearchParams(search),keys=pathname.endsWith('/versions')?['after','limit']:[];
 return search.length<=2048&&[...params.keys()].every(key=>keys.includes(key)&&params.getAll(key).length===1);
}
const modelSettingsReadPath=new RegExp('^/v1/operations/model-settings/(?:overview|history|usage|operations/'+uuid+')$','i');
const modelSettingsWritePath=/^\/v1\/operations\/model-settings\/(?:draft|apply|credentials)$/;
function modelSettingsQueryAllowed(pathname,search){
 if(!modelSettingsReadPath.test(pathname)&&!modelSettingsWritePath.test(pathname))return true;
 if(modelSettingsWritePath.test(pathname))return !search;
 const params=new URLSearchParams(search),keys=pathname.endsWith('/history')?['after','limit']:pathname.endsWith('/usage')?['days']:[];
 return search.length<=2048&&[...params.keys()].every(key=>keys.includes(key)&&params.getAll(key).length===1);
}
const maintenanceReadPath=new RegExp('^/v1/operations/maintenance/(?:overview|logs|backups(?:/[a-f0-9]{64})?|restore-plans(?:/'+uuid+')?|(?:operations|command-results)/'+uuid+')$','i');
const maintenanceWritePath=new RegExp('^/v1/operations/maintenance/(?:backups|restore-plans(?:/'+uuid+'/(?:approve|execute|cancel))?)$','i');
function maintenanceQueryAllowed(pathname,search){
 if(!maintenanceReadPath.test(pathname)&&!maintenanceWritePath.test(pathname))return true;
 const params=new URLSearchParams(search),keys=pathname.endsWith('/logs')?['component','level','period','before','limit']:pathname.endsWith('/backups')||new RegExp('/restore-plans(?:/'+uuid+')?$','i').test(pathname)?['after','limit']:[];
 return search.length<=4096&&[...params.keys()].every(key=>keys.includes(key)&&params.getAll(key).length===1);
}
function searchQualityQueryAllowed(pathname,search){
 if(!searchQualityReadPath.test(pathname)&&!searchQualityWritePath.test(pathname))return true;
 if(searchQualityWritePath.test(pathname))return !search;
 const keys=pathname.endsWith('/overview')?['days','query','issue','after','limit']:pathname.endsWith('/history')?['after','limit']:[],params=new URLSearchParams(search);
 return search.length<=4096&&[...params.keys()].every(key=>keys.includes(key)&&params.getAll(key).length===1);
}
function recommendationQueryAllowed(pathname,search){
 if(!recommendationReadPath.test(pathname)&&!recommendationWritePath.test(pathname))return true;
 if(recommendationWritePath.test(pathname))return !search;
 const keys=pathname.endsWith('/overview')?['days','query']:pathname.endsWith('/history')?['after','limit']:[],params=new URLSearchParams(search);
 return search.length<=2048&&[...params.keys()].every(key=>keys.includes(key)&&params.getAll(key).length===1);
}
function discoveryQueryAllowed(pathname,search){
 if(pathname!==discoveryAnalyticsPath)return true;
 const params=new URLSearchParams(search);
 return search.length<=2048&&[...params.keys()].every(key=>['kind','days','scope','accountId'].includes(key)&&params.getAll(key).length===1);
}
function agentOsQueryAllowed(pathname,search){
 if(!agentOsReadPath.test(pathname)&&!agentOsWritePath.test(pathname))return true;
 if(agentOsConversationEventsPath.test(pathname)){
  const params=new URLSearchParams(search);
  return search.length<=80&&[...params].every(([key,value])=>key==='after'&&params.getAll(key).length===1&&/^(?:0|[1-9][0-9]{0,9})$/.test(value));
 }
 if(pathname!=='/v1/operations/agentos/runs')return !search;
 const params=new URLSearchParams(search);
 return search.length<=2048&&[...params.keys()].every(key=>['page','limit','domain','state'].includes(key)&&params.getAll(key).length===1);
}
function messagingQueryAllowed(pathname,search){
  if(!messagingReadPath.test(pathname)&&!smtpReadPath.test(pathname))return true;
  const allowed=pathname==='/v1/operations/messaging/plans'?['after','limit','state']
    :pathname==='/v1/operations/messaging/runs'?['after','limit','planId']
    :/^\/v1\/operations\/messaging\/runs\/[0-9a-f-]{36}\/recipients$/i.test(pathname)?['after','limit','channel','state']
    :/^\/v1\/operations\/messaging\/plans\/[0-9a-f-]{36}\/history$/i.test(pathname)||/^\/v1\/operations\/smtp\/(?:queue|tests|history)$/.test(pathname)?['after','limit']:[];
  const params=new URLSearchParams(search);
  return search.length<=8192&&[...params.keys()].every(key=>allowed.includes(key)&&params.getAll(key).length===1);
}
export function operationsRequestBodyLimit(pathname){
  if(autonomyWritePath.test(pathname))return pathname.endsWith('/config')?65536:4096;
  if(aiWorkWritePath.test(pathname))return 8192;
  if(managementAccountsWritePath.test(pathname))return 16384;
  if(registeredUsersWritePath.test(pathname))return 8192;
  if(fileAccessWritePath.test(pathname))return 8192;
  if(pathname==='/v1/operations/files/cleanup/plans')return 262144;
  if(fileCleanupWritePath.test(pathname))return 2048;
  if(new RegExp('^/v1/operations/agentos/'+agentOsConversationRoot+'/cards/'+uuid+'/(?:confirm|dismiss)$','i').test(pathname))return 2048;
  if(new RegExp('^/v1/operations/agentos/'+agentOsConversationRoot+'/operations/'+uuid+'/cancel$','i').test(pathname))return 2048;
  if(pathname==='/v1/operations/strategies/draft')return 262144;
  if(ruleSettingsWritePath.test(pathname))return 262144;
  if(new RegExp('^/v1/operations/agentos/executions/'+uuid+'/(?:runs|review)$','i').test(pathname))return 65536;
  if(new RegExp('^/v1/operations/agentos/'+agentOsConversationRoot+'/runs$','i').test(pathname))return 65536;
  if(pathname==='/v1/operations/content/publications')return 1048576;
  if(pathname.startsWith('/v1/operations/notices')||pathname==='/v1/operations/messaging/plans'||new RegExp('^/v1/operations/messaging/plans/'+uuid+'/save$','i').test(pathname))return 65536;
  if(smtpWritePath.test(pathname))return 16384;
  return 32768;
}
function permissionsQueryAllowed(pathname,search){
  if(!pathname.startsWith('/v1/operations/permissions/'))return true;
  if(pathname==='/v1/operations/permissions/catalog/lease'){const params=new URLSearchParams(search);return [...params.keys()].length===1&&params.getAll('version').length===1&&/^[0-9a-f]{64}$/.test(params.get('version')??'');}
  if(pathname!=='/v1/operations/permissions/history')return search.length===0;
  const params=new URLSearchParams(search);
  return search.length<=8192&&[...params.keys()].every(key=>['after','limit','resourceId','targetOperatorId'].includes(key)&&params.getAll(key).length===1);
}
function auditQueryAllowed(pathname,search){
  if(!auditReadPath.test(pathname))return true;
  const params=new URLSearchParams(search),allowed=pathname==='/v1/operations/audit'
    ?['accountId','resourceId','after','limit','action','kind','day','query','page','pageSize','snapshot','sort']:['resourceId','after','limit','action','kind','day','query','page','pageSize','snapshot','sort'];
  return search.length<=8192&&[...params.keys()].every(key=>allowed.includes(key)&&params.getAll(key).length===1);
}
function chatReportQueryAllowed(pathname,search){
  if(!chatReportReadPath.test(pathname))return true;
  if(!/^\/v1\/operations\/chat-reports$/i.test(pathname))return search.length===0;
  const params=new URLSearchParams(search);
  return search.length<=8192&&[...params.keys()].every(key=>['roomId','state','after','limit'].includes(key)&&params.getAll(key).length===1);
}
function fileQueryAllowed(pathname,search){
  if(!fileReadPath.test(pathname))return true;
  const directory=pathname==='/v1/operations/files',summary=pathname==='/v1/operations/files/summary';
  if(!directory&&!summary)return search.length===0;
  const params=new URLSearchParams(search),allowed=directory?['after','limit','kind','state','processing','issue']:['kind','state','processing','issue'];
  return search.length<=8192&&[...params.keys()].every(key=>allowed.includes(key)&&params.getAll(key).length===1);
}
const queues='information-watch|search-recovery|content-publication|account-notice|retention-cleanup|messaging-run|messaging-delivery|autonomy-task|autonomy-tick';
const businessReads=[
  '^/v1/operations/(?:summary|audit)$',
  '^/v1/operations/community/(?:sections|reports|posts)(?:/'+uuid+')?$',
  '^/v1/operations/community/content(?:/(?:post|reply)/'+uuid+')?$',
  '^/v1/operations/community/tags$',
  '^/v1/operations/resources/(?:projects|methods)(?:/'+uuid+')?$',
  '^/v1/operations/files(?:/summary|/(?:chat|forum)/'+uuid+')?$',
  '^/v1/operations/notices(?:/'+uuid+')?$',
  '^/v1/operations/feedback(?:/'+uuid+')?$',
  '^/v1/operations/feedback/'+uuid+'/operations/'+uuid+'$',
  '^/v1/operations/rules(?:/(?:resource-budget|community-quota|forum-quota)(?:/history)?)?$',
  '^/v1/operations/retention(?:/runs(?:/'+uuid+')?)?$',
].map(value=>new RegExp(value,'i'));
const businessWrites=[
  '^/v1/operations/community/sections/'+uuid+'/(?:classification|visibility)$',
  '^/v1/operations/community/reports/'+uuid+'/resolve$',
  '^/v1/operations/community/content/(?:post|reply)/'+uuid+'/(?:visibility|curation)$',
  '^/v1/operations/community/content/(?:post|reply)/'+uuid+'/attachments/'+uuid+'/content$',
  '^/v1/operations/community/content/visibility/(?:preview|batch)$',
  '^/v1/operations/community/tags(?:/'+uuid+')?$',
  '^/v1/operations/resources/(?:projects|methods)/'+uuid+'/visibility$',
  '^/v1/operations/files/(?:chat|forum)/'+uuid+'/retry$',
  '^/v1/operations/notices(?:/'+uuid+'/(?:save|publish|withdraw))?$',
  '^/v1/operations/feedback/'+uuid+'/events$',
  '^/v1/operations/feedback/'+uuid+'/attachments/'+uuid+'/content$',
  '^/v1/operations/retention/runs$',
].map(value=>new RegExp(value,'i'));
function summaryQueryAllowed(pathname,search){
  if(pathname!=='/v1/operations/summary'||!search)return true;
  const query=new URLSearchParams(search);
  return [...query].length===1&&query.getAll('publicActivity').length===1&&query.get('publicActivity')==='deferred';
}
export function operationsReadPath(path){
  if(typeof path!=='string'||!path.startsWith('/v1/operations/')||path.includes('#'))return false;
  const at=path.indexOf('?'),pathname=at<0?path:path.slice(0,at);
  if(autonomyReadPath.test(pathname))return autonomyQueryAllowed(pathname,at<0?'':path.slice(at));
  if((governanceOperationReadPath.test(pathname)||productChatOperationReadPath.test(pathname)))return at<0;
  if(pathname==='/v1/operations/summary')return summaryQueryAllowed(pathname,at<0?'':path.slice(at));
  if(userOperationReadPath.test(pathname)||new RegExp('^/v1/operations/feedback/'+uuid+'/operations/'+uuid+'$','i').test(pathname))return at<0;
  if(systemSettingsReadPath.test(pathname))return systemSettingsQueryAllowed(pathname,at<0?'':path.slice(at));
  if(aiWorkReadPath.test(pathname))return aiWorkQueryAllowed(pathname,at<0?'':path.slice(at));
  if(fileAccessReadPath.test(pathname))return at<0;
  if(registeredUsersReadPath.test(pathname))return registeredUsersQueryAllowed(pathname,at<0?'':path.slice(at));
  if(managementAccountsReadPath.test(pathname))return managementAccountsQueryAllowed(pathname,at<0?'':path.slice(at));
  if(fileCleanupReadPath.test(pathname))return fileCleanupQueryAllowed(pathname,at<0?'':path.slice(at));
  if(strategiesReadPath.test(pathname))return strategiesQueryAllowed(pathname,at<0?'':path.slice(at));
  if(ruleSettingsReadPath.test(pathname))return ruleSettingsQueryAllowed(pathname,at<0?'':path.slice(at));
  if(agentOsReadPath.test(pathname))return agentOsQueryAllowed(pathname,at<0?'':path.slice(at));
  if(recommendationReadPath.test(pathname))return recommendationQueryAllowed(pathname,at<0?'':path.slice(at));
  if(searchQualityReadPath.test(pathname))return searchQualityQueryAllowed(pathname,at<0?'':path.slice(at));
  if(maintenanceReadPath.test(pathname))return maintenanceQueryAllowed(pathname,at<0?'':path.slice(at));
  if(modelSettingsReadPath.test(pathname))return modelSettingsQueryAllowed(pathname,at<0?'':path.slice(at));
  if(pathname===discoveryAnalyticsPath)return discoveryQueryAllowed(pathname,at<0?'':path.slice(at));
  if(!auditQueryAllowed(pathname,at<0?'':path.slice(at))||!chatReportQueryAllowed(pathname,at<0?'':path.slice(at))||!fileQueryAllowed(pathname,at<0?'':path.slice(at))||!permissionsQueryAllowed(pathname,at<0?'':path.slice(at))||!messagingQueryAllowed(pathname,at<0?'':path.slice(at)))return false;
  return messagingReadPath.test(pathname)||smtpReadPath.test(pathname)||permissionsReadPath.test(pathname)||userReadPath.test(pathname)||pathname==='/v1/operations/session'||new RegExp('^/v1/operations/(?:content/publications|chat-reports)(?:/'+uuid+')?$','i').test(pathname)||new RegExp('^/v1/operations/(?:jobs(?:/(?:'+queues+')/'+uuid+')?|search/failures(?:/'+uuid+')?)$','i').test(pathname)||businessReads.some(pattern=>pattern.test(pathname));
}
// Next may construct Request.url with its internal listen address. The edge
// preserves Host; validate that exact configured host before rebuilding only
// the path/query. Forwarded host/protocol headers never supply this authority.
/** @returns {{allowed:false,status:403|404}|{allowed:true,forwardOrigin:string|null,path:string}} */
export function operationsProxyRequestPolicy({url,method,headers,publicOrigin}){
  const expected=new URL(publicOrigin),incoming=new URL(url);
  if(headers.get('host')!==expected.host)return {allowed:false,status:403};
  return operationsProxyPolicy({url:publicOrigin+incoming.pathname+incoming.search,method,headers,publicOrigin});
}
/** @returns {{allowed:false,status:403|404}|{allowed:true,forwardOrigin:string|null,path:string}} */
export function operationsProxyPolicy({url,method,headers,publicOrigin}){
  const requestUrl=new URL(url),path=requestUrl.pathname;
  if(requestUrl.origin!==publicOrigin)return {allowed:false,status:403};
  if(path==='/v1/operations/web-events'){const params=requestUrl.searchParams;if(requestUrl.search.length>4096||[...params.keys()].some(key=>!['topics','cursor'].includes(key)||params.getAll(key).length!==1)||params.has('cursor')&&!/^[0-9]{1,20}$/.test(params.get('cursor'))||params.has('topics')&&!/^[a-z][a-z0-9-]*(?:,[a-z][a-z0-9-]*)*$/.test(params.get('topics')))return {allowed:false,status:404};}
  const navigation=method==='GET'&&['/v1/operations/login','/v1/operations/callback'].includes(path);
  const publicationPath=new RegExp('^/v1/operations/content/publications(?:/'+uuid+')?$','i');
  const reportRead=chatReportReadPath;
  const reportWrite=new RegExp('^/v1/operations/chat-reports/'+uuid+'/(?:event|attachments/'+uuid+'/content|messages/'+uuid+'/visibility)$','i');
  const taskRead=new RegExp('^/v1/operations/(?:jobs(?:/(?:'+queues+')/'+uuid+')?|search/failures(?:/'+uuid+')?)$','i');
  const taskWrite=new RegExp('^/v1/operations/(?:jobs/(?:'+queues+')/'+uuid+'/(?:cancel|retry)|search/failures/'+uuid+'/retry)$','i');
  const read=method==='GET'&&(path==='/v1/operations/web-events'||(governanceOperationReadPath.test(path)||productChatOperationReadPath.test(path))||fileAccessReadPath.test(path)||fileCleanupReadPath.test(path)||strategiesReadPath.test(path)||ruleSettingsReadPath.test(path)||modelSettingsReadPath.test(path)||maintenanceReadPath.test(path)||searchQualityReadPath.test(path)||recommendationReadPath.test(path)||path===discoveryAnalyticsPath||agentOsReadPath.test(path)||messagingReadPath.test(path)||smtpReadPath.test(path)||permissionsReadPath.test(path)||path==='/v1/operations/session'||publicationPath.test(path)||userReadPath.test(path)||reportRead.test(path)||taskRead.test(path)||businessReads.some(pattern=>pattern.test(path)));
  const write=method==='POST'&&(fileAccessWritePath.test(path)||fileCleanupWritePath.test(path)||strategiesWritePath.test(path)||ruleSettingsWritePath.test(path)||modelSettingsWritePath.test(path)||maintenanceWritePath.test(path)||searchQualityWritePath.test(path)||recommendationWritePath.test(path)||agentOsWritePath.test(path)||messagingWritePath.test(path)||smtpWritePath.test(path)||permissionsWritePath.test(path)||path==='/v1/operations/logout'||path==='/v1/operations/content/publications'||reportWrite.test(path)||taskWrite.test(path)||businessWrites.some(pattern=>pattern.test(path))||new RegExp('^/v1/operations/users/'+uuid+'/(?:restriction(?:/release)?|type-change)$','i').test(path));
  const registeredRead=method==='GET'&&registeredUsersReadPath.test(path);
  const registeredWrite=method==='POST'&&registeredUsersWritePath.test(path);
  const managementRead=method==='GET'&&managementAccountsReadPath.test(path);
  const managementWrite=method==='POST'&&managementAccountsWritePath.test(path);
  const aiWorkRead=method==='GET'&&aiWorkReadPath.test(path),aiWorkWrite=method==='POST'&&aiWorkWritePath.test(path);
  const systemRead=method==='GET'&&systemSettingsReadPath.test(path),systemWrite=method==='POST'&&systemSettingsWritePath.test(path);
  const autonomyRead=method==='GET'&&autonomyReadPath.test(path),autonomyWrite=method==='POST'&&autonomyWritePath.test(path);
  if(!navigation&&!read&&!write&&!registeredRead&&!registeredWrite&&!managementRead&&!managementWrite&&!aiWorkRead&&!aiWorkWrite&&!systemRead&&!systemWrite&&!autonomyRead&&!autonomyWrite)return {allowed:false,status:404};
  if((autonomyRead||autonomyWrite)&&(!autonomyQueryAllowed(path,requestUrl.search)||autonomyWrite&&requestUrl.search))return {allowed:false,status:404};
  if((governanceOperationReadPath.test(path)||productChatOperationReadPath.test(path))&&requestUrl.search)return {allowed:false,status:404};
  if(!summaryQueryAllowed(path,requestUrl.search))return {allowed:false,status:404};
  if((systemRead||systemWrite)&&!systemSettingsQueryAllowed(path,requestUrl.search))return {allowed:false,status:404};
  if((aiWorkRead||aiWorkWrite)&&(!aiWorkQueryAllowed(path,requestUrl.search)||aiWorkWrite&&requestUrl.search))return {allowed:false,status:404};
  if(!registeredUsersQueryAllowed(path,requestUrl.search))return {allowed:false,status:404};
  if(!managementAccountsQueryAllowed(path,requestUrl.search)||managementWrite&&requestUrl.search)return {allowed:false,status:404};
  if((userOperationReadPath.test(path)||new RegExp('^/v1/operations/feedback/'+uuid+'/operations/'+uuid+'$','i').test(path))&&requestUrl.search)return {allowed:false,status:404};
  if((fileAccessReadPath.test(path)||fileAccessWritePath.test(path))&&requestUrl.search)return {allowed:false,status:404};
  if(!fileCleanupQueryAllowed(path,requestUrl.search)||fileCleanupWritePath.test(path)&&write&&requestUrl.search)return {allowed:false,status:404};
  if(!strategiesQueryAllowed(path,requestUrl.search))return {allowed:false,status:404};
  if(!ruleSettingsQueryAllowed(path,requestUrl.search))return {allowed:false,status:404};
  if(!discoveryQueryAllowed(path,requestUrl.search))return {allowed:false,status:404};
  if(!recommendationQueryAllowed(path,requestUrl.search))return {allowed:false,status:404};
  if(!searchQualityQueryAllowed(path,requestUrl.search))return {allowed:false,status:404};
  if(!modelSettingsQueryAllowed(path,requestUrl.search))return {allowed:false,status:404};
  if(!maintenanceQueryAllowed(path,requestUrl.search)||(maintenanceWritePath.test(path)&&write&&requestUrl.search))return {allowed:false,status:404};
  if((agentOsReadPath.test(path)||agentOsWritePath.test(path))&&(!agentOsQueryAllowed(path,requestUrl.search)||write&&requestUrl.search))return {allowed:false,status:404};
  if((reportWrite.test(path)||fileRetryPath.test(path))&&requestUrl.search)return {allowed:false,status:404};
  if((messagingReadPath.test(path)||smtpReadPath.test(path)||messagingWritePath.test(path)||smtpWritePath.test(path))&&(!messagingQueryAllowed(path,requestUrl.search)||write&&requestUrl.search))return {allowed:false,status:404};
  if((permissionsReadPath.test(path)||permissionsWritePath.test(path))&&(!permissionsQueryAllowed(path,requestUrl.search)||write&&requestUrl.search))return {allowed:false,status:404};
  if(read&&(!auditQueryAllowed(path,requestUrl.search)||!chatReportQueryAllowed(path,requestUrl.search)||!fileQueryAllowed(path,requestUrl.search)))return {allowed:false,status:404};
  const origin=headers.get('origin'),sameOrigin=origin===publicOrigin||!origin&&headers.get('sec-fetch-site')==='same-origin';
  if(origin&&origin!==publicOrigin)return {allowed:false,status:403};
  if((write||registeredWrite||managementWrite||aiWorkWrite||systemWrite||autonomyWrite)&&origin!==publicOrigin||!navigation&&!sameOrigin)return {allowed:false,status:403};
  // OIDC callback navigation has its own state binding. A cross-site redirect is
  // forwarded without inventing same-origin proof; the BFF validates that state.
  return {allowed:true,forwardOrigin:sameOrigin?publicOrigin:null,path:path+requestUrl.search};
}
