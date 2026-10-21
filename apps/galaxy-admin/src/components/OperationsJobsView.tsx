import type {AdminViewServerProps} from 'payload';
import {DefaultTemplate} from '@payloadcms/next/templates';
import {Gutter} from '@payloadcms/ui';
import {headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {isOperator} from '../lib/access';
import {operationsRead,readOperatorSession} from '../lib/operations.mjs';
import {OperationsJobs} from './OperationsJobs';
import {operationQueues,uuidPattern} from './operations-task-types';
import type {OperationJobPage,OperationQueue} from './operations-task-types';

export async function OperationsJobsView(props:AdminViewServerProps){
  const {initPageResult,params,user}=props,req=initPageResult.req,searchParams=props.searchParams??{};
  if(!isOperator(req.user))redirect('/admin/login?redirect='+encodeURIComponent('/admin/operations/jobs'));
  const requestHeaders=await headers(),session=await readOperatorSession(requestHeaders);
  if(session.state!=='signed-in'||session.operator.id!==req.user.externalId)redirect('/admin/login');
  const requested=typeof searchParams.queue==='string'?searchParams.queue:'';
  const queue:OperationQueue=operationQueues.includes(requested as OperationQueue)?requested as OperationQueue:operationQueues[0];
  const after=typeof searchParams.after==='string'&&uuidPattern.test(searchParams.after)?searchParams.after:'';
  const path='/v1/operations/jobs?'+new URLSearchParams({queue,limit:'25',...(after?{after}:{})});
  let initial:OperationJobPage|null=null,error='';
  try{initial=await operationsRead(requestHeaders,path);}catch{error='任务记录暂时无法取得。';}
  return <DefaultTemplate i18n={req.i18n} locale={initPageResult.locale} params={params} payload={req.payload} permissions={initPageResult.permissions} searchParams={searchParams} user={user} visibleEntities={initPageResult.visibleEntities}><Gutter><OperationsJobs key={session.operator.id+':'+path} initial={initial} initialError={error} path={path} queue={queue} after={after} csrfToken={session.csrfToken} canManage={session.operator.role==='administrator'}/></Gutter></DefaultTemplate>;
}
