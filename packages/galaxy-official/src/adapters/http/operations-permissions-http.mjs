import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

const root='/v1/operations/permissions';
const rolePath=/^\/v1\/operations\/permissions\/roles\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const operationPath=/^\/v1\/operations\/permissions\/operations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const delegationOperationPath=/^\/v1\/operations\/permissions\/ai-delegation\/operations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const reads=new Map([['catalog','catalog'],['catalog/lease','catalogLease'],['roles','roles'],['personnel','personnel'],['automation','automation'],['history','history'],['ai-delegation','delegation']]);
const writes=new Map([['roles',['saveRole','permissions.roles.write']],['assignments',['saveAssignment','permissions.assignments.write']],['automation',['saveAutomation','permissions.automation.write']],['ai-delegation',['saveDelegation','ai.delegation.configure']]]);
function historyQuery(url){
 if(url.search.length>8192)throw new ServiceError('invalid_operations_permissions_request',400);
 const result={};for(const[key,value]of url.searchParams){
  if(!['after','limit','resourceId','targetOperatorId'].includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_operations_permissions_request',400);
  result[key]=key==='limit'?Number(value):value;
 }return result;
}

export async function dispatchOperationsPermissions({operationsPermissions,authorizeOperator,request,requestId,url,send}){
 if(url.pathname!==root&&!url.pathname.startsWith(root+'/'))return false;
 const role=rolePath.exec(url.pathname),operation=operationPath.exec(url.pathname),delegationOperation=delegationOperationPath.exec(url.pathname),part=url.pathname.slice(root.length+1),write=request.method==='POST';
 const method=write?writes.get(part)?.[0]:request.method==='GET'?(delegationOperation?'delegationOperation':operation?'operation':role?'role':reads.get(part)):null;
 if(method==='catalogLease'&&(url.searchParams.size!==1||! /^[a-f0-9]{64}$/.test(url.searchParams.get('version')??'')))throw new ServiceError('invalid_operations_permissions_request',400);
 if(!method||url.search&&(!['history','catalogLease'].includes(method)||write))throw new ServiceError('not_found',404);
 if(!operationsPermissions||typeof authorizeOperator!=='function')throw new ServiceError('operations_authorization_unavailable',503);
 const actor=await authorizeOperator(request,{write,requestId,action:write?writes.get(part)[1]:method==='delegation'||method==='delegationOperation'?'ai.delegation.read':'permissions.read'});
 let result;
 if(write){
  const input=await body(request,undefined,{maxBytes:32768});
  // Only authenticate inside the callback. The command checks its exact action
  // on the pinned transaction, including before returning a stable receipt.
  const authorize=()=>authorizeOperator(request,{write:true,requestId});
  result=await operationsPermissions[method](actor,input,{authorize});
 }else result=method==='catalogLease'?await operationsPermissions.catalogLease(actor,url.searchParams.get('version')):delegationOperation?await operationsPermissions.delegationOperation(actor,delegationOperation[1]):operation?await operationsPermissions.operation(actor,operation[1]):role?await operationsPermissions.role(actor,role[1]):method==='history'?await operationsPermissions.history(actor,historyQuery(url)):await operationsPermissions[method](actor);
 send(200,result);return true;
}
