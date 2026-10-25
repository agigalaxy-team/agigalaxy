import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const planPath=new RegExp('^/v1/operations/messaging/plans/('+uuid+')(?:/(save|activate|pause|resume|stop|withdraw|history))?$','i');
const runPath=new RegExp('^/v1/operations/messaging/runs/('+uuid+')(?:/(recipients|retry))?$','i');
const operationPath=new RegExp('^/v1/operations/messaging/operations/('+uuid+')$','i');
const announcementPath=new RegExp('^/v1/announcements/('+uuid+')$','i');
const queries={plans:['after','limit','state'],runs:['after','limit','planId'],recipients:['after','limit','channel','state'],announcements:['after','limit'],history:['after','limit']};
function query(url,kind){
 if(url.search.length>8192)throw new ServiceError('invalid_operations_messaging_request',400);
 const result={};for(const[key,value]of url.searchParams){if(!queries[kind]?.includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_operations_messaging_request',400);result[key]=key==='limit'?Number(value):value;}return result;
}
export async function dispatchOperationsMessaging({operationsMessaging,authorizeOperator,request,requestId,url,send}){
 const publicList=url.pathname==='/v1/announcements',publicDetail=announcementPath.exec(url.pathname),managed=url.pathname.startsWith('/v1/operations/messaging/');
 if(!publicList&&!publicDetail&&!managed)return false;
 if(!operationsMessaging)throw new ServiceError('operations_messaging_unavailable',503);
 if(publicList||publicDetail){
  if(request.method!=='GET'||publicDetail&&url.search)throw new ServiceError('not_found',404);
  send(200,publicList?await operationsMessaging.announcements(query(url,'announcements')):await operationsMessaging.announcement(publicDetail[1]));return true;
 }
 if(typeof authorizeOperator!=='function')throw new ServiceError('operations_authorization_unavailable',503);
 const operation=operationPath.exec(url.pathname);
 if(operation){
  if(request.method!=='GET'||url.search)throw new ServiceError('not_found',404);
  const actor=await authorizeOperator(request,{write:false,requestId,action:'notices.read'});
  send(200,await operationsMessaging.commandResult(actor,operation[1]));return true;
 }
 const plan=planPath.exec(url.pathname),run=runPath.exec(url.pathname),plans=url.pathname==='/v1/operations/messaging/plans',runs=url.pathname==='/v1/operations/messaging/runs';
 const write=request.method==='POST';
 if(!['GET','POST'].includes(request.method)||!plans&&!runs&&!plan&&!run)throw new ServiceError('not_found',404);
 if(write){
  if(url.search||runs||plan&&(!plan[2]||plan[2]==='history')||run&&run[2]!=='retry')throw new ServiceError('not_found',404);
  const kind=plan?.[2]??(plans?'create':'retry'),action=kind==='create'?'notices.create':kind==='save'?'notices.update':['activate','resume','retry'].includes(kind)?'notices.publish':'notices.withdraw';
  const actor=await authorizeOperator(request,{write:true,requestId,action}),input=await body(request,undefined,{maxBytes:65536});
  const options={authorize:()=>authorizeOperator(request,{write:true,requestId})};
  const result=plans?await operationsMessaging.create(actor,input,options):run?await operationsMessaging.retry(actor,run[1],input,options):kind==='save'?await operationsMessaging.save(actor,plan[1],input,options):await operationsMessaging.action(actor,plan[1],kind,input,options);
  send(200,result);return true;
 }
 if(plan?.[2]&&plan[2]!=='history'||run?.[2]==='retry'||!plans&&!runs&&plan?.[2]!=='history'&&run?.[2]!=='recipients'&&url.search)throw new ServiceError('not_found',404);
 const actor=await authorizeOperator(request,{requestId,action:'notices.read'});
 const result=plans?await operationsMessaging.list(actor,query(url,'plans')):runs?await operationsMessaging.runs(actor,query(url,'runs')):plan?plan[2]==='history'?await operationsMessaging.history(actor,plan[1],query(url,'history')):await operationsMessaging.get(actor,plan[1]):run[2]==='recipients'?await operationsMessaging.recipients(actor,run[1],query(url,'recipients')):await operationsMessaging.run(actor,run[1]);
 send(200,result);return true;
}
