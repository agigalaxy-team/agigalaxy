import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {streamConversationResponse} from './operations-agentos-conversation-sse.mjs';

const root='/v1/operations/agentos';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const executionPath=new RegExp('^'+root+'/executions/('+uuid+')(?:/(events|runs|review|continue))?$','i');
const runPath=new RegExp('^'+root+'/runs/([A-Za-z0-9_-]{1,128})$');
const operationPath=new RegExp('^'+root+'/operations/('+uuid+')$','i');
const domains=new Set(['overview','governance','messaging','discovery','maintenance']);
const conversationPath=new RegExp('^'+root+'/conversations/(overview|governance|messaging|discovery|maintenance)(?:/(runs|operations/('+uuid+')))?$','i');
const cardPath=new RegExp('^'+root+'/conversations/(overview|governance|messaging|discovery|maintenance)/cards/('+uuid+')(?:/(confirm|dismiss))?$','i');
const conversationTransportPath=new RegExp('^'+root+'/conversations/(overview|governance|messaging|discovery|maintenance)/operations/('+uuid+')/(events|cancel)$','i');
const states=new Set(['PENDING','RUNNING','COMPLETED','PAUSED','CANCELLED','ERROR','REGENERATED']);
const invalid=()=>{throw new ServiceError('invalid_operations_agentos_request',400);};

function runQuery(url){
 if(url.search.length>2048)invalid();
 const query={};
 for(const[key,value]of url.searchParams){
  if(!['page','limit','domain','state'].includes(key)||url.searchParams.getAll(key).length!==1)invalid();
  if(key==='page'||key==='limit'){
   if(!/^[1-9][0-9]{0,5}$/.test(value))invalid();
   query[key]=Number(value);
   if(key==='limit'&&query[key]>100)invalid();
  }else{
   if(!(key==='domain'?domains:states).has(value))invalid();query[key]=value;
  }
 }
 return query;
}

export async function dispatchOperationsAgentOs({operationsAgentOs,agentOsGateway,authorizeOperator,request,response,requestId,url,send}){
 const internal=new Map([['/v1/internal/agentos/authorize','authorize'],['/v1/internal/agentos/tools/execute','execute']]);
 if(internal.has(url.pathname)){
  if(request.method!=='POST'||url.search)throw new ServiceError('not_found',404);
  if(!agentOsGateway)throw new ServiceError('operations_agentos_not_configured',503);
  agentOsGateway.verifyService(request);
  send(200,await agentOsGateway[internal.get(url.pathname)](await body(request,undefined,{maxBytes:32768})));
  return true;
 }
 if(url.pathname!==root&&!url.pathname.startsWith(root+'/'))return false;
 const transport=conversationTransportPath.exec(url.pathname);
 if(transport){
  const cancelling=transport[3]==='cancel'&&request.method==='POST',observing=transport[3]==='events'&&request.method==='GET';
  if(!cancelling&&!observing)throw new ServiceError('not_found',404);
  let after=-1;
  if(cancelling&&url.search)invalid();
  if(observing){
   if(url.search.length>80)invalid();
   for(const[key,value]of url.searchParams){if(key!=='after'||url.searchParams.getAll(key).length!==1||!/^(?:0|[1-9][0-9]{0,9})$/.test(value))invalid();after=Number(value);}
  }
  if(!operationsAgentOs||typeof authorizeOperator!=='function')throw new ServiceError('operations_authorization_unavailable',503);
  const options={write:false,csrf:cancelling,requestId,action:'workbench.read'},actor=await authorizeOperator(request,options),authorize=()=>authorizeOperator(request,options);
  if(cancelling)send(200,await operationsAgentOs.conversationCancel(actor,transport[1],transport[2],await body(request,undefined,{maxBytes:2048}),{authorize}));
  else await streamConversationResponse({request,response,operationId:transport[2],events:signal=>operationsAgentOs.conversationEvents(actor,transport[1],transport[2],{after,authorize,signal})});
  return true;
 }
 const card=cardPath.exec(url.pathname);
 if(card){
  const changing=['confirm','dismiss'].includes(card[3])&&request.method==='POST';
  if(url.search||!changing&&(card[3]||request.method!=='GET'))throw new ServiceError('not_found',404);
  if(!operationsAgentOs||typeof authorizeOperator!=='function')throw new ServiceError('operations_authorization_unavailable',503);
  const options={write:false,csrf:changing,requestId,action:'workbench.read'},actor=await authorizeOperator(request,options);
  const method=card[3]==='dismiss'?'conversationDismiss':'conversationConfirm';
  send(200,changing?await operationsAgentOs[method](actor,card[1],card[2],await body(request,undefined,{maxBytes:2048}),{authorize:()=>authorizeOperator(request,options)}):await operationsAgentOs.conversationCard(actor,card[1],card[2]));return true;
 }
 const conversation=conversationPath.exec(url.pathname);
 if(conversation){
  const sending=conversation[2]==='runs'&&request.method==='POST',reading=!conversation[2]&&request.method==='GET'||conversation[3]&&request.method==='GET';
  if(!sending&&!reading||url.search)throw new ServiceError('not_found',404);
  if(!operationsAgentOs||typeof authorizeOperator!=='function')throw new ServiceError('operations_authorization_unavailable',503);
  const options={write:false,csrf:sending,requestId,action:'workbench.read'},actor=await authorizeOperator(request,options);
  const result=sending?await operationsAgentOs.conversationRun(actor,conversation[1],await body(request,undefined,{maxBytes:65536}),{authorize:()=>authorizeOperator(request,options)})
   :conversation[3]?await operationsAgentOs.conversationOperation(actor,conversation[1],conversation[3]):await operationsAgentOs.conversation(actor,conversation[1]);
  send(200,result);return true;
 }
 const part=url.pathname.slice(root.length+1),execution=executionPath.exec(url.pathname),run=runPath.exec(url.pathname),operation=operationPath.exec(url.pathname),write=request.method==='POST';
 const reading=request.method==='GET'&&(['status','options','executions','runs'].includes(part)||execution&&!execution[2]||run||operation);
 const writing=write&&(part==='executions'||execution?.[2]);
 if(!reading&&!writing||url.search&&(part!=='runs'||request.method!=='GET'))throw new ServiceError('not_found',404);
 if(!operationsAgentOs||typeof authorizeOperator!=='function')throw new ServiceError('operations_authorization_unavailable',503);
 const actor=await authorizeOperator(request,{write,requestId,action:part==='runs'||run?'audit.read':'workbench.read'});
 let result;
 if(write){
  const input=await body(request,undefined,{maxBytes:['runs','review'].includes(execution?.[2])?65536:32768});
  const options={authorize:()=>authorizeOperator(request,{write:true,requestId})};
  if(part==='executions')result=await operationsAgentOs.authority.create(actor,input,options);
  else if(execution[2]==='events')result=await operationsAgentOs.authority.change(actor,execution[1],input,options);
  else result=await operationsAgentOs[{runs:'run',review:'review',continue:'continue'}[execution[2]]](actor,execution[1],input,options);
 }else if(operation)result=await operationsAgentOs.operation(actor,operation[1]);
 else if(part==='runs')result=await operationsAgentOs.runs(actor,runQuery(url));
 else if(run)result=await operationsAgentOs.runDetail(actor,run[1]);
 else if(execution)result=await operationsAgentOs.get(actor,execution[1]);
 else if(part==='status')result=await operationsAgentOs.status(actor);
 else result=await operationsAgentOs.authority[part==='options'?'options':'list'](actor);
 send(200,result);return true;
}
