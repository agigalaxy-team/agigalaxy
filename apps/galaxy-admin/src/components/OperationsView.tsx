import {operatorLoginPage} from '../lib/operator-login-target.mjs';
import type {AdminViewServerProps} from 'payload';
import {headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {hasOperatorPermission,isOperator,operatorBusinessAuthorization} from '../lib/access';
import {readOperatorSession,operationsRead} from '../lib/operations.mjs';
import {BusinessUsers} from './BusinessViewClients';
import {OperationsPage} from './OperationsPage';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';
import {RegisteredUsers} from './BusinessViewClients';
import {registeredUsersLocation,registeredUsersQuery} from "../lib/accounts/registered-users-view-model";
import type {RegisteredUserDetail,RegisteredUsersPage} from "./accounts/registered-users-types";
import type {AuditPage,LinkedId,TypeHistoryItem,UserDetail,UserPage} from './business-types';

export async function OperationsView(props:AdminViewServerProps){
  const {initPageResult}=props,searchParams=props.searchParams??{},req=initPageResult.req;
  if(!isOperator(req.user))redirect(operatorLoginPage('/admin/operations/users',searchParams));
  const requestHeaders=await headers(),session=await readOperatorSession(requestHeaders);
  if(session.state!=='signed-in'||session.operator.id!==req.user.externalId)redirect(operatorLoginPage('/admin/operations/users',searchParams));
  const text=(name:string)=>typeof searchParams[name]==='string'?String(searchParams[name]):'';
  const query=text('query').trim().slice(0,200),after=text('after'),requested=text('account');
  const subjectType=['person','organization','agent','unknown'].includes(text('subjectType'))?text('subjectType'):'';
  const restriction=['normal','restricted'].includes(text('restriction'))?text('restriction'):'';
  const account=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requested)?requested:null;
  if(!account){
    if(!hasOperatorPermission(session.operator,'accounts.registered.read'))return <OperationsPage page={props} variant="accounts"><OperationsPermissionNotice permission="accounts.registered.read"/></OperationsPage>;
    const initialLocation=registeredUsersLocation(Object.fromEntries(Object.entries(searchParams).filter((entry):entry is [string,string]=>typeof entry[1]==='string')));
    let initialPage:RegisteredUsersPage|null=null,initialDetail:RegisteredUserDetail|null=null,listError='',detailError='';
    await Promise.all([
      operationsRead(requestHeaders,'/v1/operations/registered-users?'+registeredUsersQuery(initialLocation)).then((value:RegisteredUsersPage)=>{initialPage=value;}).catch(()=>{listError='用户目录暂时无法读取。';}),
      initialLocation.registration?operationsRead(requestHeaders,'/v1/operations/registered-users/'+initialLocation.registration).then((value:RegisteredUserDetail)=>{initialDetail=value;}).catch(()=>{detailError='当前账户暂时无法读取。';}):Promise.resolve(),
    ]);
    return <OperationsPage page={props} variant="accounts"><RegisteredUsers key={session.operator.id} operatorId={session.operator.id} csrfToken={session.csrfToken} businessAuthorization={operatorBusinessAuthorization(session.operator)??null} initialLocation={initialLocation} initialPage={initialPage} initialDetail={initialDetail} initialError={listError} initialDetailError={detailError}/></OperationsPage>;
  }
  if(!hasOperatorPermission(session.operator,'accounts.read'))return <OperationsPage page={props} variant="accounts"><OperationsPermissionNotice permission="accounts.read"/></OperationsPage>;
  let list:UserPage|null=null,detail:UserDetail|null=null,audit:AuditPage|null=null,error='',auditError='';
  try{
    if(account){
      detail=await operationsRead(requestHeaders,'/v1/operations/users/'+account);
      const path='/v1/operations/users/'+account;
      const jobs:Promise<void>[]=[];
      if(hasOperatorPermission(session.operator,'audit.read'))jobs.push(operationsRead(requestHeaders,path+'/audit?'+new URLSearchParams({limit:'30',...(text('auditAfter')?{after:text('auditAfter')}:{})})).then(value=>{audit=value;}).catch(()=>{auditError='操作记录暂时无法取得。';}));
      else auditError='当前没有读取业务审计的权限。';
      if(text('linksAfter'))jobs.push(operationsRead(requestHeaders,path+'/links?'+new URLSearchParams({limit:'20',after:text('linksAfter')})).then((value:{items:LinkedId[];nextAfter:string|null})=>{if(detail)detail.linkedIds=value;}).catch(()=>{error='更多关联记录暂时无法取得，已显示当前记录。';}));
      if(text('historyAfter'))jobs.push(operationsRead(requestHeaders,path+'/type-history?'+new URLSearchParams({limit:'100',after:text('historyAfter')})).then((value:{items:TypeHistoryItem[];nextAfter:number|null})=>{if(detail){detail.typeHistory=value.items;detail.typeHistoryNextAfter=value.nextAfter;}}).catch(()=>{error='更早的类型记录暂时无法取得，已显示当前记录。';}));
      await Promise.all(jobs);
    }else list=await operationsRead(requestHeaders,'/v1/operations/users?'+new URLSearchParams({limit:'20',...(query?{query}:{}),...(subjectType?{subjectType}:{}),...(restriction?{restriction}:{}),...(after?{after}:{})}));
  }catch{error='用户资料暂时无法取得，请稍后重试。';}
  return <OperationsPage page={props} variant="accounts"><BusinessUsers key={session.operator.id} list={list} detail={detail} audit={audit} query={query} error={error} auditError={auditError} csrfToken={session.csrfToken} businessAuthorization={operatorBusinessAuthorization(session.operator)}/></OperationsPage>;
}
