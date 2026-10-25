import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {aiWorkActions,aiWorkAssignmentSchema,aiWorkCommandSchema,aiWorkHistorySchema,aiWorkParse} from '../../operations/accounts/ai-work-schema.mjs';

const root='/v1/operations/ai-work-accounts',domain='(overview|governance|messaging|discovery|maintenance)',uuid='([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})';
const target=new RegExp('^'+root+'/'+domain+'(?:/(history|commands|assignments))?$'),operation=new RegExp('^'+root+'/operations/'+uuid+'$');
const fail=(code='not_found',status=404)=>{throw new ServiceError(code,status);};
function historyQuery(url){
 if(url.search.length>1024)fail('invalid_operations_ai_work_request',400);
 const value={};for(const[key,input]of url.searchParams){if(!['after','limit'].includes(key)||url.searchParams.getAll(key).length!==1)fail('invalid_operations_ai_work_request',400);value[key]=input;}
 return aiWorkParse(aiWorkHistorySchema,value);
}

/** Current verified human and CSRF first; exact live action and CAS remain
 * in the actual domain service. No initialization or automatic grant write. */
export async function dispatchOperationsAiWorkAccounts({aiWorkAccounts,authorizeOperator,request,requestId,url,send}){
 if(url.pathname!==root&&!url.pathname.startsWith(root+'/'))return false;
 const match=target.exec(url.pathname),receipt=operation.exec(url.pathname);
 const write=request.method==='POST'&&match&&['commands','assignments'].includes(match[2]);
 const read=request.method==='GET'&&(url.pathname===root||receipt||match&&(!match[2]||match[2]==='history'));
 if(!read&&!write||url.search&&(write||receipt||url.pathname===root||match&&!match[2]))fail();
 if(!aiWorkAccounts||typeof authorizeOperator!=='function')fail('operations_ai_work_unavailable',503);
 let actor=await authorizeOperator(request,{write:!!write,requestId,action:aiWorkActions.read}),result;
 if(write){
  const input=aiWorkParse(match[2]==='assignments'?aiWorkAssignmentSchema:aiWorkCommandSchema,await body(request,undefined,{maxBytes:8192}));
  const authorize=()=>authorizeOperator(request,{write:true,requestId});actor=await authorize();
  result=match[2]==='assignments'?await aiWorkAccounts.assignment(actor,match[1],input,{authorize}):await aiWorkAccounts.command(actor,match[1],input,{authorize});
 }else if(receipt)result=await aiWorkAccounts.operation(actor,receipt[1]);
 else if(match)result=match[2]==='history'?await aiWorkAccounts.history(actor,match[1],historyQuery(url)):await aiWorkAccounts.detail(actor,match[1]);
 else result=await aiWorkAccounts.list(actor);
 send(200,result);return true;
}
