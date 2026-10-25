import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {managementContract,managementCommandActions} from '../../operations/accounts/management-schema.mjs';

const root='/v1/operations/management-accounts',id='([a-f0-9]{64})',uuid='([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})';
const target=new RegExp('^'+root+'/'+id+'(?:/(commands|history|assignments))?$'),operation=new RegExp('^'+root+'/operations/'+uuid+'$','i'),
 assignmentOperation=new RegExp('^'+root+'/'+id+'/assignments/operations/'+uuid+'$','i');
const fail=(code='invalid_management_accounts_request',status=400)=>{throw new ServiceError(code,status);};
function query(url,keys,numbers=[]){if(url.search.length>4096)fail();const result={};for(const[key,value]of url.searchParams){
 if(!keys.includes(key)||url.searchParams.getAll(key).length!==1)fail();if(numbers.includes(key)&&!/^\d{1,7}$/.test(value))fail();result[key]=numbers.includes(key)?Number(value):value;}return result;}

export async function dispatchOperationsManagementAccounts({managementAccounts,authorizeOperator,request,requestId,url,send}){
 if(url.pathname!==root&&!url.pathname.startsWith(root+'/'))return false;
 const match=target.exec(url.pathname),receipt=operation.exec(url.pathname),assignmentReceipt=assignmentOperation.exec(url.pathname),
  create=request.method==='POST'&&url.pathname===root,write=create||request.method==='POST'&&['commands','assignments'].includes(match?.[2]),
  read=request.method==='GET'&&(url.pathname===root||receipt||assignmentReceipt||match&&!['commands','assignments'].includes(match[2]));
 if(!write&&!read||url.search&&(write||receipt||assignmentReceipt||match&&!match[2]))fail('not_found',404);
 if(!managementAccounts||typeof authorizeOperator!=='function')fail('operations_authorization_unavailable',503);
 // Authentication/CSRF precede parsing. The domain service then rechecks the
 // exact current action and source before ledger claim and native submission.
 const actor=await authorizeOperator(request,{write,requestId,action:'management.accounts.read'});let result;
 const options={authorize:()=>authorizeOperator(request,{write:true,requestId})};
 if(write){const input=await body(request,undefined,{maxBytes:16384});
  if(create)result=await managementAccounts.create(actor,input,options);
  else if(match[2]==='assignments')result=await managementAccounts.assignment(actor,match[1],input,options);
  else{if(!managementCommandActions[input?.kind])fail();result=await managementAccounts.command(actor,match[1],input,options);}
 }else if(receipt)result=await managementAccounts.operation(actor,receipt[1]);
 else if(assignmentReceipt)result=await managementAccounts.assignmentOperation(actor,assignmentReceipt[1],assignmentReceipt[2]);
 else if(match)result=match[2]==='history'?await managementAccounts.history(actor,match[1],query(url,managementContract.historyQuery,['limit'])):await managementAccounts.detail(actor,match[1]);
 else result=await managementAccounts.list(actor,query(url,managementContract.listQuery,['page','pageSize']));
 send(200,result);return true;
}
