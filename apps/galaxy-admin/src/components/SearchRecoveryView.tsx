import type {AdminViewServerProps} from 'payload';
import {DefaultTemplate} from '@payloadcms/next/templates';
import {Gutter} from '@payloadcms/ui';
import {headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {isOperator} from '../lib/access';
import {operationsRead,readOperatorSession} from '../lib/operations.mjs';
import {SearchRecovery} from './SearchRecovery';
import {uuidPattern} from './operations-task-types';
import type {SearchFailurePage} from './operations-task-types';

export async function SearchRecoveryView(props:AdminViewServerProps){
  const {initPageResult,params,user}=props,req=initPageResult.req,searchParams=props.searchParams??{};
  if(!isOperator(req.user))redirect('/admin/login?redirect='+encodeURIComponent('/admin/operations/search-recovery'));
  const requestHeaders=await headers(),session=await readOperatorSession(requestHeaders);
  if(session.state!=='signed-in'||session.operator.id!==req.user.externalId)redirect('/admin/login');
  const after=typeof searchParams.after==='string'&&uuidPattern.test(searchParams.after)?searchParams.after:'';
  const path='/v1/operations/search/failures?'+new URLSearchParams({limit:'25',...(after?{after}:{})});
  let initial:SearchFailurePage|null=null,error='';
  try{initial=await operationsRead(requestHeaders,path);}catch{error='检索失败记录暂时无法取得。';}
  return <DefaultTemplate i18n={req.i18n} locale={initPageResult.locale} params={params} payload={req.payload} permissions={initPageResult.permissions} searchParams={searchParams} user={user} visibleEntities={initPageResult.visibleEntities}><Gutter><SearchRecovery key={session.operator.id+':'+path} initial={initial} initialError={error} path={path} after={after} csrfToken={session.csrfToken} canManage={session.operator.role==='administrator'}/></Gutter></DefaultTemplate>;
}
