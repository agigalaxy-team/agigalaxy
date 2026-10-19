import {ServiceError} from '../../shared/service-error.mjs';
import * as z from 'zod/v4';
import {forumEnvelopeSchema,forumReportEventSchema,parseForumPayload} from '../../shared/community-forum-v1-schema.mjs';
import {body,authenticate,recordBodyBytes} from './request.mjs';

// Only this bounded forum envelope permits the larger adopted UTF-8 payload.
// Every other endpoint retains request.mjs's original 32768-byte parser.
async function envelope(request,policy,{account=false}={}){
 if(request.headers['content-type']!=='application/json'||request.headers['content-encoding'])throw new ServiceError('unsupported_media_type',415);
 const chunks=[];let size=0;const limit=policy.maxPayloadBytes*2+20480;
 for await(const chunk of request){size+=chunk.length;recordBodyBytes(request,chunk.length);if(size>limit)throw new ServiceError('request_too_large',413);chunks.push(chunk);}
 let input;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks)));}catch{throw new ServiceError('invalid_json');}
 const parsed=forumEnvelopeSchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_forum_request');
 if(account?parsed.data.signedIntent!==undefined:typeof parsed.data.signedIntent!=='string')throw new ServiceError('invalid_forum_request');
 if(Buffer.byteLength(parsed.data.payloadJson,'utf8')>policy.maxPayloadBytes)throw new ServiceError('forum_payload_too_large',413);return parsed.data;
}
async function actorFor(request,access,requestId,scope='assistance',either=false,officialAccounts=null){
 if(request.headers.authorization===undefined&&officialAccounts){
  const actor=await officialAccounts.actionActor(request,{write:request.method!=='GET'});
  return {...actor,httpRequestId:requestId};
 }
 let actor;try{actor=await authenticate(request,access,scope);}catch(error){if(!either||error.code!=='access_denied')throw error;actor=await authenticate(request,access,'moderation');}
 const accountId=request.headers['x-galaxy-account-id'];if(accountId!==undefined&&!z.uuid().safeParse(accountId).success)throw new ServiceError('invalid_account_target');
 return {...actor,httpRequestId:requestId,...(accountId?{accountId}:{})};
}
async function readActorFor(request,access,requestId,officialAccounts){
 // An invalid ID credential retains the anonymous public reading path. It
 // never falls back to the browser's different signed-in account.
 if(request.headers.authorization!==undefined){
  let actor;try{actor=await authenticate(request,access,'binding');}catch(error){if(error.code==='access_denied')return null;throw error;}
  const accountId=request.headers['x-galaxy-account-id'];if(accountId!==undefined&&!z.uuid().safeParse(accountId).success)throw new ServiceError('invalid_account_target');
  return {...actor,httpRequestId:requestId,...(accountId?{accountId}:{})};
 }
 if(request.headers['x-galaxy-account-id']!==undefined&&officialAccounts)return {...await officialAccounts.actionActor(request,{write:false}),httpRequestId:requestId};
 return null;
}
export async function dispatchCommunityForum({forum,forumGovernance,access,officialAccounts,request,requestId,url,send,consumeSearchPage=()=>{}}){
 if(!forum||!url.pathname.startsWith('/v2/community/'))return false;
 const path=url.pathname,method=request.method;
 if(method==='GET'&&path==='/v2/community/topics'){send(200,forum.topics());return true;}
 if(method==='GET'&&path==='/v2/community/access-options'){send(200,await forum.accessRules.options());return true;}
 if(method==='POST'&&path==='/v2/community/accounts/query'){
  const actor=await readActorFor(request,access,requestId,officialAccounts),input=await body(request,null);consumeSearchPage(actor,input.after);
  send(200,await forum.accountChoices(actor,input));return true;
 }
 const section=/^\/v2\/community\/sections\/([0-9a-f-]{36})$/.exec(path),classification=/^\/v2\/community\/sections\/([0-9a-f-]{36})\/classification$/.exec(path);
 if(method==='GET'&&(section||path==='/v2/community/sections')){
  const actor=await readActorFor(request,access,requestId,officialAccounts),input={...(url.searchParams.has('after')?{after:url.searchParams.get('after')}:{}),...(url.searchParams.has('limit')?{limit:Number(url.searchParams.get('limit'))}:{})};
  send(200,await(section?forum.sections.get(actor,section[1]):forum.sections.query(actor,input)));return true;
 }
 if(method==='POST'&&path==='/v2/community/sections/query'){
  const actor=await readActorFor(request,access,requestId,officialAccounts),input=await body(request,null);consumeSearchPage(actor,input.after);send(200,await forum.sections.query(actor,input));return true;
 }
 if(method==='POST'&&(path==='/v2/community/sections'||classification)){
  const actor=await actorFor(request,access,requestId,classification?'moderation':'assistance',false,classification?null:officialAccounts),input=await envelope(request,forum.policy,{account:actor.kind==='official-account'});
  if(classification){let value;try{value=JSON.parse(input.payloadJson);}catch{throw new ServiceError('invalid_forum_payload');}if(value.sectionId!==classification[1])throw new ServiceError('forum_event_route_mismatch');}
  send(200,await(classification?forum.sections.classify(actor,input):forum.sections.save(actor,input)));return true;
 }
 if(method==='POST'&&['/v2/community/notifications/query','/v2/community/notifications/read'].includes(path)){
  const actor=await actorFor(request,access,requestId,'assistance',false,officialAccounts),input=await body(request,null);
  if(path.endsWith('/query'))consumeSearchPage(actor,input.after);
  send(200,await(path.endsWith('/query')?forum.notifications(actor,input):forum.markNotificationRead(actor,input)));return true;
 }
 // Public content remains anonymously readable with stale credentials. A
 // current, explicitly selected account additionally supplies its read scope.
 const post=/^\/v2\/community\/posts\/([0-9a-f-]{36})$/.exec(path),
  version=/^\/v2\/community\/posts\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})$/.exec(path),
  versions=/^\/v2\/community\/posts\/([0-9a-f-]{36})\/versions$/.exec(path),
  reply=/^\/v2\/community\/replies\/([0-9a-f-]{36})$/.exec(path),
  owned=/^\/v2\/community\/posts\/([0-9a-f-]{36})\/owned$/.exec(path),ownedReply=/^\/v2\/community\/replies\/([0-9a-f-]{36})\/owned$/.exec(path),
  permit=/^\/v2\/community\/permissions\/([0-9a-f-]{36})$/.exec(path),
  report=/^\/v2\/community\/reports\/([0-9a-f-]{36})(?:\/(events|appeal))?$/.exec(path);
 if(method==='GET'&&(post||version||reply)){
  const actor=await readActorFor(request,access,requestId,officialAccounts);
  send(200,await(version?forum.getVersion(version[1],version[2],actor):reply?forum.getReply(reply[1],actor):forum.getPost(post[1],actor)));return true;
 }
 if(method==='POST'&&(versions||['/v2/community/posts/query','/v2/community/replies/query'].includes(path))){
  const actor=await readActorFor(request,access,requestId,officialAccounts),input=await body(request,null);consumeSearchPage(actor,input.after??input.afterVersion);
  send(200,await(versions?forum.versions(versions[1],input,actor):path.includes('/posts/')?forum.query(input,actor):forum.replies(input,actor)));return true;
 }
 if(method==='GET'&&(owned||ownedReply||permit)){
  const actor=await actorFor(request,access,requestId,'assistance',!!permit,officialAccounts);send(200,await(owned?forum.ownedPost(actor,owned[1]):ownedReply?forum.ownedReply(actor,ownedReply[1]):forum.permissions.detail(actor,permit[1])));return true;
 }
 if(method==='POST'&&path==='/v2/community/posts/owned'){
  const actor=await actorFor(request,access,requestId,'assistance',false,officialAccounts),input=await body(request,null);consumeSearchPage(actor,input.after);send(200,await forum.owned(actor,input));return true;
 }
 if((method==='POST'&&path==='/v2/community/receipt')||(method==='GET'&&path==='/v2/community/quotas')){
  const actor=await actorFor(request,access,requestId,'assistance',true,officialAccounts);send(200,await(method==='GET'?forum.budget.status(actor,Object.fromEntries(url.searchParams)):forum.receipt(actor,await body(request,null))));return true;
 }
 if(method==='POST'&&['/v2/community/posts','/v2/community/replies','/v2/community/posts/withdraw','/v2/community/versions/withdraw','/v2/community/replies/withdraw'].includes(path)){
  const actor=await actorFor(request,access,requestId,'assistance',false,officialAccounts),input=await envelope(request,forum.policy,{account:actor.kind==='official-account'});
  send(200,await(path==='/v2/community/posts'?forum.publish(actor,input):path==='/v2/community/replies'?forum.createReply(actor,input):forum.withdraw(actor,path.includes('/versions/')?'withdraw-version':path.includes('/replies/')?'withdraw-reply':'withdraw-post',input)));return true;
 }
 if(!forumGovernance)return false;
 if(method==='POST'&&['/v2/community/reports/config','/v2/community/reports/query','/v2/community/affected-events/query'].includes(path)){
  const actor=await actorFor(request,access,requestId,'assistance',true,officialAccounts),input=await body(request,null);
  if(path.endsWith('/query'))consumeSearchPage(actor,input.after);
  send(200,await(path.endsWith('/config')?forumGovernance.config(actor,input):path.includes('/affected-events/')?forumGovernance.affected(actor,input):forumGovernance.query(actor,input)));return true;
 }
 if(method==='GET'&&report&&!report[2]){
  const actor=await actorFor(request,access,requestId,'assistance',true,officialAccounts);send(200,await forumGovernance.get(actor,report[1]));return true;
 }
 if(method==='POST'&&(report?.[2]||['/v2/community/reports','/v2/community/reports/withdraw'].includes(path))){
  const input=await envelope(request,forum.policy,{account:request.headers.authorization===undefined&&!!officialAccounts});
  if(path==='/v2/community/reports'){const actor=await actorFor(request,access,requestId,'assistance',false,officialAccounts);send(200,await forumGovernance.report(actor,input));return true;}
  const p=parseForumPayload(input.payloadJson,forumReportEventSchema,forum.policy.maxPayloadBytes);
  if(path.endsWith('/appeal')&&p.kind!=='appeal'||path==='/v2/community/reports/withdraw'&&p.kind!=='withdraw'||report?.[2]==='events'&&!['supplement','resolve'].includes(p.kind))throw new ServiceError('forum_event_route_mismatch');
  const actor=await actorFor(request,access,requestId,p.kind==='resolve'?'moderation':'assistance',false,officialAccounts);send(200,await forumGovernance.event(actor,report?.[1]??p.reportId,input));return true;
 }
 return false;
}
