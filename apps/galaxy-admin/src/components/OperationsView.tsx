import type {AdminViewServerProps} from 'payload';
import {DefaultTemplate} from '@payloadcms/next/templates';
import {Gutter} from '@payloadcms/ui';
import {headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {isOperator} from '../lib/access';
import {readOperatorSession,operationsRead} from '../lib/operations.mjs';
import {BusinessUsers} from './BusinessUsers';
import type {AuditPage,LinkedId,TypeHistoryItem,UserDetail,UserPage} from './business-types';

export async function OperationsView(props:AdminViewServerProps){
  const {initPageResult,params,user}=props,searchParams=props.searchParams??{},req=initPageResult.req;
  if(!isOperator(req.user))redirect('/admin/login?redirect='+encodeURIComponent('/admin/operations/users'));
  const requestHeaders=await headers(),session=await readOperatorSession(requestHeaders);
  if(session.state!=='signed-in'||session.operator.id!==req.user.externalId)redirect('/admin/login');
  const text=(name:string)=>typeof searchParams[name]==='string'?String(searchParams[name]):'';
  const query=text('query').trim().slice(0,200),after=text('after'),requested=text('account');
  const account=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requested)?requested:null;
  let list:UserPage|null=null,detail:UserDetail|null=null,audit:AuditPage|null=null,error='',auditError='';
  try{
    if(account){
      detail=await operationsRead(requestHeaders,'/v1/operations/users/'+account);
      const path='/v1/operations/users/'+account;
      const jobs:Promise<void>[]=[];
      jobs.push(operationsRead(requestHeaders,path+'/audit?'+new URLSearchParams({limit:'30',...(text('auditAfter')?{after:text('auditAfter')}:{})})).then(value=>{audit=value;}).catch(()=>{auditError='操作记录暂时无法取得。';}));
      if(text('linksAfter'))jobs.push(operationsRead(requestHeaders,path+'/links?'+new URLSearchParams({limit:'20',after:text('linksAfter')})).then((value:{items:LinkedId[];nextAfter:string|null})=>{if(detail)detail.linkedIds=value;}).catch(()=>{error='更多关联记录暂时无法取得，已显示当前记录。';}));
      if(text('historyAfter'))jobs.push(operationsRead(requestHeaders,path+'/type-history?'+new URLSearchParams({limit:'100',after:text('historyAfter')})).then((value:{items:TypeHistoryItem[];nextAfter:number|null})=>{if(detail){detail.typeHistory=value.items;detail.typeHistoryNextAfter=value.nextAfter;}}).catch(()=>{error='更早的类型记录暂时无法取得，已显示当前记录。';}));
      await Promise.all(jobs);
    }else list=await operationsRead(requestHeaders,'/v1/operations/users?'+new URLSearchParams({limit:'20',...(query?{query}:{}),...(after?{after}:{})}));
  }catch{error='用户资料暂时无法取得，请稍后重试。';}
  return <DefaultTemplate i18n={req.i18n} locale={initPageResult.locale} params={params} payload={req.payload} permissions={initPageResult.permissions} searchParams={searchParams} user={user} visibleEntities={initPageResult.visibleEntities}><Gutter><BusinessUsers key={session.operator.id+':'+(account??'directory')} list={list} detail={detail} audit={audit} query={query} error={error} auditError={auditError} csrfToken={session.csrfToken} role={session.operator.role}/></Gutter></DefaultTemplate>;
}
