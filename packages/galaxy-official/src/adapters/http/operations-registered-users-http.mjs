import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {registeredUsersContract,registeredCommandActions} from '../../operations/accounts/registered-schema.mjs';

const root='/v1/operations/registered-users',uuid='([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})';
const target=new RegExp('^'+root+'/'+uuid+'(?:/(commands|history))?$','i'),operation=new RegExp('^'+root+'/operations/'+uuid+'$','i');
function query(url,keys,numbers=[]){
 if(url.search.length>4096)throw new ServiceError('invalid_registered_users_request',400);const result={};
 for(const[key,value]of url.searchParams){if(!keys.includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_registered_users_request',400);result[key]=numbers.includes(key)?Number(value):value;}return result;
}
export async function dispatchOperationsRegisteredUsers({registeredUsers,authorizeOperator,request,requestId,url,send}){
 if(url.pathname!==root&&!url.pathname.startsWith(root+'/'))return false;
 const match=target.exec(url.pathname),receipt=operation.exec(url.pathname),write=request.method==='POST'&&match?.[2]==='commands';
 if(!write&&!(request.method==='GET'&&(url.pathname===root||receipt||match&&match[2]!=='commands'))||url.search&&(write||receipt||match&&!match[2]))throw new ServiceError('not_found',404);
 if(!registeredUsers||typeof authorizeOperator!=='function')throw new ServiceError('operations_authorization_unavailable',503);
 const actor=await authorizeOperator(request,{write,requestId,action:'accounts.registered.read'});let result;
 if(write){const input=await body(request,undefined,{maxBytes:8192});if(!registeredCommandActions[input?.kind])throw new ServiceError('invalid_registered_users_request',400);
  result=await registeredUsers.command(actor,match[1],input,{authorize:()=>authorizeOperator(request,{write:true,requestId})});
 }else if(receipt)result=await registeredUsers.operation(actor,receipt[1]);
 else if(match)result=match[2]==='history'?await registeredUsers.history(actor,match[1],query(url,['after','limit'],['limit'])):await registeredUsers.detail(actor,match[1]);
 else result=await registeredUsers.list(actor,query(url,registeredUsersContract.listQuery,['page','pageSize']));
 send(200,result);return true;
}
