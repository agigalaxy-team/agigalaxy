import type {AdminViewServerProps} from 'payload';
import {headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {hasOperatorPermission,isOperator} from '../lib/access';
import {operationsRead,readOperatorSession} from '../lib/operations.mjs';
import {SearchRecovery} from './BusinessViewClients';
import {OperationsPage} from './OperationsPage';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';
import {uuidPattern} from './operations-task-types';
import type {SearchFailurePage} from './operations-task-types';

export async function SearchRecoveryView(props:AdminViewServerProps){
  const {initPageResult}=props,req=initPageResult.req,searchParams=props.searchParams??{};
  if(!isOperator(req.user))redirect('/admin/login?redirect='+encodeURIComponent('/admin/operations/search-recovery'));
  const requestHeaders=await headers(),session=await readOperatorSession(requestHeaders);
  if(session.state!=='signed-in'||session.operator.id!==req.user.externalId)redirect('/admin/login');
  if(!hasOperatorPermission(session.operator,'search.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="search.read"/></OperationsPage>;
  const after=typeof searchParams.after==='string'&&uuidPattern.test(searchParams.after)?searchParams.after:'';
  const path='/v1/operations/search/failures?'+new URLSearchParams({limit:'25',...(after?{after}:{})});
  let initial:SearchFailurePage|null=null,error='';
  try{initial=await operationsRead(requestHeaders,path);}catch{error='检索失败记录暂时无法取得。';}
  return <OperationsPage page={props}><SearchRecovery key={session.operator.id} initial={initial} initialError={error} path={path} after={after} csrfToken={session.csrfToken} canManage={hasOperatorPermission(session.operator,'search.retry')}/></OperationsPage>;
}
