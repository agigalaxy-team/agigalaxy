import {authenticate,body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

export async function chatHttpActor({request,access,officialAccounts,requestId,write}){
  const actor=request.headers.authorization!==undefined
    ?await authenticate(request,access,'binding')
    :officialAccounts?await officialAccounts.actionActor(request,{write}):await authenticate(request,access,'binding');
  const target=request.headers['x-galaxy-account-id'];
  if(actor.kind!=='official-account'&&target!==undefined&&
    (typeof target!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(target)))throw new ServiceError('invalid_account_target',400);
  return {...actor,httpRequestId:requestId,...(actor.kind!=='official-account'&&target?{accountId:target}:{})};
}
const globalMethods={
 '/v2/chat/rooms/create':['create',true],'/v2/chat/rooms/query':['list',false],'/v2/chat/rooms/directory':['directory',false],
 '/v2/chat/accounts/query':['people',false],'/v2/chat/invitations/query':['invitations',false],'/v2/chat/export/owned':['exportOwned',false]
};
const roomMethods={read:'get',history:'history',decisions:'decisions',propose:'proposeDecision',vote:'voteDecision',accept:'acceptInvite',
 leave:'leave',dismiss:'dismissDecision',send:'send',receipt:'messageStatus','operation-receipt':'operationStatus',cursor:'cursor',
 'agent-grants':'queryAgentGrants','agent-participants':'queryAgentParticipants','agent-grant':'grantAgent','agent-revoke':'revokeAgent','join-preview':'joinPreview',join:'join'};
const readMethods=new Set(['read','history','decisions','receipt','operation-receipt','agent-grants','agent-participants','join-preview']);
export async function dispatchChat({chat,access,officialAccounts,request,requestId,url,send}){
  if(!chat||request.method!=='POST'||!url.pathname.startsWith('/v2/chat/'))return false;
  // Separate attachment/shared-summary dispatchers retain their own protocol.
  if(url.pathname.startsWith('/v2/chat/attachments/')||url.pathname.startsWith('/v2/chat/shared-summaries/'))return false;
  const global=globalMethods[url.pathname],room=/^\/v2\/chat\/rooms\/([0-9a-f-]{36})\/([a-z-]+)$/.exec(url.pathname),
    message=/^\/v2\/chat\/rooms\/([0-9a-f-]{36})\/messages\/([0-9a-f-]{36})\/(edit|retract|hide|context)$/.exec(url.pathname);
  const write=global?global[1]:message?message[3]!=='context':!readMethods.has(room?.[2]);
  const actor=await chatHttpActor({request,access,officialAccounts,requestId,write}),input=await body(request,null);
  if(global){send(200,await chat[global[0]](actor,input));return true;}
  if(room&&roomMethods[room[2]]){send(200,await chat[roomMethods[room[2]]](actor,room[1],input));return true;}
  if(message){send(200,await chat[message[3]==='context'?'messageContext':message[3]](actor,message[1],message[2],input));return true;}
  throw new ServiceError('not_found',404);
}
