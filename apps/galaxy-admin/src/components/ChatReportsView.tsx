import type {AdminViewServerProps} from 'payload';
import {DefaultTemplate} from '@payloadcms/next/templates';
import {Gutter} from '@payloadcms/ui';
import {headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {isOperator} from '../lib/access';
import {operationsRead,readOperatorSession} from '../lib/operations.mjs';
import {ChatReports} from './ChatReports';
import type {ReportResource} from './chat-report-types';
export async function ChatReportsView(props:AdminViewServerProps){
  const {initPageResult,params,user}=props,req=initPageResult.req,searchParams=props.searchParams??{};
  if(!isOperator(req.user))redirect('/admin/login?redirect='+encodeURIComponent('/admin/operations/chat-reports'));
  const requestHeaders=await headers(),session=await readOperatorSession(requestHeaders);
  if(session.state!=='signed-in'||session.operator.id!==req.user.externalId)redirect('/admin/login');
  const selected=typeof searchParams.report==='string'?searchParams.report:'',report=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(selected)?selected:null;
  const state=typeof searchParams.state==='string'&&['received','reviewing','resolved','appealed','withdrawn'].includes(searchParams.state)?searchParams.state:'';
  const path='/v1/operations/chat-reports'+(report?'/'+report:'?'+new URLSearchParams({limit:'20',...(state?{state}:{}),...(typeof searchParams.after==='string'?{after:searchParams.after}:{})}));
  let resource:ReportResource|null=null,error='';
  try{resource=await operationsRead(requestHeaders,path);}catch{error='举报记录暂时无法取得。';}
  return <DefaultTemplate i18n={req.i18n} locale={initPageResult.locale} params={params} payload={req.payload} permissions={initPageResult.permissions} searchParams={searchParams} user={user} visibleEntities={initPageResult.visibleEntities}><Gutter><ChatReports key={session.operator.id+':'+path} initial={resource} initialError={error} path={path} reportId={report} filter={state} csrfToken={session.csrfToken}/></Gutter></DefaultTemplate>;
}
