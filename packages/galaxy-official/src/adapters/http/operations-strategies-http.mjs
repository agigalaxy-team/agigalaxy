import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {p13PageSchema,p13Parse} from '../../shared/p13-strategies-schema.mjs';

function query(url,keys){const q={};for(const [key,value]of url.searchParams){if(!keys.includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_p13_strategy_request',400);q[key]=key==='limit'?Number(value):value;}return p13Parse(p13PageSchema,q);}
export async function dispatchP13Strategies({strategies,agentOsGateway,authorizeOperator,request,response,requestId,url,send}){
 const internals=new Map([['/v1/internal/agentos/p13/context','nativeContext'],['/v1/internal/agentos/p13/step','step']]);
 if(internals.has(url.pathname)){
  if(request.method!=='POST'||url.search)throw new ServiceError('not_found',404);if(!strategies||!agentOsGateway)throw new ServiceError('p13_not_configured',503);
  agentOsGateway.verifyService(request);const result=await strategies[internals.get(url.pathname)](await body(request,undefined,{maxBytes:4096}));send(200,result);return true;
 }
 const root='/v1/operations/strategies';if(url.pathname!==root&&!url.pathname.startsWith(root+'/'))return false;
 const path=url.pathname.slice(root.length+1),item=/^(runs|operations)\/([0-9a-f-]{36})(?:\/(continue))?$/i.exec(path),read=request.method==='GET',write=request.method==='POST';
 const action=write?path==='draft'?'strategies.configure':path==='publish'?'strategies.publish':path==='control'?'strategies.control':path==='rehearsal'?'strategies.read':'strategies.run':'strategies.read';
 if(!strategies||typeof authorizeOperator!=='function')throw new ServiceError('p13_not_configured',503);
 if(!(read&&['overview','options','versions','records'].includes(path)||read&&item&&!item[3]||write&&['draft','publish','control','rehearsal','runs'].includes(path)||write&&item?.[1]==='runs'&&item[3]==='continue'))throw new ServiceError('not_found',404);
 const actor=await authorizeOperator(request,{write,requestId,action});response?.setHeader('Cache-Control','no-store');response?.setHeader('Referrer-Policy','no-referrer');
 let result;
 if(read){
  if(path==='records')result=await strategies.records(actor,query(url,['after','limit','strategyId']));
  else if(path==='versions')result=await strategies.versions(actor,query(url,['after','limit']));
  else{if(url.search)throw new ServiceError('invalid_p13_strategy_request',400);result=path==='overview'?await strategies.get(actor):path==='options'?await strategies.options(actor):item[1]==='runs'?await strategies.runDetail(actor,item[2]):await strategies.operation(actor,item[2]);}
 }else{
  if(url.search)throw new ServiceError('invalid_p13_strategy_request',400);const input=await body(request,undefined,{maxBytes:path==='draft'?262144:32768}),options={authorize:()=>authorizeOperator(request,{write:true,requestId})};
  if(item)result=await strategies.continue(actor,item[2],input,options);
  else result=await strategies[{draft:'saveDraft',publish:'publish',control:'control',rehearsal:'rehearsal',runs:'run'}[path]](actor,input,options);
 }
 send(200,result);return true;
}
