import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {governanceCommandResult} from '../../operations/governance-command-receipts.mjs';

const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
 targetRoute=new RegExp('^/v1/operations/community/content/(post|reply)/('+uuid+')(?:/(visibility|curation))?$','i'),
 attachmentRoute=new RegExp('^/v1/operations/community/content/(post|reply)/('+uuid+')/attachments/('+uuid+')/content$','i'),
 tagRoute=new RegExp('^/v1/operations/community/tags/('+uuid+')$','i');
const contentOperationRoute=new RegExp('^/v1/operations/community/content/(?:(post|reply)/('+uuid+')/)?operations/('+uuid+')$','i');
const tagOperationRoute=new RegExp('^/v1/operations/community/tags/operations/('+uuid+')$','i');
function query(url,allowed){const result={};for(const[key,value]of url.searchParams){
 if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_operations_request',400);
 if(['pinned','featured'].includes(key)){if(!['true','false'].includes(value))throw new ServiceError('invalid_operations_request',400);result[key]=value==='true';}
 else result[key]=key==='limit'||key==='days'&&value!=='all'?Number(value):value;
}return result;}
export async function dispatchOperationsForumContent({operationsCommunity,authorizeOperator,request,response,requestId,url,send}){
 const contentOperation=contentOperationRoute.exec(url.pathname),tagOperation=tagOperationRoute.exec(url.pathname);
 if(contentOperation||tagOperation){
  if(request.method!=='GET'||url.search)throw new ServiceError('not_found',404);
  const service=operationsCommunity?.content;
  if(!service||typeof authorizeOperator!=='function')throw new ServiceError('business_admin_unavailable',503);
  const authorize=()=>authorizeOperator(request,{write:false,requestId,action:tagOperation?'content.tags.read':'content.read'}),actor=await authorize();service.require(actor,false);
  const scope=tagOperation?{family:'tag'}:contentOperation[1]?{family:'content',kind:contentOperation[1],id:contentOperation[2]}:{family:'batch'};
  const result=await governanceCommandResult({db:service.db,endpoint:service.endpoint,operator:actor,authorize,now:service.now},tagOperation?.[1]??contentOperation[3],scope);
  response?.setHeader('Cache-Control','no-store');send(200,result);return true;
 }
 const attachment=attachmentRoute.exec(url.pathname);
 if(attachment){
  if(request.method!=='POST'||url.search)throw new ServiceError('not_found',404);
  const service=operationsCommunity?.content;if(!service||typeof authorizeOperator!=='function')throw new ServiceError('business_admin_unavailable',503);
   const authorize=()=>authorizeOperator(request,{write:false,csrf:true,requestId,action:'content.read'}),actor=await authorize();service.require(actor,false);await body(request,[]);
  const file=await service.attachmentContent(actor,attachment[1],attachment[2],attachment[3],{authorize});
  response.statusCode=200;response.setHeader('Content-Type','application/octet-stream');response.setHeader('Content-Length',file.bytes.length);
  response.setHeader('Content-Disposition',"attachment; filename=\"galaxy-content-attachment\"; filename*=UTF-8''"+encodeURIComponent(file.name).replace(/[!'()*]/g,character=>'%'+character.charCodeAt(0).toString(16).toUpperCase()));
  response.setHeader('Cache-Control','private, no-store');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('X-Galaxy-Content-Sha256',file.sha256);response.end(file.bytes);return true;
 }
 const list=url.pathname==='/v1/operations/community/content',tags=url.pathname==='/v1/operations/community/tags',target=targetRoute.exec(url.pathname),tag=tagRoute.exec(url.pathname),
  preview=url.pathname==='/v1/operations/community/content/visibility/preview',batch=url.pathname==='/v1/operations/community/content/visibility/batch';
 if(!list&&!tags&&!target&&!tag&&!preview&&!batch)return false;
 const post=!!target?.[3]||preview||batch||!!tag||tags&&request.method==='POST',write=post&&!preview;
 if(request.method!==(post?'POST':'GET')||post&&url.search)throw new ServiceError('not_found',404);
 const service=operationsCommunity?.content;if(!service||typeof authorizeOperator!=='function')throw new ServiceError('business_admin_unavailable',503);
 const required=tags||tag?(write?'content.tags.manage':'content.tags.read'):target?.[3]==='curation'?'content.curate':!write?'content.read':undefined;
 const actor=await authorizeOperator(request,{write,requestId,action:required});service.require(actor,write);
 let result;
 if(list)result=await service.list(actor,query(url,['query','targetId','kind','topic','visibility','pinned','featured','days','after','limit']));
 else if(target&&!post)result=await service.get(actor,target[1],target[2],query(url,['historyAfter']));
 else if(tags&&!post){if(url.search)throw new ServiceError('invalid_operations_request');result=await service.tags(actor);}
 else{const input=await body(request,undefined,{maxBytes:32768});
  if(target)result=await service[target[3]==='curation'?'curate':'visibility'](actor,target[1],target[2],input);
  else if(preview)result=await service.preview(actor,input);else if(batch)result=await service.batch(actor,input);
  else result=await service.tag(actor,tag?.[1]??null,input);
 }
 send(200,result);return true;
}
