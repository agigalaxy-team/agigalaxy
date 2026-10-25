import type {AdminViewServerProps} from 'payload';
import {headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {hasOperatorPermission,isOperator} from '../lib/access';
import {operationsRead,readOperatorSession} from '../lib/operations.mjs';
import {OperationsJobs} from './BusinessViewClients';
import {OperationsPage} from './OperationsPage';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';
import {operationQueues,uuidPattern} from './operations-task-types';
import type {OperationJobPage,OperationQueue} from './operations-task-types';

export async function OperationsJobsView(props:AdminViewServerProps){
  const {initPageResult}=props,req=initPageResult.req,searchParams=props.searchParams??{};
  if(!isOperator(req.user))redirect('/admin/login?redirect='+encodeURIComponent('/admin/operations/jobs'));
  const requestHeaders=await headers(),session=await readOperatorSession(requestHeaders);
  if(session.state!=='signed-in'||session.operator.id!==req.user.externalId)redirect('/admin/login');
  if(!hasOperatorPermission(session.operator,'jobs.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="jobs.read"/></OperationsPage>;
  const requested=typeof searchParams.queue==='string'?searchParams.queue:'';
  const queue:OperationQueue=operationQueues.includes(requested as OperationQueue)?requested as OperationQueue:operationQueues[0];
  const after=typeof searchParams.after==='string'&&uuidPattern.test(searchParams.after)?searchParams.after:'';
  const path='/v1/operations/jobs?'+new URLSearchParams({queue,limit:'25',...(after?{after}:{})});
  let initial:OperationJobPage|null=null,error='';
  try{initial=await operationsRead(requestHeaders,path);}catch{error='任务记录暂时无法取得。';}
  return <OperationsPage page={props}><OperationsJobs key={session.operator.id} initial={initial} initialError={error} path={path} queue={queue} after={after} csrfToken={session.csrfToken} canCancel={hasOperatorPermission(session.operator,'jobs.cancel')} canRetry={hasOperatorPermission(session.operator,'jobs.retry')}/></OperationsPage>;
}
