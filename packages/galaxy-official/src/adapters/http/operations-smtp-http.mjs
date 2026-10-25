import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
const root='/v1/operations/smtp';
const operationPath=/^operations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const reads=new Map([['','get'],['identities','get'],['queue','queue'],['bounces','bounces'],['domains','domains'],['tests','tests'],['history','history']]);
const writes=new Map([['settings',['save','smtp.configure']],['tests/connection',['connection','smtp.test.connection']],['tests/delivery',['delivery','smtp.test.delivery']]]);
function query(url,paged){
 if(url.search.length>8192||!paged&&url.search)throw new ServiceError('invalid_smtp_request',400);
 const result={};for(const[key,value]of url.searchParams){if(!['after','limit'].includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_smtp_request',400);result[key]=key==='limit'?Number(value):value;}return result;
}
export async function dispatchOperationsSmtp({operationsSmtp,authorizeOperator,request,requestId,url,send}){
 if(url.pathname!==root&&!url.pathname.startsWith(root+'/'))return false;
 const part=url.pathname===root?'':url.pathname.slice(root.length+1),write=request.method==='POST';
 const operation=operationPath.exec(part),method=write?writes.get(part):request.method==='GET'?(operation?'commandResult':reads.get(part)):null;
 if(!method||write&&url.search)throw new ServiceError('not_found',404);
 if(!operationsSmtp||typeof authorizeOperator!=='function')throw new ServiceError('operations_authorization_unavailable',503);
 const actor=await authorizeOperator(request,{write,requestId,action:write?method[1]:'smtp.read'});
 let result;
 if(write){const input=await body(request,undefined,{maxBytes:16384}),options={authorize:()=>authorizeOperator(request,{write:true,requestId})};result=method[0]==='save'?await operationsSmtp.save(actor,input,options):await operationsSmtp.test(actor,input,{...options,kind:method[0]});}
 else if(operation){query(url,false);result=await operationsSmtp.commandResult(actor,operation[1]);}
 else result=await operationsSmtp[method](actor,query(url,['queue','tests','history'].includes(part)));
 send(200,result);return true;
}
