import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const sectionRoute=new RegExp('^/v1/operations/community/sections/('+uuid+')(?:/(classification|visibility))?$');
const postRoute=new RegExp('^/v1/operations/community/posts/('+uuid+')$');
const reportRoute=new RegExp('^/v1/operations/community/reports/('+uuid+')(?:/(resolve))?$');
const resourceRoute=new RegExp('^/v1/operations/resources/(projects|methods)(?:/('+uuid+')(?:/(visibility))?)?$');
const fileRoute=new RegExp('^/v1/operations/files/(chat|forum)/('+uuid+')(?:/(retry))?$');
function page(url,allowed){const result={};for(const[key,value]of url.searchParams){if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_operations_request');result[key]=key==='limit'?Number(value):value;}return result;}

export async function dispatchOperationsBusiness({operationsCommunity,operationsResources,operationsFiles,authorizeOperator,request,requestId,url,send}){
 const path=url.pathname,summary=path==='/v1/operations/summary',sections=path==='/v1/operations/community/sections',reports=path==='/v1/operations/community/reports',posts=path==='/v1/operations/community/posts',files=path==='/v1/operations/files',
  section=sectionRoute.exec(path),post=postRoute.exec(path),report=reportRoute.exec(path),resource=resourceRoute.exec(path),file=fileRoute.exec(path);
 if(!summary&&!sections&&!reports&&!posts&&!files&&!section&&!post&&!report&&!resource&&!file)return false;
 const write=!!(section?.[2]||report?.[2]||resource?.[3]||file?.[3]);
 if(request.method!==(write?'POST':'GET')||write&&url.search)throw new ServiceError('not_found',404);
 if(typeof authorizeOperator!=='function')throw new ServiceError('business_admin_unavailable',503);
 const service=resource?operationsResources:files||file?operationsFiles:operationsCommunity;
 if(!service)throw new ServiceError('business_admin_unavailable',503);
 const actor=await authorizeOperator(request,{write,requestId});service.require(actor,write);
 let result;
 if(summary){if(url.search)throw new ServiceError('invalid_operations_request');result=await service.summary(actor);}
 else if(sections)result=await service.sections(actor,page(url,['after','limit','state','category']));
 else if(reports)result=await service.reports(actor,page(url,['after','limit','state']));
 else if(posts)result=await service.posts(actor,page(url,['after','limit']));
 else if(files)result=await service.list(actor,page(url,['after','limit','kind','state','processing']));
 else if(resource&&!resource[2])result=await service.list(actor,resource[1],page(url,['after','limit','state']));
 else{
  if(url.search)throw new ServiceError('invalid_operations_request');
  const input=write?await body(request,undefined,{maxBytes:16384}):null;
  if(section)result=section[2]==='classification'?await service.classify(actor,section[1],input):section[2]==='visibility'?await service.sectionVisibility(actor,section[1],input):await service.section(actor,section[1]);
  else if(post)result=await service.post(actor,post[1]);
  else if(report)result=write?await service.resolve(actor,report[1],input):await service.report(actor,report[1]);
  else if(resource)result=write?await service.visibility(actor,resource[1],resource[2],input):await service.get(actor,resource[1],resource[2]);
  else result=write?await service.retry(actor,file[1],file[2],input):await service.get(actor,file[1],file[2]);
 }
 send(200,result);return true;
}
