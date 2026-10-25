import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
const root='/v1/operations/autonomy',domains='(overview|governance|messaging|discovery|maintenance)',uuid='([0-9a-f-]{36})';
const configPath=new RegExp('^'+root+'/accounts/'+domains+'/config$'),runPath=new RegExp('^'+root+'/accounts/'+domains+'/run$'),taskPath=new RegExp('^'+root+'/tasks/'+uuid+'(?:/(control|decisions))?$'),operationPath=new RegExp('^'+root+'/operations/'+uuid+'$');
const invalid=()=>{throw new ServiceError('invalid_operations_autonomy_request',400);};
export async function dispatchOperationsAutonomy({operationsAutonomy:service,agentOsGateway,authorizeOperator,request,response,requestId,url,send}){
 const internal={'/v1/internal/agentos/autonomy/authorize':'authorize','/v1/internal/agentos/autonomy/report':'report','/v1/internal/agentos/autonomy/tools/execute':'tool','/v1/internal/agentos/autonomy/code':'runCodeTask'};
 if(internal[url.pathname]){
  if(request.method!=='POST'||url.search)throw new ServiceError('not_found',404);
  if(!service||!agentOsGateway)throw new ServiceError('operations_autonomy_unavailable',503);
  agentOsGateway.verifyService(request);send(200,await service[internal[url.pathname]](await body(request,undefined,{maxBytes:65536})));return true;
 }
 if(url.pathname!==root&&!url.pathname.startsWith(root+'/'))return false;
 if(!service||typeof authorizeOperator!=='function')throw new ServiceError('operations_autonomy_unavailable',503);
 const config=configPath.exec(url.pathname),run=runPath.exec(url.pathname),task=taskPath.exec(url.pathname),operation=operationPath.exec(url.pathname),write=request.method==='POST';
 if(!['GET','POST'].includes(request.method))throw new ServiceError('not_found',404);
 if(write&&url.search)invalid();
 const action=write?(config||url.pathname===root+'/enable'||url.pathname===root+'/settings'?'autonomy.configure':'autonomy.control'):'autonomy.read',options={write,requestId,action},actor=await authorizeOperator(request,options),authorize=()=>authorizeOperator(request,options);
 response.setHeader('Cache-Control','no-store');let result;
 if(url.pathname===root+'/options'&&!write&&!url.search)result=await service.options(actor);
 else if(url.pathname===root+'/settings'&&!url.search)result=write?await service.saveSettings(actor,await body(request,undefined,{maxBytes:4096}),{authorize}):await service.settings(actor);
 else if(url.pathname===root+'/overview'&&!write){
  const q={};for(const[key,value]of url.searchParams){if(key!=='days'||url.searchParams.getAll(key).length!==1||!/^[1-9][0-9]?$/.test(value))invalid();q.days=Number(value);}result=await service.overview(actor,q);
 }else if(url.pathname===root+'/tasks'&&write)result=await service.createStrategyTask(actor,await body(request,undefined,{maxBytes:4096}),{authorize});
 else if(url.pathname===root+'/tasks'&&!write){
  const q={};for(const[key,value]of url.searchParams){if(!['page','limit','domain','source','state','mode','targetType','targetId'].includes(key)||url.searchParams.getAll(key).length!==1)invalid();q[key]=['page','limit'].includes(key)?Number(value):value;}result=await service.tasks(actor,q);
 }else if(task){
  if(write&&task[2])result=await service[task[2]==='decisions'?'decide':'control'](actor,task[1],await body(request,undefined,{maxBytes:2048}),{authorize});
  else if(!write&&!task[2]&&!url.search)result=await service.getTask(actor,task[1]);else throw new ServiceError('not_found',404);
 }else if(operation&&!write&&!url.search)result=await service.operation(actor,operation[1]);
 else if(config){if(!write&&url.search)invalid();result=write?await service.saveConfig(actor,config[1],await body(request,undefined,{maxBytes:65536}),{authorize}):await service.getConfig(actor,config[1]);}
 else if(run&&write)result=await service.run(actor,run[1],await body(request,undefined,{maxBytes:2048}),{authorize});
 else if(url.pathname===root+'/enable'&&write)result=await service.enable(actor,await body(request,undefined,{maxBytes:4096}),{authorize});
 else throw new ServiceError('not_found',404);
 send(200,result);return true;
}
