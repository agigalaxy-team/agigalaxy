import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const planRoute=new RegExp('^/v1/operations/files/cleanup/plans/('+uuid+')(?:/(approve|cancel))?$');
const operationRoute=new RegExp('^/v1/operations/files/cleanup/operations/('+uuid+')$');
function query(url,allowed){
 if(url.search.length>4096)throw new ServiceError('invalid_operations_request',400);
 const value={};for(const[key,item]of url.searchParams){
  if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_operations_request',400);
  value[key]=key==='limit'?Number(item):item;
 }return value;
}

// Only concrete human-approved plans are exposed. There is no general erase
// endpoint, direct worker trigger, arbitrary storage key or model permission.
export async function dispatchOperationsFileCleanup({operationsFileCleanup,authorizeOperator,request,requestId,url,send}){
 const path=url.pathname,candidates=path==='/v1/operations/files/cleanup/candidates',plans=path==='/v1/operations/files/cleanup/plans',plan=planRoute.exec(path),operation=operationRoute.exec(path);
 if(!candidates&&!plans&&!plan&&!operation)return false;
 const create=plans&&request.method==='POST',decision=plan?.[2],write=!!(create||decision);
 if(request.method!==(write?'POST':'GET')||write&&url.search)throw new ServiceError('not_found',404);
 const input=query(url,candidates?['kind','after','limit']:plans&&!write?['after','limit']:[]);
 if(!operationsFileCleanup||typeof authorizeOperator!=='function')throw new ServiceError('operations_file_cleanup_unavailable',503);
 const action=decision==='approve'?'files.cleanup.approve':write?'files.cleanup.plan':'files.read';
 const authorize=()=>authorizeOperator(request,{write,requestId,action});
 const actor=await authorize();let result;
 if(create)result=await operationsFileCleanup.create(actor,await body(request,undefined,{maxBytes:262144}),{authorize});
 else if(decision)result=await operationsFileCleanup[decision](actor,plan[1],await body(request,undefined,{maxBytes:2048}),{authorize});
 else if(candidates)result=await operationsFileCleanup.candidates(actor,input);
 else if(plans)result=await operationsFileCleanup.plans(actor,input);
 else if(plan)result=await operationsFileCleanup.plan(actor,plan[1]);
 else result=await operationsFileCleanup.operation(actor,operation[1]);
 send(200,result);return true;
}
