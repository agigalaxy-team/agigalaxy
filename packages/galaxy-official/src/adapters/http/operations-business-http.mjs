import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {governanceCommandResult} from '../../operations/governance-command-receipts.mjs';

const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const sectionRoute=new RegExp('^/v1/operations/community/sections/('+uuid+')(?:/(classification|visibility))?$');
const postRoute=new RegExp('^/v1/operations/community/posts/('+uuid+')$');
const reportRoute=new RegExp('^/v1/operations/community/reports/('+uuid+')(?:/(resolve))?$');
const resourceRoute=new RegExp('^/v1/operations/resources/(projects|methods)(?:/('+uuid+')(?:/(visibility))?)?$');
const fileRoute=new RegExp('^/v1/operations/files/(chat|forum)/('+uuid+')(?:/(retry))?$');
const communityOperationRoute=new RegExp('^/v1/operations/community/(sections|reports)/('+uuid+')/operations/('+uuid+')$');
const resourceOperationRoute=new RegExp('^/v1/operations/resources/(projects|methods)/('+uuid+')/operations/('+uuid+')$');
function page(url,allowed){const result={};for(const[key,value]of url.searchParams){if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_operations_request');result[key]=key==='limit'?Number(value):value;}return result;}
function filePage(url,allowed){if(url.search.length>8192)throw new ServiceError('invalid_operations_request');return page(url,allowed);}

export async function dispatchOperationsBusiness({operationsCommunity,operationsResources,operationsFiles,authorizeOperator,request,response,requestId,url,send}){
 const communityOperation=communityOperationRoute.exec(url.pathname),resourceOperation=resourceOperationRoute.exec(url.pathname);
 if(communityOperation||resourceOperation){
  if(request.method!=='GET'||url.search)throw new ServiceError('not_found',404);
  const service=resourceOperation?operationsResources:operationsCommunity;
  if(!service||typeof authorizeOperator!=='function')throw new ServiceError('business_admin_unavailable',503);
  const match=resourceOperation??communityOperation,action=resourceOperation?'resources.read':match[1]==='reports'?'cases.read':'sections.read';
  const authorize=()=>authorizeOperator(request,{write:false,requestId,action}),actor=await authorize();service.require(actor,false);
  const scope=resourceOperation?{family:'resource',kind:match[1],id:match[2]}:{family:match[1]==='reports'?'case':'section',id:match[2]};
  const result=await governanceCommandResult({db:service.db,endpoint:service.endpoint,operator:actor,authorize,now:service.now},match[3],scope);
  response?.setHeader('Cache-Control','no-store');send(200,result);return true;
 }
 const path=url.pathname,summary=path==='/v1/operations/summary',sections=path==='/v1/operations/community/sections',reports=path==='/v1/operations/community/reports',posts=path==='/v1/operations/community/posts',files=path==='/v1/operations/files',fileSummary=path==='/v1/operations/files/summary',
  section=sectionRoute.exec(path),post=postRoute.exec(path),report=reportRoute.exec(path),resource=resourceRoute.exec(path),file=fileRoute.exec(path);
 if(!summary&&!sections&&!reports&&!posts&&!files&&!fileSummary&&!section&&!post&&!report&&!resource&&!file)return false;
 const write=!!(section?.[2]||report?.[2]||resource?.[3]||file?.[3]);
 if(request.method!==(write?'POST':'GET')||write&&url.search)throw new ServiceError('not_found',404);
 if(typeof authorizeOperator!=='function')throw new ServiceError('business_admin_unavailable',503);
 const service=resource?operationsResources:files||fileSummary||file?operationsFiles:operationsCommunity;
 if(!service)throw new ServiceError('business_admin_unavailable',503);
  const required=summary?'workbench.read':sections||section&&!write?'sections.read':section?.[2]==='classification'?'sections.classify'
   :reports||report&&!write?'cases.read':report&&write?'cases.resolve':posts||post?'content.read':resource&&!write?'resources.read':files||fileSummary||file&&!write?'files.read':undefined;
  const actor=await authorizeOperator(request,{write,requestId,action:required});service.require(actor,write);
 let result;
 if(summary){const query=page(url,['publicActivity']);if(query.publicActivity!==undefined&&query.publicActivity!=='deferred')throw new ServiceError('invalid_operations_request');result=await service.summary(actor,query);}
 else if(sections)result=await service.sections(actor,page(url,['after','limit','state','category']));
 else if(reports)result=await service.reports(actor,page(url,['after','limit','state']));
 else if(posts)result=await service.posts(actor,page(url,['after','limit']));
 else if(files)result=await service.list(actor,filePage(url,['after','limit','kind','state','processing','issue']));
 else if(fileSummary)result=await service.summary(actor,filePage(url,['kind','state','processing','issue']));
 else if(resource&&!resource[2])result=await service.list(actor,resource[1],page(url,['after','limit','state']));
 else{
  if(url.search)throw new ServiceError('invalid_operations_request');
  const input=write?await body(request,undefined,{maxBytes:16384}):null;
  if(section)result=section[2]==='classification'?await service.classify(actor,section[1],input):section[2]==='visibility'?await service.sectionVisibility(actor,section[1],input):await service.section(actor,section[1]);
  else if(post)result=await service.post(actor,post[1]);
  else if(report)result=write?await service.resolve(actor,report[1],input):await service.report(actor,report[1]);
  else if(resource)result=write?await service.visibility(actor,resource[1],resource[2],input):await service.get(actor,resource[1],resource[2]);
    else result=write?await service.retry(actor,file[1],file[2],input,{authorize:()=>authorizeOperator(request,{write:true,requestId,action:'files.scan.retry'})}):await service.get(actor,file[1],file[2]);
 }
 send(200,result);return true;
}
