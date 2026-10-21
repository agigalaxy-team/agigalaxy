const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const userReadPath=new RegExp('^/v1/operations/users(?:/'+uuid+'(?:/(?:audit|links|type-history))?)?$','i');
const queues='information-watch|search-recovery|content-publication|account-notice|retention-cleanup';
const businessReads=[
  '^/v1/operations/(?:summary|audit)$',
  '^/v1/operations/community/(?:sections|reports|posts)(?:/'+uuid+')?$',
  '^/v1/operations/resources/(?:projects|methods)(?:/'+uuid+')?$',
  '^/v1/operations/files(?:/(?:chat|forum)/'+uuid+')?$',
  '^/v1/operations/notices(?:/'+uuid+')?$',
  '^/v1/operations/rules(?:/(?:resource-budget|community-quota|forum-quota)(?:/history)?)?$',
  '^/v1/operations/retention(?:/runs(?:/'+uuid+')?)?$',
].map(value=>new RegExp(value,'i'));
const businessWrites=[
  '^/v1/operations/community/sections/'+uuid+'/(?:classification|visibility)$',
  '^/v1/operations/community/reports/'+uuid+'/resolve$',
  '^/v1/operations/resources/(?:projects|methods)/'+uuid+'/visibility$',
  '^/v1/operations/files/(?:chat|forum)/'+uuid+'/retry$',
  '^/v1/operations/notices(?:/'+uuid+'/(?:save|publish|withdraw))?$',
  '^/v1/operations/rules/(?:resource-budget|community-quota|forum-quota)$',
  '^/v1/operations/retention/runs$',
].map(value=>new RegExp(value,'i'));
export function operationsReadPath(path){
  if(typeof path!=='string'||!path.startsWith('/v1/operations/')||path.includes('#'))return false;
  const pathname=path.split('?')[0];
  return userReadPath.test(pathname)||pathname==='/v1/operations/session'||new RegExp('^/v1/operations/(?:content/publications|chat-reports)(?:/'+uuid+')?$','i').test(pathname)||new RegExp('^/v1/operations/(?:jobs(?:/(?:'+queues+')/'+uuid+')?|search/failures(?:/'+uuid+')?)$','i').test(pathname)||businessReads.some(pattern=>pattern.test(pathname));
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
  const navigation=method==='GET'&&['/v1/operations/login','/v1/operations/callback'].includes(path);
  const publicationPath=new RegExp('^/v1/operations/content/publications(?:/'+uuid+')?$','i');
  const reportRead=new RegExp('^/v1/operations/chat-reports(?:/'+uuid+')?$','i');
  const reportWrite=new RegExp('^/v1/operations/chat-reports/'+uuid+'/(?:event|attachments/'+uuid+'/content)$','i');
  const taskRead=new RegExp('^/v1/operations/(?:jobs(?:/(?:'+queues+')/'+uuid+')?|search/failures(?:/'+uuid+')?)$','i');
  const taskWrite=new RegExp('^/v1/operations/(?:jobs/(?:'+queues+')/'+uuid+'/(?:cancel|retry)|search/failures/'+uuid+'/retry)$','i');
  const read=method==='GET'&&(path==='/v1/operations/session'||publicationPath.test(path)||userReadPath.test(path)||reportRead.test(path)||taskRead.test(path)||businessReads.some(pattern=>pattern.test(path)));
  const write=method==='POST'&&(path==='/v1/operations/logout'||path==='/v1/operations/content/publications'||reportWrite.test(path)||taskWrite.test(path)||businessWrites.some(pattern=>pattern.test(path))||new RegExp('^/v1/operations/users/'+uuid+'/(?:restriction(?:/release)?|type-change)$','i').test(path));
  if(!navigation&&!read&&!write)return {allowed:false,status:404};
  const origin=headers.get('origin'),sameOrigin=origin===publicOrigin||!origin&&headers.get('sec-fetch-site')==='same-origin';
  if(origin&&origin!==publicOrigin)return {allowed:false,status:403};
  if(write&&origin!==publicOrigin||!navigation&&!sameOrigin)return {allowed:false,status:403};
  // OIDC callback navigation has its own state binding. A cross-site redirect is
  // forwarded without inventing same-origin proof; the BFF validates that state.
  return {allowed:true,forwardOrigin:sameOrigin?publicOrigin:null,path:path+requestUrl.search};
}
