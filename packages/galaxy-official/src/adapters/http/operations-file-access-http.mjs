import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {operationsFileAccessChangeSchema} from '../../shared/operations-file-access-schema.mjs';

const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const changeRoute=new RegExp('^/v1/operations/files/(chat|forum)/('+uuid+')/access$');
const operationRoute=new RegExp('^/v1/operations/files/access/operations/('+uuid+')$');

// This changes only current access. It is never a revoke, purge, retention
// change, scan bypass, or model/worker capability.
export async function dispatchOperationsFileAccess({operationsFileAccess,authorizeOperator,request,requestId,url,send}){
 const change=changeRoute.exec(url.pathname),operation=operationRoute.exec(url.pathname);
 if(!change&&!operation)return false;
 if(url.search||request.method!==(change?'POST':'GET'))throw new ServiceError('not_found',404);
 if(!operationsFileAccess||typeof authorizeOperator!=='function')throw new ServiceError('operations_file_access_unavailable',503);
 let input,action='files.read';
 if(change){
  // Read credentials/CSRF before accepting a business body. The exact action
  // is checked again after the closed discriminator has been parsed.
  await authorizeOperator(request,{write:true,requestId,action:'files.read'});
  const parsed=operationsFileAccessChangeSchema.safeParse(await body(request,undefined,{maxBytes:8192}));
  if(!parsed.success)throw new ServiceError('invalid_operations_file_access',400);
  input=parsed.data;action=input.action==='stop'?'files.access.stop':'files.access.restore';
 }
 const authorize=()=>authorizeOperator(request,{write:!!change,requestId,action});
 const actor=await authorize();
 const result=change?await operationsFileAccess.change(actor,change[1],change[2],input,{authorize})
  :await operationsFileAccess.operation(actor,operation[1]);
 send(200,result);return true;
}
